import { log } from "@titanpl/native";
import cachex from "@t8n/cachex";

/**
 * Manual cleanup action.
 * This explicitly calls the CacheX flushExpired method.
 */
export default function cleanup(req) {
    log("CacheX: Manual cleanup task started...");
    
    // Perform the cleanup
    const removedCount = cachex.flushExpired();
    
    log(`CacheX: Cleanup complete. Removed ${removedCount} expired keys.`);
    
    return {
        status: "ok",
        removed: removedCount,
        timestamp: new Date().toISOString()
    };
}
