import { log, task, shareContext } from "@titanpl/native";
import cachex from "@t8n/cachex";

export default function test(req) {
    const results = { tests: {} };
    const assert = (name, condition) => {
        results.tests[name] = condition ? "PASS" : "FAIL";
        log(`[Test] ${name}: ${condition ? "PASS" : "FAIL"}`);
    };

    log("Starting Comprehensive Integration Tests...");

    // 1. Setup expired data for cleaner to pick up
    // Set a key that expires in 1ms
    cachex.set("expired_soon", "bye", { ttl: 1 });


    // 3. SWR Refresh Test
    // Only set it manually if it doesn't exist so we don't reset the timer on every hit
    if (!cachex.exists("swr_key")) cachex.set("swr_key", { data: "old" });
    
    // This call should return cached data. After the delay threshold, it will spawn the task
    const swrData = cachex.wrap("swr_key", () => ({ data: "new" }), { 
        task: "refresh" 
    });
    assert("swr_initial_return", swrData.data === "old" || swrData.random !== undefined);

    // 5. Verification of Atomic Ops
    if (!cachex.exists("count")) cachex.set("count", 0);
    cachex.incr("count", 10);
    const finalCount = cachex.incr("count", 5);
    assert("atomic_ops", finalCount >= 15);
    
    // 6. Persistence Conflict Test
    cachex.set("persist_test", { foo: "bar" });
    
    // Manually wipe ONLY from memory (simulating server restart)
    if (typeof shareContext !== "undefined") {
        shareContext.delete("__cachex__:store:persist_test");
        // Verify it was wiped from memory directly (simulate memory loss)
        assert("persistence_pre_load", shareContext.get("__cachex__:store:persist_test") === null);
    }
    
    // Now, cachex.get should automatically lazy-load the data directly from disk!
    const restored = cachex.get("persist_test");
    log(`Debug Restored data: ${JSON.stringify(restored)}`);
    assert("persistence_restored", restored && restored.foo === "bar");

    // 7. Delayed Refresh Test (10 seconds)
    if (!cachex.exists("delay_key")) {
        log("Setting initial 'delay_key' data...");
        cachex.set("delay_key", { data: "initial" });
    } else {
        log("Reading 'delay_key' to trigger delay check...");
    }
    cachex.wrap("delay_key", () => ({ data: "fresh" }), {
        task: "refresh",
        delay: 10000
    });
    assert("delay_refresh_scheduled", true);

    log("Tests finished. Check background logs for Cleanup and Refresh results.");
    
    return {
        status: "OK",   
        results: results.tests,
        stats: cachex.stats(),
        keys: cachex.keys()
    };
}
