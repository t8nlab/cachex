# @t8n/cachex 🚀

**A High-Performance, Redis-like In-Memory Data Engine for TitanPL.**

Built exclusively for the Titan Planet runtime, `@t8n/cachex` provides a robust, thread-safe, and memory-efficient key-value store. It leverages Titan's `shareContext` for storage and `task` orchestration for background processing, making it the perfect choice for high-speed caching, state management, and SWR (Stale-While-Revalidate) architecture.

---

## ✨ Features

- **Blazing Fast**: Near-native speed powered by Titan's core.
- **Lazy-Load Persistence**: Automatically saves data to `.titan/.cache` and lazy-loads it back into memory on-demand if the server restarts!
- **SWR Pattern with Delays**: Built-in Stale-While-Revalidate. Serve fast stale data while automatically triggering background tasks to refresh it based on age thresholds!
- **Redis-like API**: Familiar commands like `SET NX`, `GETSET`, `INCR`, `EXPIRE`, and `MGET`.
- **Advanced Eviction**: Automatic memory management with **LRU** (Least Recently Used) and **LFU** (Least Frequently Used) policies.
- **Atomic Operations**: Spin-lock protected updates ensure consistency across parallel isolates.
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

## 💾 Persistent Storage (Lazy Loading)

CacheX now features "Zero-Config Persistence". By default, every `set` operation is mirrored to the `.titan/.cache` folder.

- **Lazy Loading**: When you request a key via `get()`, if the server was restarted and the key is missing from memory, CacheX **automatically reads the disk directly** and restores it to memory on the fly!
- **Consistency**: Disk and memory are kept in sync in real-time.

To disable persistence (memory-only mode):
```javascript
import { CacheX } from "@t8n/cachex";
const volatileCache = new CacheX({ persist: false });
```

---

## 🔄 SWR (Stale-While-Revalidate) & Background Tasks

The `wrap()` method is the most powerful way to handle caching. It implements the **Stale-While-Revalidate** pattern seamlessly with Titan Background Tasks.

#### How `wrap()` and SWR works:

1. **Cache Miss**: Calls your fetcher function synchronously, saves the data to memory and disk, and returns it.
2. **Cache Hit (Fresh)**: Returns the data immediately.
3. **Cache Hit (Stale/Delayed)**: Returns the data immediately, **AND** seamlessly spawns a background Titan Task to fetch new data because the cache is older than the `delay` threshold!

### Perfect SWR Example

Create your action: `app/actions/api/get_user.js`
```javascript
import cachex from "@t8n/cachex";
import db from "../lib/db.js";

export default function getUser(req) {
    const userId = req.body.id;

    // Returns data instantly! 
    // If the data is older than 10 seconds, it automatically spawns "refresh_user_task"
    return cachex.wrap(`user:${userId}`, () => {
        // This only runs ONCE on the very first request
        return db.users.find(userId);
    }, {
        task: "refresh_user_task", // The name of the Titan Action to run in the background
        delay: 10000,              // 10 seconds SWR delay threshold!
        payload: { id: userId }    // Pass data to the background task
    });
}
```

Create your Background Task: `app/actions/bg/refresh_user_task.js`
```javascript
import cachex from "@t8n/cachex";
import db from "../../lib/db.js";

export default function refreshUserTask(req) {
    const { key, id } = req.body; 
    
    // Fetch fresh data in the background without blocking the user!
    const freshData = db.users.find(id);
    
    // Update the cache! This resets the 10-second SWR timer!
    cachex.set(key, freshData);
    
    return { status: "ok" };
}
```
*Note: Make sure `refresh_user_task` is registered in your `titan.json`!*

---

## 📖 API Reference

### Storage Methods
- **`set(key, value, options)`**: Stores a value. Options include `ttl`, `task`, `delay`, `timeout`, and `payload`.
- **`get(key)`**: Retrieves a value. Returns `null` if expired or missing. (Automatically lazy-loads from disk!).
- **`exists(key)`**: Returns `true` if the key exists and is not expired.
- **`delete(key)`**: Removes a key from memory and disk.
- **`clear()`**: Wipes all keys in the current namespace.

### Atomic Operations
- **`incr(key, by = 1)`**: Atomically increments a number.
- **`decr(key, by = 1)`**: Atomically decrements a number.
- **`getset(key, value)`**: Sets a new value and returns the **old** one.
- **`append(key, string)`**: Appends text to an existing string.

### Advanced Features
- **`wrap(key, fetcher, options)`**: The primary SWR helper for high-performance apps.
- **`namespace(name)`**: Creates a sub-namespaced instance (e.g. `cachex.namespace("users").set("123", ...)`).
- **`stats()`**: Returns hit rates, key counts, and memory estimates.


---

Built with ❤️ for the TitanPL ecosystem.
