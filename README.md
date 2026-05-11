# @t8n/cachex 🚀

**A High-Performance, Redis-like In-Memory Data Engine for TitanPL.**

Built exclusively for the Titan Planet runtime, `@t8n/cachex` provides a robust, thread-safe, and memory-efficient key-value store. It leverages Titan's `shareContext` for storage and `task` orchestration for background processing, making it the perfect choice for high-speed caching, state management, and job queueing.

---

## ✨ Features

- **Blazing Fast**: Near-native speed powered by Titan's Rust core.
- **Redis-like API**: Familiar commands like `SET NX`, `GETSET`, `INCR`, `EXPIRE`, and `MGET`.
- **Advanced Eviction**: Automatic memory management with **LRU** (Least Recently Used) and **LFU** (Least Frequently Used) policies.
- **Atomic Operations**: Spin-lock protected updates ensure consistency across parallel isolates.
- **Smart Expiry**: Lazy deletion on access + Active background cleanup tasks.
- **SWR Pattern**: Built-in Stale-While-Revalidate with background revalidation.
- **FIFO Queues**: Native job queueing integrated with Titan's Task engine.
- **Zero-Config Integration**: No external dependencies like Redis or Memcached required.

---

## 📦 Installation

```bash
tgrv i @t8n/cachex
```
or
```bash
npm i @t8n/cachex
```

---

## 🔄 Perfect Task Management

CacheX is designed to work in harmony with Titan's background execution engine.

### 1. Active Background Cleanup
For optimal memory performance, you should enable **Active Cleanup** to purge expired keys even when they aren't being accessed.

**Step 1: Create the cleanup action file** (`app/actions/cleanup.js`)
```javascript
import { log } from "@titanpl/native";
import cachex from "@t8n/cachex";

export default function cleanup(req) {
    log("CacheX: Active cleanup started...");
    const count = cachex.flushExpired();
    log(`CacheX: Active cleanup removed ${count} expired keys.`);
    return { status: "ok", removed: count };
}
```

**Step 2: Initialize the task from your setup action**
```javascript
import { task } from "@titanpl/native";

export default function setup(req) {
    // Spawns a recurring task (deduplicated)
    task.spawn("cache-cleaner", "cleanup", { interval: 60000 }, { dedupe: true });
    return { status: "Cache engine background tasks initialized" };
}
```

### 2. SWR (Stale-While-Revalidate)
The `wrap()` method is the most powerful way to handle caching. It implements the **Stale-While-Revalidate** pattern.

#### How `wrap()` works:
```javascript
const data = cachex.wrap(key, fetcher, options);
```

1.  **Cache Hit**: Returns the data from the cache **immediately** ($O(1)$ latency).
    *   If `options.refreshAction` is set, it spawns a background task to refresh the data so it's ready for the *next* request.
2.  **Cache Miss**: Calls your `fetcher()` function, saves the result to the cache, and returns it.

```javascript
// Example Usage
const user = cachex.wrap("user:123", () => {
    // This function ONLY runs if the cache is empty (Cache Miss)
    return db.users.findUnique({ where: { id: 123 } });
}, {
    ttl: 60000,
    refreshAction: "refresh_user" // Background refresh on Cache Hit
});
```

**Refresh Action Handler** (`app/actions/refresh_user.js`)
```javascript
import cachex from "@t8n/cachex";

export default function refresh(req) {
    const { key } = req.body; // CacheX automatically passes the 'key'
    const freshData = fetchFromDatabase(key); 
    cachex.set(key, freshData);
}
```

---

## 📖 API Reference

### Storage Methods
- **`set(key, value, options)`**: Stores a value. Options include `ttl`, `nx` (only if not exists), and `xx` (only if exists).
- **`get(key)`**: Retrieves a value. Returns `null` if expired or missing.
- **`exists(key)`**: Returns `true` if the key exists and is not expired.
- **`delete(key)`**: Removes a key and its metadata.
- **`clear()`**: Wipes all keys in the current namespace.

### Atomic Operations
- **`incr(key, by = 1)`**: Atomically increments a number.
- **`decr(key, by = 1)`**: Atomically decrements a number.
- **`getset(key, value)`**: Sets a new value and returns the **old** one.
- **`append(key, string)`**: Appends text to an existing string.

### Advanced Features
- **`wrap(key, fetcher, options)`**: The primary SWR helper for high-performance apps.
- **`namespace(name)`**: Creates a sub-namespaced instance (e.g. `cache.namespace("v1")`).
- **`enqueue(queue, payload, options)`**: Pushes a job into a Titan Task queue.
- **`flushExpired()`**: Actively scans and removes all expired keys.
- **`stats()`**: Returns hit rates, key counts, and memory estimates.

---

## 🏰 Building a "Perfect Server" Pattern

A professional Titan server should isolate different types of data with specific eviction policies.

```javascript
import { CacheX } from "@t8n/cachex";

// 🚀 SESSIONS: High volume, Least Recently Used (LRU)
const sessions = new CacheX({ 
    maxKeys: 50000, 
    policy: "lru", 
    namespace: "sess" 
});

// 📈 METRICS: High frequency, Least Frequently Used (LFU)
const metrics = new CacheX({ 
    maxKeys: 1000, 
    policy: "lfu", 
    namespace: "metr" 
});

// 🌍 GLOBAL CACHE: Standard singleton
import cachex from "@t8n/cachex";
```

---

## 🧠 Best Practices

1. **Use `wrap()` for APIs**: It ensures your users never wait for a database query if data is in the cache.
2. **Dedicated Namespaces**: Always use `namespace()` to prevent different parts of your app from overwriting each other's keys.
3. **Set Memory Guards**: Use `maxKeys` and `maxObjectSize` to keep your Titan process lean and stable.
4. **Active Cleanups**: Don't rely on lazy deletion alone; use the `cleanup` task pattern for production.

---

Built with ❤️ for the TitanPL ecosystem.
