import { drift, fs, log, shareContext, task } from "@titanpl/native";

/**
 * CacheX - A High-Performance Redis-like In-Memory Data Engine for TitanPL
 * 
 * Powered by shareContext for shared storage and task for background orchestration.
 * Implements LRU/LFU eviction, TTL, atomic operations, and a queue system.
 */
export class CacheX {
  constructor(config = {}) {
    this.config = {
      maxKeys: config.maxKeys || 10000,
      policy: config.policy || "lru", // "lru" or "lfu"
      namespace: config.namespace || "",
      maxObjectSize: config.maxObjectSize || 1024 * 1024, // 1MB default
      persist: config.persist ?? true,
      ...config
    };

    // Internals
    this._root = "__cachex__:";
    this._storePrefix = `${this._root}store:`;
    this._lockPrefix = `${this._root}lock:`;
    this._queuePrefix = `${this._root}queues:`;
    this._lruKey = `${this._root}${this.config.namespace}:lru`;
    this._lfuKey = `${this._root}${this.config.namespace}:lfu_buckets`;
    this._ns = this.config.namespace ? `${this.config.namespace}:` : "";

    this._persisted = false;
  }

  _ensurePersistence() {
    if (this.config.persist && !this._persisted) {
      this._persisted = true;
      try {
        if (!drift(fs.exists("../.titan"))) drift(fs.mkdir("../.titan"));
        if (!drift(fs.exists("../.titan/.cache"))) drift(fs.mkdir("../.titan/.cache"));
        this.loadStorage();
      } catch (e) {
        if (e === "__SUSPEND__" || e.message === "__SUSPEND__") throw e;
        if (typeof log !== "undefined") log(`CacheX: Init Error - ${e.message}`);
      }
    }
  }

  _toHex(str) {
    let result = '';
    for (let i = 0; i < str.length; i++) {
      result += str.charCodeAt(i).toString(16).padStart(2, '0');
    }
    return result;
  }

  _fromHex(hex) {
    let result = '';
    for (let i = 0; i < hex.length; i += 2) {
      result += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
    }
    return result;
  }


  // --- Internal Locking ---

  _lock(key, fn) {
    const lockKey = `${this._lockPrefix}${key}`;
    const start = Date.now();
    
    while (shareContext.get(lockKey)) {
      if (Date.now() - start > 1000) {
        throw new Error(`CacheX: Lock timeout for ${key}`);
      }
      drift(new Promise(r => setTimeout(r, 5)));
    }
    
    shareContext.set(lockKey, true);
    try {
      return fn();
    } finally {
      shareContext.delete(lockKey);
    }
  }

  // --- Internal Unlocked Methods ---

  _getInternal(fullKey) {
    const storeKey = `${this._storePrefix}${fullKey}`;
    let entry = shareContext.get(storeKey);

    // Lazy load from disk if missing from memory
    if (!entry && this.config.persist) {
      const filename = this._toHex(fullKey);
      const filePath = `../.titan/.cache/${filename}.json`;
      if (fs.exists(filePath)) {
        try {
          const content = fs.readFile(filePath);
          entry = JSON.parse(content);
          shareContext.set(storeKey, entry);
          this._updateEviction(fullKey);
        } catch (e) {
          if (e === "__SUSPEND__" || e.message === "__SUSPEND__") throw e;
        }
      }
    }

    if (!entry) return null;

    const now = Date.now();
    if (entry.expiresAt !== null && entry.expiresAt < now) {
      if (typeof log !== "undefined" && fullKey === "persist_test") log(`CacheX: Deleting persist_test because expiresAt (${entry.expiresAt}) < now (${now})`);
      this._deleteInternal(fullKey);
      return null;
    }

    entry.hits++;
    
    if (entry.task && typeof task !== "undefined") {
      const delay = entry.delay || 60000;
      if ((now - entry.updatedAt) >= delay) {
        // Append `now` to taskId to prevent task deduplication/ignoring by the queue
        const taskId = `${this._root}refresh:${fullKey}:${now}`;
        const payload = {
          key: fullKey.replace(this._ns, ""),
          ns: this.config.namespace || "default",
          value: entry.value,
          createdAt: entry.createdAt,
          updatedAt: now,
          expiresAt: entry.expiresAt,
          hits: entry.hits,
          ...(entry.payload || {})
        };
        // Spawn task to refresh in background, only when the delay is fulfilled
        task.spawn(taskId, entry.task, payload, { timeout: entry.timeout || 30000 });
        entry.updatedAt = now;
      }
    }

    shareContext.set(storeKey, entry);
    this._updateEviction(fullKey);

    return entry;
  }

  _setInternal(fullKey, value, options = {}) {
    const storeKey = `${this._storePrefix}${fullKey}`;
    const existing = shareContext.get(storeKey);
    
    if (options.nx && existing) return false;
    if (options.xx && !existing) return false;

    if (value && JSON.stringify(value).length > this.config.maxObjectSize) {
      throw new Error(`CacheX: Object size exceeds limit`);
    }

    const now = Date.now();
    const entry = {
      value,
      createdAt: existing ? existing.createdAt : now,
      updatedAt: now,
      expiresAt: options.ttl ? now + options.ttl : (existing ? existing.expiresAt : null),
      hits: existing ? existing.hits : 0,
      task: options.task || options.refreshAction || (existing ? existing.task : null),
      delay: options.delay ?? options.refreshDelay ?? (existing ? existing.delay : (options.ttl || 60000)),
      payload: options.payload || options.refreshPayload || (existing ? existing.payload : null),
      timeout: options.timeout || (existing ? existing.timeout : 30000)
    };

    shareContext.set(storeKey, entry);
    this._updateEviction(fullKey);

    return true;
  }

  _writeDisk(fullKey, entry) {
    const filename = this._toHex(fullKey);
    fs.writeFile(`../.titan/.cache/${filename}.json`, JSON.stringify(entry)).catch(() => {});
  }

  _removeDisk(fullKey) {
    const filename = this._toHex(fullKey);
    const path = `../.titan/.cache/${filename}.json`;
    fs.remove(path).catch(() => {});
  }

  _deleteInternal(fullKey) {
    const storeKey = `${this._storePrefix}${fullKey}`;
    shareContext.delete(storeKey);
    this._removeFromEviction(fullKey);
    return true;
  }

  // --- Eviction Logic ---

  _updateEviction(key) {
    if (this.config.policy === "lru") {
      this._updateLRU(key);
    } else if (this.config.policy === "lfu") {
      this._updateLFU(key);
    }
  }

  _updateLRU(key) {
    let lru = shareContext.get(this._lruKey) || [];
    lru = lru.filter(k => k !== key);
    lru.push(key);
    
    while (lru.length > this.config.maxKeys) {
      const victim = lru.shift();
      shareContext.delete(`${this._storePrefix}${victim}`);
    }
    
    shareContext.set(this._lruKey, lru);
  }

  _updateLFU(key) {
    const storeKey = `${this._storePrefix}${key}`;
    const entry = shareContext.get(storeKey);
    if (!entry) return;

    const oldHits = entry.hits - 1;
    const newHits = entry.hits;

    let buckets = shareContext.get(this._lfuKey) || {};
    if (oldHits >= 0 && buckets[oldHits]) {
      buckets[oldHits] = buckets[oldHits].filter(k => k !== key);
    }
    if (!buckets[newHits]) buckets[newHits] = [];
    buckets[newHits].push(key);

    let totalKeys = 0;
    Object.values(buckets).forEach(b => totalKeys += b.length);

    if (totalKeys > this.config.maxKeys) {
      const freqs = Object.keys(buckets).map(Number).sort((a, b) => a - b);
      for (const freq of freqs) {
        if (buckets[freq] && buckets[freq].length > 0) {
          const victim = buckets[freq].shift();
          shareContext.delete(`${this._storePrefix}${victim}`);
          break;
        }
      }
    }

    shareContext.set(this._lfuKey, buckets);
  }

  _removeFromEviction(key) {
    if (this.config.policy === "lru") {
      let lru = shareContext.get(this._lruKey) || [];
      lru = lru.filter(k => k !== key);
      shareContext.set(this._lruKey, lru);
    } else if (this.config.policy === "lfu") {
      let buckets = shareContext.get(this._lfuKey) || {};
      for (const freq in buckets) {
        buckets[freq] = buckets[freq].filter(k => k !== key);
      }
      shareContext.set(this._lfuKey, buckets);
    }
  }

  // --- Public API ---

  set(key, value, options = {}) {
    this._ensurePersistence();
    const fullKey = this._fullKey(key);
    return this._lock(fullKey, () => this._setInternal(fullKey, value, options));
  }

  get(key) {
    this._ensurePersistence();
    const fullKey = this._fullKey(key);
    const entry = this._getInternal(fullKey);
    return entry ? entry.value : null;
  }

  delete(key) {
    this._ensurePersistence();
    const fullKey = this._fullKey(key);
    return this._lock(fullKey, () => this._deleteInternal(fullKey));
  }

  exists(key) {
    this._ensurePersistence();
    const fullKey = this._fullKey(key);
    return !!this._getInternal(fullKey);
  }

  keys(pattern = null) {
    this._ensurePersistence();
    const allKeys = shareContext.keys()
      .filter(k => k.startsWith(this._storePrefix))
      .map(k => k.replace(this._storePrefix, ""));
    
    const nsPrefix = this._ns;
    const filtered = allKeys.filter(k => k.startsWith(nsPrefix));
    
    if (!pattern) return filtered.map(k => k.replace(nsPrefix, ""));
    
    const regex = new RegExp("^" + pattern.split("*").join(".*") + "$");
    return filtered.map(k => k.replace(nsPrefix, "")).filter(k => regex.test(k));
  }

  clear() {
    this._ensurePersistence();
    this.keys().forEach(k => this.delete(k));
  }

  incr(key, by = 1) {
    this._ensurePersistence();
    const fullKey = this._fullKey(key);
    return this._lock(fullKey, () => {
      const entry = this._getInternal(fullKey);
      const val = entry ? entry.value : 0;
      const newVal = val + by;
      this._setInternal(fullKey, newVal);
      return newVal;
    });
  }

  decr(key, by = 1) { return this.incr(key, -by); }

  stats() {
    const allStoreKeys = shareContext.keys().filter(k => k.startsWith(this._storePrefix));
    let hits = 0;
    allStoreKeys.forEach(k => {
      const entry = shareContext.get(k);
      if (entry) hits += entry.hits;
    });

    return {
      totalKeys: allStoreKeys.length,
      hits,
      policy: this.config.policy
    };
  }

  namespace(name) {
    return new CacheX({
      ...this.config,
      namespace: this._ns ? `${this.config.namespace}:${name}` : name
    });
  }

  enqueue(queue, payload, options = {}) {
    task.enqueue(`${this._root}q:${queue}`, options.handler || `queue:${queue}`, payload, options);
  }

  /**
   * Stale-While-Revalidate pattern. Returns cached data if available,
   * otherwise calls fetcher and caches the result.
   * If options.refreshAction is provided, it spawns a background task to refresh the data.
   */
  wrap(key, fetcher, options = {}) {
    // SWR logic happens inside `get` based on the saved `task` and `delay`
    const data = this.get(key);
    if (data !== null) {
      // If we got here and task was provided in options but wasn't in entry,
      // update the entry to ensure background refresh happens next time.
      if (options.task || options.refreshAction) {
         const fullKey = this._fullKey(key);
         const storeKey = `${this._storePrefix}${fullKey}`;
         const entry = shareContext.get(storeKey);
         if (entry && !entry.task) {
             entry.task = options.task || options.refreshAction;
             entry.delay = options.delay ?? options.refreshDelay ?? (options.ttl || 60000);
             entry.payload = options.payload || options.refreshPayload || null;
             shareContext.set(storeKey, entry);
         }
      }
      return data;
    }
    const val = fetcher();
    this.set(key, val, options);
    return val;
  }

  _fullKey(key) { return `${this._ns}${key}`; }
  loadStorage() {
    const dir = "../.titan/.cache";
    if (!drift(fs.exists(dir))) return;
    const files = drift(fs.readdir(dir));
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const hexPart = file.split(/[\\/]/).pop().replace(".json", "");
        const fullKey = this._fromHex(hexPart);
        if (!fullKey.startsWith(this._ns)) continue;

        let filePath = file;
        if (!file.includes('/') && !file.includes('\\')) {
          filePath = `${dir}/${file}`;
        }
        const content = drift(fs.readFile(filePath));
        const diskEntry = JSON.parse(content);
        const storeKey = `${this._storePrefix}${fullKey}`;
        
        const memEntry = shareContext.get(storeKey);
        
        // Conflict resolution: keep whichever is newer
        if (!memEntry || diskEntry.updatedAt >= memEntry.updatedAt) {
          if (typeof log !== "undefined" && fullKey === "persist_test") log(`CacheX: Restoring persist_test to memory`);
          shareContext.set(storeKey, diskEntry);
          this._updateEviction(fullKey);
        } else if (memEntry && memEntry.updatedAt > diskEntry.updatedAt) {
          this._writeDisk(fullKey, memEntry);
        }
      } catch (e) {
        if (e === "__SUSPEND__" || e.message === "__SUSPEND__") throw e;
        if (typeof log !== "undefined") log(`CacheX: Error loading ${file} - ${e.message}`);
      }
    }
  }

  rebase() {
    this._ensurePersistence();
    const allKeys = shareContext.keys().filter(k => k.startsWith(this._storePrefix));
    for (const k of allKeys) {
      const entry = shareContext.get(k);
      const fullKey = k.replace(this._storePrefix, "");
      this._writeDisk(fullKey, entry);
    }
    return allKeys.length;
  }

  flushStorage() {
    this._ensurePersistence();
    const dir = "../.titan/.cache";
    if (!drift(fs.exists(dir))) return;
    const files = drift(fs.readdir(dir));
    for (const f of files) {
      const filePath = f.includes(dir) ? f : `${dir}/${f}`;
      drift(fs.remove(filePath));
    }
  }

  flushExpired() {
    const allStoreKeys = shareContext.keys().filter(k => k.startsWith(this._storePrefix));
    const now = Date.now();
    let count = 0;
    allStoreKeys.forEach(k => {
      const entry = shareContext.get(k);
      if (entry && entry.expiresAt && entry.expiresAt < now) {
        shareContext.delete(k);
        count++;
      }
    });
    return count;
  }
}

/**
 * Background action handler for active cleanup.
 */
export function cleanupAction(req) {
  const count = defaultCache.flushExpired();
  log(`CacheX: Active cleanup removed ${count} expired keys.`);
  return { status: "ok", removed: count };
}

/**
 * Background action handler for SWR refresh.
 */
export function refreshAction(req) {
  // refresh logic can be implemented here if needed
  return { status: "ok" };
}

/**
 * CLI Action: Rebase disk storage from current memory state.
 */
export function rebaseAction(req) {
  const count = defaultCache.rebase();
  return { status: "ok", message: `Rebased ${count} keys to disk.` };
}

/**
 * CLI Action: Clear all persistent disk storage.
 */
export function flushStorageAction(req) {
  defaultCache.flushStorage();
  return { status: "ok", message: "Disk storage cleared." };
}

// Add methods to the class
const defaultCache = new CacheX();
export default defaultCache;