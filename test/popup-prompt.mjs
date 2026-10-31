/**
 * Headless test for the Windows popup prompt chain.
 *
 * Spawns the real prompt code with MCPFENCE_PROMPT_TIMEOUT=2 and verifies
 * that: the popup child starts, the timeout elapses, and the answer resolves
 * to a fail-closed "deny" (never allow). You will see one popup flash for
 * ~2 seconds while this runs.
 *
 * Run: node test/popup-prompt.mjs   (Windows only)
 */
import { promptToolPermission } from "../dist/prompt.js";

process.env.MCPFENCE_PROMPT_TIMEOUT = "2";
process.env.MCPFENCE_SERVER = "popup-test";
process.env.MCPFENCE_TOOL = "echo";

const start = Date.now();
const answer = await promptToolPermission({
  server: "popup-test",
  tool: "echo",
});
const elapsed = (Date.now() - start) / 1000;

// A popup with a 2s timeout must resolve to deny after roughly 2-10s
// (process startup dominates the upper bound).
if (answer !== "deny") {
  console.error(`FAIL: expected "deny" from popup timeout, got "${answer}"`);
  process.exit(1);
}
if (elapsed < 1.5) {
  console.error(`FAIL: prompt resolved too fast (${elapsed.toFixed(1)}s) - popup did not run`);
  process.exit(1);
}
console.log(
  `PASS: popup prompt timed out and resolved to "deny" after ${elapsed.toFixed(1)}s`,
);
