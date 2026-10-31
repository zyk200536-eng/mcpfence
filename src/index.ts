#!/usr/bin/env node
/**
 * mcpfence - local-first MCP permission firewall.
 *
 * Usage:
 *   mcpfence run -- <command> [args...]
 *
 * Runs a stdio MCP server locally as a child process and exposes a proxy of it
 * on this process's own stdio. Every MCP request that passes through is
 * recorded to a local JSONL usage log, which later powers the "declared vs
 * actually used" permission report.
 *
 * This process's stdout is reserved for the MCP protocol. Diagnostics go to
 * stderr only.
 */
import { runProxy } from "./proxy.js";
import { runReport } from "./report.js";
import { runTighten } from "./tighten.js";

interface RunOptions {
  command: string;
  args: string[];
  name?: string;
  logDir?: string;
  mode?: "observe" | "ask";
}

interface ReportOptions {
  name?: string;
  logDir?: string;
  json?: boolean;
}

function parseReportArgs(argv: string[]): ReportOptions {
  const options: ReportOptions = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name" && argv[i + 1]) {
      options.name = argv[++i];
    } else if (argv[i] === "--log-dir" && argv[i + 1]) {
      options.logDir = argv[++i];
    } else if (argv[i] === "--json") {
      options.json = true;
    }
  }
  return options;
}

interface TightenOptions {
  name: string;
  logDir?: string;
  apply?: boolean;
  json?: boolean;
}

function parseTightenArgs(argv: string[]): TightenOptions {
  const options: TightenOptions = { name: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--name" && argv[i + 1]) {
      options.name = argv[++i];
    } else if (argv[i] === "--log-dir" && argv[i + 1]) {
      options.logDir = argv[++i];
    } else if (argv[i] === "--apply") {
      options.apply = true;
    } else if (argv[i] === "--json") {
      options.json = true;
    }
  }
  if (!options.name) {
    console.error("mcpfence tighten: --name <server> is required.");
    process.exit(2);
  }
  return options;
}

function parseRunArgs(argv: string[]): RunOptions {
  const options: RunOptions = { command: "", args: [] };
  let i = 0;

  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--") {
      options.command = argv[i + 1] ?? "";
      options.args = argv.slice(i + 2);
      break;
    } else if (arg === "--name" && argv[i + 1]) {
      options.name = argv[++i];
      i++;
    } else if (arg === "--log-dir" && argv[i + 1]) {
      options.logDir = argv[++i];
      i++;
    } else if (arg === "--mode" && (argv[i + 1] === "observe" || argv[i + 1] === "ask")) {
      options.mode = argv[++i] as "observe" | "ask";
      i++;
    } else {
      // No explicit `--`: treat the first bare token as the command and the
      // rest as its arguments, so `mcpfence run npx -y foo` also works.
      options.command = arg;
      options.args = argv.slice(i + 1);
      break;
    }
  }

  if (!options.command) {
    console.error(
      "mcpfence: no server command given.\n" +
        "Usage: mcpfence run [--name <name>] -- <command> [args...]",
    );
    process.exit(2);
  }

  return options;
}

function main(): void {
  const argv = process.argv.slice(2);
  const subcommand = argv[0];

  switch (subcommand) {
    case "run":
      return void runProxy(parseRunArgs(argv.slice(1))).catch((error) => {
        console.error("[mcpfence] fatal:", error);
        process.exit(1);
      });
    case "report":
      return void runReport(parseReportArgs(argv.slice(1)));
    case "tighten":
      return void runTighten(parseTightenArgs(argv.slice(1)));
    default:
      console.error(
        subcommand === undefined
          ? "mcpfence: missing subcommand. Try `mcpfence run -- <command> [args...]`."
          : `mcpfence: unknown subcommand "${subcommand}".`,
      );
      process.exit(2);
  }
}

main();
