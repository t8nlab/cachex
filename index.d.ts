/**
 * TitanPL Extension — @t8n/cachex
 * 
 * A high-performance, Redis-like in-memory data engine built exclusively for TitanPL.
 * Leverages t.shareContext for cross-isolate state and t.task for background orchestration.
 * 
 * @package @t8n/cachex
 */

declare module "@t8n/cachex" {

  /**
   * Configuration options for initializing a new CacheX instance.
   */
  export interface CacheXConfig {
    /** 
     * Maximum number of keys to store before eviction kicks in. 
     * @default 10000 
     */
    maxKeys?: number;
    
    /** 
     * Eviction policy to use when maxKeys is reached.
     * - "lru": Least Recently Used (removes keys not accessed for the longest time)
     * - "lfu": Least Frequently Used (removes keys with the lowest hit count)
     * @default "lru" 
     */
    policy?: "lru" | "lfu";
    
    /** 
     * Optional namespace prefix for all keys stored by this instance.
     * Useful for isolation between different modules.
     */
    namespace?: string;
    
    /** 
     * Maximum size of an individual object in bytes (stringified). 
     * Protects against unbounded memory growth.
     * @default 1048576 (1MB)
     */
    maxObjectSize?: number;
  }

  /**
   * Options for the `set` operation.
   */
  export interface SetOptions {
    /** 
     * Time to live in milliseconds. If specified, the key will automatically 
     * expire after this duration.
     */
    ttl?: number;
    
    /** 
     * "Not eXists" - If true, only sets the key if it does not already exist. 
     * Equivalent to Redis SET NX.
     */
    nx?: boolean;
    
    /** 
     * "eXists" - If true, only sets the key if it already exists. 
     * Equivalent to Redis SET XX.
     */
    xx?: boolean;
  }

  /**
   * Options for the `wrap` (Stale-While-Revalidate) operation.
   */
  export interface WrapOptions extends SetOptions {
    /** 
     * If true, triggers a background refresh via Titan Tasks even if the cache is hit. 
     * Ensures data stays fresh without blocking the current request.
     */
    refresh?: boolean;
  }

  /**
   * CacheX - High-Performance In-Memory Data Engine
   * 
   * Provides a rich API for key-value storage, atomic operations, eviction, 
   * and task-integrated background processing.
   */
  export class CacheX {
    /**
     * Creates a new CacheX instance with the specified configuration.
     * @param config Optional configuration settings.
     */
    constructor(config?: CacheXConfig);

    /**
     * Stores a value in the cache.
     * @param key The unique identifier for the entry.
     * @param value The value to store (must be JSON-serializable).
     * @param options Optional TTL and existence constraints.
     * @returns True if the value was set, false if NX/XX constraints failed.
     */
    set(key: string, value: any, options?: SetOptions): boolean;

    /**
     * Retrieves a value from the cache.
     * Automatically handles lazy expiration and updates eviction metadata.
     * @param key The unique identifier for the entry.
     * @returns The stored value or null if not found or expired.
     */
    get<T = any>(key: string): T | null;

    /**
     * Deletes a key from the cache.
     * @param key The unique identifier for the entry.
     * @returns True if the key was deleted.
     */
    delete(key: string): boolean;

    /**
     * Checks if a key exists and is not expired.
     * @param key The unique identifier for the entry.
     * @returns True if the key exists and is valid.
     */
    exists(key: string): boolean;

    /**
     * Lists all keys in the current namespace matching an optional pattern.
     * @param pattern Optional glob-style pattern (e.g., "user:*").
     * @returns An array of matching keys.
     */
    keys(pattern?: string): string[];

    /**
     * Removes all keys within the current namespace.
     * Highly destructive - use with caution.
     */
    clear(): void;

    /**
     * Sets or updates the expiration time for a key.
     * @param key The unique identifier for the entry.
     * @param ttl Time to live in milliseconds.
     * @returns True if the expiration was set.
     */
    expire(key: string, ttl: number): boolean;

    /**
     * Returns the remaining time to live for a key.
     * @param key The unique identifier for the entry.
     * @returns Remaining milliseconds, -1 if no expiry, or -2 if not found/expired.
     */
    ttl(key: string): number;

    /**
     * Removes the expiration from a key, making it persistent.
     * @param key The unique identifier for the entry.
     * @returns True if the key was persisted.
     */
    persist(key: string): boolean;

    /**
     * Atomically increments a numeric value.
     * Creates the key with 0 if it doesn't exist.
     * @param key The unique identifier for the entry.
     * @param by The amount to increment by. Default: 1.
     * @returns The new value after increment.
     */
    incr(key: string, by?: number): number;

    /**
     * Atomically decrements a numeric value.
     * @param key The unique identifier for the entry.
     * @param by The amount to decrement by. Default: 1.
     * @returns The new value after decrement.
     */
    decr(key: string, by?: number): number;

    /**
     * Sets a new value for a key and returns its old value.
     * @param key The unique identifier for the entry.
     * @param value The new value to set.
     * @returns The previous value or null.
     */
    getset<T = any>(key: string, value: T): T | null;

    /**
     * Appends a string to an existing string value.
     * @param key The unique identifier for the entry.
     * @param value The string to append.
     * @returns The new string value.
     */
    append(key: string, value: string): string;

    /**
     * Creates a new CacheX instance with a sub-namespace.
     * Example: cachex.namespace("users").set("1", ...) -> stored as "users:1"
     * @param name The sub-namespace string.
     * @returns A new namespaced CacheX instance.
     */
    namespace(name: string): CacheX;

    /**
     * Retrieves multiple values from the cache in a single call.
     * @param keys An array of keys to fetch.
     * @returns An array containing the values (or null for missing keys).
     */
    mget(keys: string[]): any[];

    /**
     * Sets multiple key-value pairs at once.
     * @param obj A map of keys and values to store.
     */
    mset(obj: Record<string, any>): void;

    /**
     * Actively scans and removes all expired keys from the entire engine.
     * @returns The number of keys removed.
     */
    flushExpired(): number;

    /**
     * Returns operational statistics for the engine.
     */
    stats(): {
      /** Total number of keys currently in storage */
      totalKeys: number;
      /** Total number of cache hits across all keys */
      hits: number;
      /** Active eviction policy */
      policy: string;
      /** Rough estimate of memory usage in bytes */
      memoryEstimate: number;
    };

    /**
     * Stale-While-Revalidate pattern helper.
     * Returns cached data instantly if available. If missing, calls the fetcher.
     * @param key The unique identifier for the entry.
     * @param fetcher A function that returns fresh data.
     * @param options Cache options and background refresh toggle.
     * @returns The cached or freshly fetched data.
     */
    wrap<T = any>(key: string, fetcher: () => T, options?: WrapOptions): T;

    /**
     * Enqueues a job into a Titan Task queue.
     * Leverages Redis-like queue semantics powered by Titan's Task API.
     * @param queue The name of the queue.
     * @param payload The job payload.
     * @param options Handler name and task configuration.
     */
    enqueue(queue: string, payload: any, options?: { handler?: string; timeout?: number }): void;
  }

  /**
   * Titan Action handler for the background cleanup process.
   * Should be registered as "cachex:cleanup" in titan.json.
   */
  export function cleanupAction(req: any): any;

  /**
   * The default global singleton instance of CacheX.
   */
  const defaultCache: CacheX;
  export default defaultCache;
}
