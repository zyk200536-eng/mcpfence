/**
 * Terminal permission prompts.
 *
 * The proxy's own stdin carries the MCP protocol, so user answers must come
 * from the controlling terminal: /dev/tty on POSIX, CONIN$ on Windows.
 *
 * Fail-closed rule: when no terminal can be opened (GUI hosts like Claude
 * Desktop, CI, piped runs), the caller gets `deny` and the user is told to
 * pre-approve via policy.json. An unattended firewall that answers itself is
 * not a firewall.
 */
import { closeSync, openSync, readSync, writeSync } from "node:fs";

export type PromptAnswer = "allow" | "deny" | "allowAlways" | "denyAlways";

function openTty(): { fd: number; inFd: number } | null {
  try {
    if (process.platform === "win32") {
      const inFd = openSync("\\\\.\\CONIN$", "rs");
      const outFd = openSync("\\\\.\\CONOUT$", "w");
      return { fd: outFd, inFd };
    }
    const inFd = openSync("/dev/tty", "rs");
    const outFd = openSync("/dev/tty", "w");
    return { fd: outFd, inFd };
  } catch {
    return null;
  }
}

function readLine(inFd: number): string {
  let line = "";
  const buf = Buffer.alloc(1);
  while (true) {
    const n = readSync(inFd, buf, 0, 1, null);
    if (n <= 0) break; // EOF
    const ch = String(buf[0]);
    if (ch === "\n" || ch === "\r") {
      if (line.length > 0) break;
      continue;
    }
    line += buf.toString("utf8", 0, n);
  }
  return line;
}

function writeOut(fd: number, text: string): void {
  try {
    writeSync(fd, text);
  } catch {
    process.stderr.write(text);
  }
}

/**
 * Ask the user at the controlling terminal. Returns null when no terminal is
 * available, so the caller can apply its fail-closed rule.
 */
export function promptToolPermission(options: {
  server: string;
  tool: string;
  signal?: AbortSignal;
}): PromptAnswer | null {
  // Heuristic gate first: GUI hosts (Claude Desktop) and CI pipes have no
  // interactive terminal even though CONIN$ may still be openable - prompting
  // there would block forever waiting for input nobody will type.
  if (!process.stderr.isTTY) {
    console.error(
      `[mcpfence] no interactive terminal for the "${options.tool}" prompt; ` +
        `denying. Pre-approve it via policy.json in the server's log directory.`,
    );
    return null;
  }

  const tty = openTty();
  if (tty === null) {
    console.error(
      `[mcpfence] no terminal available for the "${options.tool}" prompt; ` +
        `denying. Pre-approve it via policy.json in the server's log directory.`,
    );
    return null;
  }

  const { fd, inFd } = tty;
  if (options.signal?.aborted) return null;
  try {
    writeOut(
      fd,
      `\n[mcpfence] server "${options.server}" wants to call tool "${options.tool}".\n` +
        `  [a] allow once  [d] deny once  [A] always allow  [D] always deny: `,
    );
    const answer = readLine(inFd).trim();
    switch (answer) {
      case "a":
      case "A":
        return answer === "A" ? "allowAlways" : "allow";
      case "d":
      case "D":
        return answer === "D" ? "denyAlways" : "deny";
      default:
        // Anything unrecognized is a denial - never prompt-then-allow by accident.
        return "deny";
    }
  } finally {
    writeOut(fd, "\n");
    closeSync(inFd);
    closeSync(fd);
  }
}
