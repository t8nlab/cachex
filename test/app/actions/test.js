import { log, task, time, drift } from "@titanpl/native";
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
    
    // 2. Trigger Manual Cleanup Task
    // We spawn it as a one-off first to see it work immediately
    try {
        task.spawn("instant-cleanup", "cleanup", {}, { dedupe: false });
        assert("cleaner_task_spawned", true);
    } catch (e) {
        assert("cleaner_task_spawned", false);
    }

    // 3. SWR Refresh Test
    cachex.set("swr_key", { data: "old" });
    // This call should return "old" but trigger "refresh" action in BG
    const swrData = cachex.wrap("swr_key", () => ({ data: "new" }), { 
        refreshAction: "refresh" 
    });
    assert("swr_initial_return", swrData.data === "old");

    // 4. Queue Test (using restored getuser)
    try {
        cachex.enqueue("sync_queue", { id: "999" }, { handler: "getuser" });
        assert("queue_enqueued", true);
    } catch (e) {
        assert("queue_enqueued", false);
    }

    // 5. Verification of Atomic Ops
    cachex.set("count", 0);
    cachex.incr("count", 10);
    const finalCount = cachex.incr("count", 5);
    assert("atomic_ops", finalCount === 15);

    log("Tests finished. Check background logs for Cleanup and Refresh results.");
    
    return {
        status: "OK",
        results: results.tests,
        stats: cachex.stats()
    };
}
