/**
 * Per-server tool policy.
 *
 * Stored as policy.json next to the observation logs:
 *
 *   { "default": "ask", "tools": { "echo": "allow", "get-env": "deny" } }
 *
 * Decisions: "allow" | "deny" | "ask". `default` applies to tools without an
 * explicit entry. Interactive "always" answers are written back here, so a
 * server's policy tightens itself as the user answers prompts over time.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export type ToolDecision = "allow" | "deny" | "ask";

export interface PolicyFile {
  default: ToolDecision;
  tools: Record<string, ToolDecision>;
}

const DEFAULT_POLICY: PolicyFile = { default: "ask", tools: {} };

const VALID: ToolDecision[] = ["allow", "deny", "ask"];

function normalize(raw: unknown): PolicyFile {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_POLICY, tools: {} };
  const file = raw as Partial<PolicyFile>;
  const tools: Record<string, ToolDecision> = {};
  for (const [tool, decision] of Object.entries(file.tools ?? {})) {
    if (VALID.includes(decision as ToolDecision)) {
      tools[tool] = decision as ToolDecision;
    }
  }
  return {
    default: VALID.includes(file.default as ToolDecision)
      ? (file.default as ToolDecision)
      : "ask",
    tools,
  };
}

export class PolicyStore {
  readonly file: string;
  private policy: PolicyFile;

  private constructor(file: string, policy: PolicyFile) {
    this.file = file;
    this.policy = policy;
  }

  static load(serverDir: string): PolicyStore {
    const file = path.join(serverDir, "policy.json");
    let policy = DEFAULT_POLICY;
    if (existsSync(file)) {
      try {
        policy = normalize(JSON.parse(readFileSync(file, "utf8")));
      } catch (error) {
        console.error(`[mcpfence] policy.json unreadable, starting empty: ${error}`);
      }
    }
    return new PolicyStore(file, policy);
  }

  decide(tool: string): ToolDecision {
    return this.policy.tools[tool] ?? this.policy.default;
  }

  /** Persist a choice made interactively ("always allow/deny"). */
  remember(tool: string, decision: "allow" | "deny"): void {
    this.policy.tools[tool] = decision;
    try {
      writeFileSync(this.file, JSON.stringify(this.policy, null, 2) + "\n", "utf8");
    } catch (error) {
      console.error(`[mcpfence] failed to persist policy: ${error}`);
    }
  }
}
