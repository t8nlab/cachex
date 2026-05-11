import { log } from "@titanpl/native";
import cachex from "@t8n/cachex";

/**
 * Background action to refresh a cache key.
 */
export default function refresh(req) {
    const { key } = req.body;
    log(`[BG] Refreshing cache key: ${key}`);
    
    // Simulate fetching new data
    const newData = {
        refreshedAt: new Date().toISOString(),
        random: Math.random()
    };
    
    cachex.set(key, newData);
    log(`[BG] Cache updated for ${key}`);
    
    return { status: "ok" };
}
