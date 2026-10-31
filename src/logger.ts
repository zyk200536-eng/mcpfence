/**
 * Local JSONL usage recorder.
 *
 * One directory per proxied server (keyed by a stable id derived from the
 * launch command), containing:
 *   - usage.jsonl  one line per observed MCP request
 *   - tools.json   the last observed declared-tool catalog (name + description)
 *
 * Everything stays on disk in a single root directory so the later
 * `report` / `tighten` commands can read it without a database.
 */
import { createHash } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface UsageEvent {
  ts: string;
  /** JSON-RPC method, e.g. "tools/call". */
  method: string;
  /** Tool / resource / prompt name when applicable. */
  target?: string;
  /** Size hint of the params, in bytes, to keep logs light. */
  paramsBytes?: number;
  durationMs?: number;
  ok?: boolean;
  error?: string;
}

export interface ToolCatalogEntry {
  name: string;
  description?: string;
}

export interface ObservedToolCall {
  ts: string;
  tool: string;
  argsBytes: number;
}

export class UsageLogger {
  readonly serverDir: string;

  private readonly usageFile: string;
  private readonly toolsFile: string;
  private readonly callsFile: string;

  private constructor(serverDir: string) {
    this.serverDir = serverDir;
    this.usageFile = path.join(serverDir, "usage.jsonl");
    this.toolsFile = path.join(serverDir, "tools.json");
    this.callsFile = path.join(serverDir, "calls.jsonl");
  }

  static async create(options: {
    logDir?: string;
    name?: string;
    command: string;
    args: string[];
  }): Promise<UsageLogger> {
    const root =
      options.logDir ?? path.join(homedir(), ".mcpfence", "servers");
    const id = options.name ?? serverId(options.command, options.args);
    const serverDir = path.join(root, id);
    await mkdir(serverDir, { recursive: true });
    return new UsageLogger(serverDir);
  }

  async record(event: UsageEvent): Promise<void> {
    try {
      await appendFile(this.usageFile, JSON.stringify(event) + "\n", "utf8");
    } catch (error) {
      console.error("[mcpfence] failed to write usage log:", error);
    }
  }

  /** Record one concrete tool invocation (powers the "actually used" column). */
  async recordToolCall(call: ObservedToolCall): Promise<void> {
    try {
      await appendFile(this.callsFile, JSON.stringify(call) + "\n", "utf8");
    } catch (error) {
      console.error("[mcpfence] failed to write call log:", error);
    }
  }

  /** Persist the last observed declared-tool catalog for this server. */
  async recordToolCatalog(entries: ToolCatalogEntry[]): Promise<void> {
    try {
      await writeFile(
        this.toolsFile,
        JSON.stringify({ ts: new Date().toISOString(), tools: entries }, null, 2),
        "utf8",
      );
    } catch (error) {
      console.error("[mcpfence] failed to write tool catalog:", error);
    }
  }
}

/** Stable per-server id: sanitized command + short hash of the full launch line. */
export function serverId(command: string, args: string[]): string {
  const full = [command, ...args].join(" ");
  const hash = createHash("sha256").update(full).digest("hex").slice(0, 8);
  const base = path.basename(command).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return `${base}-${hash}`;
}
