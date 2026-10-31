/**
 * End-to-end smoke test for the mcpfence proxy.
 *
 * Spawns: this test (SDK client) -> mcpfence proxy -> server-everything.
 * Covers every capability server-everything advertises, plus error paths.
 * Run: node test/e2e.mjs
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const SERVER_NAME = "e2e-everything";
const serverEntry = path.resolve(
  "node_modules/@modelcontextprotocol/server-everything/dist/index.js",
);

// Clean slate for the log dir so assertions see only this run.
const serverRoot = path.join(homedir(), ".mcpfence", "servers");
rmSync(serverRoot, { recursive: true, force: true });

function makeProxyTransport(upstreamArgs) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.resolve("dist/index.js"),
      "run",
      "--name",
      SERVER_NAME,
      "--",
      ...upstreamArgs,
    ],
    stderr: "pipe",
  });
  transport.stderr.on("data", (chunk) => {
    process.stderr.write(`[proxy] ${chunk}`);
  });
  return transport;
}

// --- 1. full capability pass-through ---------------------------------------
const transport = makeProxyTransport([process.execPath, serverEntry]);
const client = new Client({ name: "e2e-client", version: "0.0.1" });
await client.connect(transport);
console.log("PASS: initialize through proxy");

const { tools } = await client.listTools();
console.log(`PASS: tools/list through proxy (${tools.length} tools)`);

const echo = await client.callTool({
  name: "echo",
  arguments: { message: "hello mcpfence" },
});
const echoText = echo.content?.[0]?.text ?? "";
if (!echoText.includes("hello mcpfence")) {
  throw new Error(`echo returned unexpected content: ${JSON.stringify(echo)}`);
}
console.log(`PASS: tools/call through proxy (echo -> "${echoText.trim()}")`);

// --- 2. resources ------------------------------------------------------------
const { resources } = await client.listResources();
if (resources.length === 0) throw new Error("upstream advertised resources but list is empty");
const { contents } = await client.readResource({
  uri: resources[0].uri,
});
if (!contents?.length) throw new Error("resources/read returned no contents");
console.log(
  `PASS: resources pass-through (list=${resources.length}, read ${resources[0].uri})`,
);

// --- 3. prompts + completion ---------------------------------------------------
const { prompts } = await client.listPrompts();
if (prompts.length === 0) throw new Error("upstream advertised prompts but list is empty");
const prompt = await client.getPrompt({
  name: prompts[0].name,
  arguments: {},
});
if (!prompt.messages?.length) throw new Error("prompts/get returned no messages");
console.log(`PASS: prompts pass-through (list=${prompts.length}, got "${prompts[0].name}")`);

const completion = await client.complete({
  ref: { type: "ref/prompt", name: prompts[0].name },
  argument: { name: prompts[0].arguments?.[0]?.name ?? "style", value: "" },
});
if (!completion.completion) throw new Error("completion/complete returned no completion");
console.log("PASS: completion/complete through proxy");

// --- 4. logging ---------------------------------------------------------------
await client.setLoggingLevel("info");
console.log("PASS: logging/setLevel through proxy");

// --- 5. upstream -> downstream notification forwarding -------------------------
// server-everything's trigger-list-changed emits notifications/tools/list_changed.
const gotListChanged = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no list_changed notification within 5s")), 5000);
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    clearTimeout(timer);
    resolve(true);
  });
});
await client.callTool({
  name: "trigger-list-changed",
  arguments: { list: "tools" },
});
await gotListChanged;
console.log("PASS: notifications/tools/list_changed forwarded upstream -> downstream");

// --- 6. error pass-through -------------------------------------------------------
let toolError = null;
try {
  await client.callTool({ name: "no_such_tool_e2e", arguments: {} });
} catch (error) {
  toolError = error;
}
if (!toolError) throw new Error("unknown tool call did not surface an error");
console.log("PASS: tool error surfaces back to the client");

// The proxy answers from the upstream's own identity.
const info = client.getServerVersion();
console.log(`PASS: serverInfo visible to client: ${info?.name} ${info?.version}`);

await client.close();

// --- 7. upstream spawn failure propagates ------------------------------------------
const badTransport = makeProxyTransport(["definitely-not-a-real-cmd-e2e"]);
const badClient = new Client({ name: "e2e-bad", version: "0.0.1" });
let connectError = null;
try {
  await badClient.connect(badTransport);
} catch (error) {
  connectError = error;
}
if (!connectError) throw new Error("connect should fail when upstream cannot spawn");
console.log("PASS: upstream spawn failure surfaces as a connect error");

// --- 8. observation side --------------------------------------------------------------
const dir = path.join(serverRoot, SERVER_NAME);
if (!existsSync(dir)) throw new Error(`no server log dir at ${dir}`);

const usage = readFileSync(path.join(dir, "usage.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const methods = new Set(usage.map((event) => event.method));
for (const expected of [
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "prompts/list",
  "prompts/get",
  "completion/complete",
]) {
  if (!methods.has(expected)) {
    throw new Error(`usage.jsonl missing ${expected}; got: ${[...methods]}`);
  }
}
const callEvent = usage.find(
  (event) => event.method === "tools/call" && event.target === "echo",
);
if (callEvent.ok !== true) {
  throw new Error(`echo event wrong: ${JSON.stringify(callEvent)}`);
}
const failedCall = usage.find(
  (event) => event.method === "tools/call" && event.ok === false,
);
if (!failedCall) throw new Error("failed tools/call was not recorded as ok:false");
console.log(
  `PASS: usage.jsonl recorded ${usage.length} events across ${methods.size} methods (incl. one failure)`,
);

const calls = readFileSync(path.join(dir, "calls.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
if (!calls.some((call) => call.tool === "echo")) {
  throw new Error(`calls.jsonl missing echo: ${JSON.stringify(calls)}`);
}
console.log(`PASS: calls.jsonl recorded ${calls.length} tool invocations`);

const catalog = JSON.parse(readFileSync(path.join(dir, "tools.json"), "utf8"));
if (!catalog.tools.some((tool) => tool.name === "echo")) {
  throw new Error("tools.json catalog missing echo");
}
console.log(
  `PASS: tools.json catalog has ${catalog.tools.length} declared tools`,
);

// --- 9. report command -------------------------------------------------------
import { execFileSync } from "node:child_process";
const reportJson = JSON.parse(
  execFileSync(process.execPath, [
    path.resolve("dist/index.js"),
    "report",
    "--name",
    SERVER_NAME,
    "--json",
  ], { encoding: "utf8" }),
);
const report = reportJson[0];
if (report.declaredTools !== catalog.tools.length || report.usedTools < 1) {
  throw new Error(`report wrong: ${JSON.stringify(report).slice(0, 200)}`);
}
if (!report.neverUsed.includes("get-env")) {
  throw new Error("report neverUsed missing get-env");
}
console.log(
  `PASS: report command (${report.declaredTools} declared / ${report.usedTools} used, ${report.neverUsed.length} tightening candidates)`,
);

// --- 10. ask mode (interception) ----------------------------------------------
// Pre-seed a policy: echo pre-approved, get-env explicitly denied. The test
// runs without a terminal, so unlisted tools must fail closed.
import { mkdirSync, writeFileSync } from "node:fs";
const askName = "e2e-ask";
const askDir = path.join(serverRoot, askName);
mkdirSync(askDir, { recursive: true });
writeFileSync(
  path.join(askDir, "policy.json"),
  JSON.stringify({ default: "ask", tools: { echo: "allow", "get-env": "deny" } }),
);

const askTransport = new StdioClientTransport({
  command: process.execPath,
  args: [
    path.resolve("dist/index.js"),
    "run",
    "--mode",
    "ask",
    "--name",
    askName,
    "--",
    process.execPath,
    serverEntry,
  ],
  stderr: "pipe",
});
askTransport.stderr.on("data", (chunk) => {
  process.stderr.write(`[ask-proxy] ${chunk}`);
});
const askClient = new Client({ name: "e2e-ask-client", version: "0.0.1" });
await askClient.connect(askTransport);

// Pre-approved tool passes through untouched.
const askEcho = await askClient.callTool({
  name: "echo",
  arguments: { message: "policy allow" },
});
if (!askEcho.content?.[0]?.text?.includes("policy allow")) {
  throw new Error("pre-approved tool did not pass through");
}
console.log("PASS: ask mode - pre-approved tool allowed");

// Explicitly denied tool gets an isError result, not a round trip.
const denied = await askClient.callTool({ name: "get-env", arguments: {} });
if (denied.isError !== true || !JSON.stringify(denied.content).includes("denied")) {
  throw new Error(`denied tool got unexpected result: ${JSON.stringify(denied)}`);
}
console.log("PASS: ask mode - explicitly denied tool blocked");

// Unlisted tool: no terminal in this environment -> fail closed.
const fallback = await askClient.callTool({
  name: "toggle-subscriber-updates",
  arguments: { enabled: true },
});
if (fallback.isError !== true) {
  throw new Error(`unlisted tool should fail closed, got: ${JSON.stringify(fallback)}`);
}
console.log("PASS: ask mode - unlisted tool denied when no terminal answers");

await askClient.close();

const askUsage = readFileSync(path.join(askDir, "usage.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const blockedEvents = askUsage.filter(
  (event) => event.method === "tools/call" && event.error === "blocked by policy",
);
if (blockedEvents.length !== 2) {
  throw new Error(`expected 2 blocked events, got ${blockedEvents.length}`);
}
console.log("PASS: ask mode - both blocks recorded in usage.jsonl");

// --- 11. tighten command -------------------------------------------------------
// e2e-everything has 16 declared tools, 3 with call history (incl. the failed
// one - an attempt is usage). Dry run must not touch policy.json.
const tightenDry = JSON.parse(
  execFileSync(process.execPath, [
    path.resolve("dist/index.js"),
    "tighten",
    "--name",
    SERVER_NAME,
    "--json",
  ], { encoding: "utf8" }),
);
if (tightenDry.applied !== false || tightenDry.allow.length !== 3) {
  throw new Error(`tighten dry run wrong: ${JSON.stringify(tightenDry).slice(0, 200)}`);
}
if (!tightenDry.deny.includes("get-annotated-message")) {
  throw new Error("tighten deny list missing declared-but-unused tool");
}
if (existsSync(path.join(serverRoot, SERVER_NAME, "policy.json"))) {
  throw new Error("dry run must not write policy.json");
}
console.log("PASS: tighten dry run (3 allow / 14 deny, nothing written)");

execFileSync(process.execPath, [
  path.resolve("dist/index.js"),
  "tighten",
  "--name",
  SERVER_NAME,
  "--apply",
], { encoding: "utf8" });
const tightened = JSON.parse(
  readFileSync(path.join(serverRoot, SERVER_NAME, "policy.json"), "utf8"),
);
if (tightened.tools.echo !== "allow" || tightened.tools["get-annotated-message"] !== "deny") {
  throw new Error(`applied policy wrong: ${JSON.stringify(tightened).slice(0, 200)}`);
}
if (tightened.default !== "ask") {
  throw new Error("tightened default must be ask");
}
console.log("PASS: tighten --apply wrote policy.json (used->allow, unused->deny, default ask)");

console.log("\nALL E2E CHECKS PASSED");
