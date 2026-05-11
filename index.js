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
  }

  /**
   * Helper to access Titan native APIs lazily (avoids boot-time ReferenceErrors)
   */
  get _t() {
    return typeof t !== "undefined" ? t : globalThis;
  }

  // --- Internal Locking ---

  _lock(key, fn) {
    const { shareContext } = this._t;
    const lockKey = `${this._lockPrefix}${key}`;
    const start = Date.now();
    
    while (shareContext.get(lockKey)) {
      if (Date.now() - start > 1000) {
        throw new Error(`CacheX: Lock timeout for ${key}`);
      }
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
    const { shareContext } = this._t;
    const storeKey = `${this._storePrefix}${fullKey}`;
    const entry = shareContext.get(storeKey);

    if (!entry) return null;

    if (entry.expiresAt && entry.expiresAt < Date.now()) {
      this._deleteInternal(fullKey);
      return null;
    }

    entry.hits++;
    entry.updatedAt = Date.now();
    shareContext.set(storeKey, entry);
    this._updateEviction(fullKey);

    return entry;
  }

  _setInternal(fullKey, value, options = {}) {
    const { shareContext } = this._t;
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
      hits: existing ? existing.hits : 0
    };

    shareContext.set(storeKey, entry);
    this._updateEviction(fullKey);
    return true;
  }

  _deleteInternal(fullKey) {
    const { shareContext } = this._t;
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
    const { shareContext } = this._t;
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
    const { shareContext } = this._t;
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
    const { shareContext } = this._t;
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
    const fullKey = this._fullKey(key);
    return this._lock(fullKey, () => this._setInternal(fullKey, value, options));
  }

  get(key) {
    const fullKey = this._fullKey(key);
    const entry = this._getInternal(fullKey);
    return entry ? entry.value : null;
  }

  delete(key) {
    const fullKey = this._fullKey(key);
    return this._lock(fullKey, () => this._deleteInternal(fullKey));
  }

  exists(key) {
    const fullKey = this._fullKey(key);
    return !!this._getInternal(fullKey);
  }

  keys(pattern = null) {
    const { shareContext } = this._t;
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
    this.keys().forEach(k => this.delete(k));
  }

  incr(key, by = 1) {
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
    const { shareContext } = this._t;
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
    const { task } = this._t;
    task.enqueue(`${this._root}q:${queue}`, options.handler || `queue:${queue}`, payload, options);
  }

  /**
   * Stale-While-Revalidate pattern. Returns cached data if available,
   * otherwise calls fetcher and caches the result.
   * If options.refreshAction is provided, it spawns a background task to refresh the data.
   */
  wrap(key, fetcher, options = {}) {
    const data = this.get(key);
    if (data !== null) {
      if (options.refreshAction) {
        const { task } = this._t;
        task.spawn(`${this._root}refresh:${key}`, options.refreshAction, { key, ...options.refreshPayload });
      }
      return data;
    }
    const val = fetcher();
    this.set(key, val, options);
    return val;
  }

  _fullKey(key) { return `${this._ns}${key}`; }
}

/**
 * Background action handler for active cleanup.
 */
export function cleanupAction(req) {
  const count = defaultCache.flushExpired();
  if (typeof log !== "undefined") log(`CacheX: Active cleanup removed ${count} expired keys.`);
  return { status: "ok", removed: count };
}

/**
 * Background action handler for SWR refresh.
 */
export function refreshAction(req) {
  // refresh logic can be implemented here if needed
  return { status: "ok" };
}

// Add flushExpired to the class
CacheX.prototype.flushExpired = function() {
  const { shareContext } = this._t;
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
};

const defaultCache = new CacheX();
export default defaultCache;