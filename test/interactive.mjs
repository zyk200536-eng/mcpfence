/**
 * Interactive test for ask-mode prompts. Works from any terminal AND from GUI
 * hosts - on Windows the prompt is a native popup dialog.
 *
 * The script drives 4 tool calls and tells you what to click each time.
 * After it finishes, compare its summary with what you saw on screen.
 *
 * Run: node test/interactive.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const NAME = "interactive-test";
const serverRoot = path.join(homedir(), ".mcpfence", "servers");
const serverDir = path.join(serverRoot, NAME);

// Fresh state so no remembered policy interferes.
rmSync(serverDir, { recursive: true, force: true });

const serverEntry = path.resolve(
  "node_modules/@modelcontextprotocol/server-everything/dist/index.js",
);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    path.resolve("dist/index.js"),
    "run",
    "--mode",
    "ask",
    "--name",
    NAME,
    "--",
    process.execPath,
    serverEntry,
  ],
  // SDK's default env is a whitelist; pass everything through so prompt
  // diagnostics (MCPFENCE_PROMPT_DEBUG) and the user's env reach the proxy.
  env: process.env,
  stderr: "inherit", // so the prompt (and proxy diagnostics) show in THIS terminal
});

const client = new Client({ name: "interactive-test-client", version: "0.0.1" });
await client.connect(transport);
await client.listTools(); // populate the catalog, verify the pipe works

const results = [];

async function step(n, what, tool, args, press) {
  console.log(`\n=== STEP ${n}/4: call "${tool}" -> ${press} ===`);
  try {
    // Generous timeout: the proxy waits for YOUR keypress before answering.
    const result = await client.callTool(
      { name: tool, arguments: args },
      undefined,
      { timeout: 300000 },
    );
    const ok = result.isError !== true;
    results.push({ step: n, tool, executed: ok });
    console.log(`   -> result: ${ok ? "EXECUTED" : `BLOCKED (${result.content?.[0]?.text?.slice(0, 60)}...)`}`);
  } catch (error) {
    results.push({ step: n, tool, executed: false, error: error.message });
    console.log(`   -> error: ${error.message}`);
  }
}

// 1. allow once (popup: Yes, then No on "remember?")
await step(1, "", "echo", { message: "interactive" }, "click Yes, then No (ask again next time)");
// 2. always deny (popup: No, then Yes on "remember?")
await step(2, "", "get-tiny-image", {}, "click No, then Yes (always deny)");
// 3. must be blocked WITHOUT a popup (policy remembered deny)
await step(3, "", "get-tiny-image", {}, "expect NO popup - auto-blocked");
// 4. same, repeated
await step(4, "", "get-tiny-image", {}, "expect NO popup - auto-blocked");

await client.close();

console.log("\n=== SUMMARY ===");
for (const r of results) {
  console.log(
    `step ${r.step} (${r.tool}): ${r.executed ? "executed" : "blocked"}${r.error ? ` (${r.error})` : ""}`,
  );
}

const expected = [true, false, false, false];
const pass = results.every((r, i) => r.executed === expected[i]);
console.log(
  `\nExpected executed/blocked pattern: ${expected.join(", ")} -> ${pass ? "MATCH" : "MISMATCH"}`,
);

// Verify the remembered choices landed in policy.json.
if (existsSync(path.join(serverDir, "policy.json"))) {
  const policy = JSON.parse(readFileSync(path.join(serverDir, "policy.json"), "utf8"));
  console.log("policy.json after your answers:", JSON.stringify(policy.tools));
  console.log(
    `(expect echo:"allow" from step 1 only if you answered A there; get-tiny-image:"deny" from step 3)`,
  );
} else {
  console.log("policy.json not written (only once-answers were used).");
}

console.log(
  "\nScreen checklist:" +
    "\n  - steps 1,2 each showed a permission popup before the result" +
    "\n  - steps 3,4 were blocked WITHOUT any popup (policy remembered deny)",
);
