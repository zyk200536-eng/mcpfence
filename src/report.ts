/**
 * `mcpfence report` — the declared-vs-actually-used permission report.
 *
 * Reads the observation files the proxy wrote (~/.mcpfence/servers/<id>/) and
 * prints, per server:
 *   - how many tools the upstream declares vs how many were ever called
 *   - per-tool call counts and last-used times
 *   - the never-used list (the tightening candidates)
 *   - request volume and error rate from usage.jsonl
 *
 * Output goes to stdout; `--json` emits the structured form for scripts.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import {
  ToolCatalogEntry,
  UsageEvent,
} from "./logger.js";

interface ToolCall {
  ts: string;
  tool: string;
  argsBytes: number;
}

export interface ServerReport {
  server: string;
  serverDir: string;
  declaredTools: number;
  usedTools: number;
  toolRows: {
    tool: string;
    calls: number;
    lastUsed?: string;
    description?: string;
  }[];
  neverUsed: string[];
  requests: { total: number; ok: number; failed: number; methods: number };
  firstObserved?: string;
  lastObserved?: string;
}

export function loadServerReport(serverDir: string, server: string): ServerReport | null {
  const toolsFile = path.join(serverDir, "tools.json");
  const callsFile = path.join(serverDir, "calls.jsonl");
  const usageFile = path.join(serverDir, "usage.jsonl");

  if (!existsSync(toolsFile) && !existsSync(usageFile)) return null;

  const catalog: { ts?: string; tools?: ToolCatalogEntry[] } = existsSync(toolsFile)
    ? JSON.parse(readFileSync(toolsFile, "utf8"))
    : {};
  const calls: ToolCall[] = existsSync(callsFile)
    ? readFileSync(callsFile, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    : [];
  const usage: UsageEvent[] = existsSync(usageFile)
    ? readFileSync(usageFile, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line))
    : [];

  const descriptions = new Map(
    (catalog.tools ?? []).map((tool) => [tool.name, tool.description]),
  );

  // Aggregate tool calls: count + last used, per tool.
  const byTool = new Map<string, { calls: number; lastUsed?: string }>();
  for (const call of calls) {
    const entry = byTool.get(call.tool) ?? { calls: 0 };
    entry.calls += 1;
    if (entry.lastUsed === undefined || call.ts > entry.lastUsed) {
      entry.lastUsed = call.ts;
    }
    byTool.set(call.tool, entry);
  }

  const declared = catalog.tools ?? [];
  const toolRows = [...byTool.entries()]
    .map(([tool, entry]) => ({
      tool,
      calls: entry.calls,
      lastUsed: entry.lastUsed,
      description: descriptions.get(tool),
    }))
    .sort((a, b) => b.calls - a.calls);

  // Tools never called (declaration-only; the tightening candidates).
  const called = new Set(byTool.keys());
  const neverUsed = declared
    .filter((tool) => !called.has(tool.name))
    .map((tool) => tool.name);

  const ok = usage.filter((event) => event.ok === true).length;
  const failed = usage.filter((event) => event.ok === false).length;
  const timestamps = usage.map((event) => event.ts).sort();

  return {
    server,
    serverDir,
    declaredTools: declared.length,
    usedTools: byTool.size,
    toolRows,
    neverUsed,
    requests: { total: usage.length, ok, failed, methods: new Set(usage.map((event) => event.method)).size },
    firstObserved: timestamps[0],
    lastObserved: timestamps[timestamps.length - 1],
  };
}

/** All servers with observation data, keyed by directory name. */
export function listServers(logDir?: string): { name: string; dir: string }[] {
  const root = logDir ?? path.join(homedir(), ".mcpfence", "servers");
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, dir: path.join(root, entry.name) }));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const fmtTime = (ts?: string): string => {
  if (!ts) return "never";
  return ts.replace("T", " ").slice(0, 19) + " UTC";
};

export function formatReport(report: ServerReport): string {
  const lines: string[] = [];
  const usageRatio =
    report.declaredTools > 0
      ? Math.round((report.usedTools / report.declaredTools) * 100)
      : 0;

  lines.push(`Server: ${report.server}`);
  lines.push(
    `  declared tools: ${report.declaredTools} | actually used: ${report.usedTools} (${usageRatio}%)`,
  );
  lines.push(
    `  observed: ${fmtTime(report.firstObserved)} -> ${fmtTime(report.lastObserved)}`,
  );
  lines.push(
    `  requests: ${report.requests.total} (${report.requests.ok} ok, ${report.requests.failed} failed) across ${report.requests.methods} methods`,
  );

  if (report.toolRows.length > 0) {
    lines.push("");
    lines.push("  USED TOOLS");
    const width = Math.max(...report.toolRows.map((row) => row.tool.length), 4);
    for (const row of report.toolRows) {
      lines.push(`    ${row.tool.padEnd(width)}  ${String(row.calls).padStart(5)}  last ${fmtTime(row.lastUsed)}`);
    }
  }

  if (report.neverUsed.length > 0) {
    lines.push("");
    lines.push(
      `  NEVER USED (${report.neverUsed.length}) - tightening candidates:`,
    );
    for (const tool of report.neverUsed) {
      lines.push(`    - ${tool}`);
    }
  }

  return lines.join("\n");
}

/** Entry point for the `report` subcommand. */
export async function runReport(options: {
  name?: string;
  logDir?: string;
  json?: boolean;
}): Promise<void> {
  if (options.json) {
    const reports = (
      options.name
        ? [buildReport(options.name, options.logDir)]
        : listServers(options.logDir).map(({ name }) => buildReport(name, options.logDir))
    ).filter((report): report is ServerReport => report !== null);
    console.log(JSON.stringify(reports, null, 2));
    return;
  }

  if (options.name) {
    const report = buildReport(options.name, options.logDir);
    if (report === null) {
      console.error(
        `mcpfence: no observation data for "${options.name}". ` +
          "Has the proxy run with this --name yet?",
      );
      process.exit(1);
    }
    console.log(formatReport(report));
    return;
  }

  const servers = listServers(options.logDir);
  if (servers.length === 0) {
    console.log(
      "No observation data yet. Run a server through the proxy first:\n" +
        "  mcpfence run -- <command> [args...]",
    );
    return;
  }

  for (const { name } of servers) {
    const report = buildReport(name, options.logDir);
    if (report !== null) {
      if (name !== servers[0].name) console.log("");
      console.log(formatReport(report));
    }
  }
}

function buildReport(name: string, logDir?: string): ServerReport | null {
  const root = logDir ?? path.join(homedir(), ".mcpfence", "servers");
  return loadServerReport(path.join(root, name), name);
}
