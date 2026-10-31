/**
 * `mcpfence tighten` — turn observation data into a least-privilege policy.
 *
 * Reads the same files as `report` and produces a policy.json:
 *   - every tool actually used  -> "allow"
 *   - every declared-but-never-used tool -> "deny"
 *   - default -> "ask" (tools added after the observation window prompt)
 *
 * Default is a dry run (prints the plan, touches nothing). `--apply` writes
 * policy.json, keeping the previous file as policy.backup.json.
 */
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { ToolDecision } from "./policy.js";
import { loadServerReport } from "./report.js";

export interface TightenPlan {
  server: string;
  allow: string[];
  deny: string[];
  defaultDecision: "ask";
}

export function buildTightenPlan(serverDir: string, server: string): TightenPlan | null {
  const report = loadServerReport(serverDir, server);
  if (report === null) return null;
  return {
    server,
    allow: report.toolRows.map((row) => row.tool),
    deny: report.neverUsed,
    defaultDecision: "ask",
  };
}

function renderPlan(plan: TightenPlan): string {
  const lines: string[] = [];
  lines.push(`Server: ${plan.server}`);
  lines.push(`  ALLOW (${plan.allow.length}): ${plan.allow.join(", ") || "-"}`);
  lines.push(`  DENY  (${plan.deny.length}): ${plan.deny.join(", ") || "-"}`);
  lines.push(`  default: ask (tools added later will prompt)`);
  return lines.join("\n");
}

export async function runTighten(options: {
  name: string;
  logDir?: string;
  apply?: boolean;
  json?: boolean;
}): Promise<void> {
  const root = options.logDir ?? path.join(homedir(), ".mcpfence", "servers");
  const plan = buildTightenPlan(path.join(root, options.name), options.name);

  if (plan === null) {
    console.error(
      `mcpfence: no observation data for "${options.name}". ` +
        "Run the server through the proxy first.",
    );
    process.exit(1);
  }

  const tools: Record<string, ToolDecision> = {};
  for (const tool of plan.allow) tools[tool] = "allow";
  for (const tool of plan.deny) tools[tool] = "deny";
  const policy = { default: "ask" as const, tools };

  if (options.json) {
    console.log(JSON.stringify({ ...plan, applied: options.apply === true }, null, 2));
    return;
  }

  console.log(renderPlan(plan));

  if (options.apply !== true) {
    console.log("\n(dry run - re-run with --apply to write policy.json)");
    return;
  }

  const policyFile = path.join(root, options.name, "policy.json");
  const backupFile = path.join(root, options.name, "policy.backup.json");
  if (existsSync(policyFile)) {
    copyFileSync(policyFile, backupFile);
    console.log(`\nprevious policy backed up to policy.backup.json`);
  }
  writeFileSync(policyFile, JSON.stringify(policy, null, 2) + "\n", "utf8");
  console.log(`policy written to ${policyFile}`);
  console.log(
    "next step: run the server with `mcpfence run --mode ask -- ...` to enforce it",
  );
}
