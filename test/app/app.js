import t from "@titanpl/route";

t.get("/test").action("test");
t.get("/fs_check").action("fs_check");

t.get("/").reply("Ready to land on Titan Planet 🚀");

t.start(5100, "Titan Running!");
