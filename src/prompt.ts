/**
 * Permission prompts.
 *
 * - Windows: a native WScript.Shell popup. This deliberately does NOT read
 *   the console: the proxy's stdin is the MCP protocol pipe, ConPTY eats
 *   console input from child processes (measured, not guessed), and GUI hosts
 *   like Claude Desktop have no console at all. A popup works everywhere and
 *   its timeout doubles as the fail-closed rule.
 * - POSIX: read a line from /dev/tty. Fail-closed when no terminal exists.
 */
import { closeSync, openSync, readSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";

export type PromptAnswer = "allow" | "deny" | "allowAlways" | "denyAlways";

const FAIL_CLOSED_NOTE =
  "Pre-approve it via policy.json in the server's log directory.";

/**
 * Ask the user at the controlling terminal. Resolves null when no terminal is
 * available or the prompt fails, so the caller applies its fail-closed rule.
 */
export async function promptToolPermission(options: {
  server: string;
  tool: string;
  signal?: AbortSignal;
}): Promise<PromptAnswer | null> {
  // Windows: the popup path works with or without a console (GUI hosts too).
  if (process.platform === "win32") {
    return promptPopup(options.server, options.tool, options.signal);
  }

  // POSIX: needs a controlling terminal; GUI hosts and CI fail closed.
  if (!process.stderr.isTTY) {
    console.error(
      `[mcpfence] no interactive terminal for the "${options.tool}" prompt; ` +
        `denying. ${FAIL_CLOSED_NOTE}`,
    );
    return null;
  }

  if (options.signal?.aborted) return null;

  const question =
    `[mcpfence] server "${options.server}" wants to call tool "${options.tool}".\n` +
    `  [a] allow once  [d] deny once  [A] always allow  [D] always deny`;

  const answer = promptPosix(question);

  if (answer === null) {
    console.error(
      `[mcpfence] could not read an answer for the "${options.tool}" prompt; ` +
        `denying. ${FAIL_CLOSED_NOTE}`,
    );
  }
  return answer;
}

/**
 * Windows: run a PowerShell child that shows a WScript.Shell popup.
 *
 * Two dialogs: "allow this call?" (Yes/No, with a timeout that auto-denies)
 * and "remember this choice?" (Yes/No). Exit codes: 1=allow once, 2=deny
 * once, 3=always allow, 4=always deny, anything else = no valid answer (fail
 * closed). Server/tool names travel via environment variables - no quoting
 * hazards.
 */
const POWERSHELL_PROMPT_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $timeout = 60
  if ($env:MCPFENCE_PROMPT_TIMEOUT -match '^\\d+$') { $timeout = [int]$env:MCPFENCE_PROMPT_TIMEOUT }
  $sh = New-Object -ComObject WScript.Shell
  $nl = [string][char]10
  $q = "Server '" + $env:MCPFENCE_SERVER + "' wants to call tool '" + $env:MCPFENCE_TOOL + "'." + $nl + $nl + "Allow this call?"
  $r1 = $sh.Popup($q, $timeout, 'mcpfence - permission request', 4 + 48)
  if ($r1 -eq 6) {
    $r2 = $sh.Popup("Remember this for future sessions?" + $nl + $nl + "Yes = always ALLOW this tool" + $nl + "No = ask again next time", 0, 'mcpfence - remember choice', 4 + 32)
    if ($r2 -eq 6) { exit 3 } else { exit 1 }
  }
  if ($r1 -eq 7) {
    $r2 = $sh.Popup("Remember this for future sessions?" + $nl + $nl + "Yes = always DENY this tool" + $nl + "No = ask again next time", 0, 'mcpfence - remember choice', 4 + 32)
    if ($r2 -eq 6) { exit 4 } else { exit 2 }
  }
  exit 2   # timeout or dialog closed: deny, never remember
} catch { exit 2 }
`;

function promptPopup(
  server: string,
  tool: string,
  signal?: AbortSignal,
): Promise<PromptAnswer | null> {
  const encoded = Buffer.from(POWERSHELL_PROMPT_SCRIPT, "utf16le").toString(
    "base64",
  );
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-NoLogo", "-EncodedCommand", encoded],
      {
        // stderr ignored too: the popup is the only surface the user needs,
        // and PowerShell's CLIXML progress noise would pollute the terminal.
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
        env: {
          ...process.env,
          MCPFENCE_SERVER: server,
          MCPFENCE_TOOL: tool,
        },
      },
    );

    let settled = false;
    const settle = (answer: PromptAnswer | null): void => {
      if (settled) return;
      settled = true;
      resolve(answer);
    };

    signal?.addEventListener(
      "abort",
      () => {
        child.kill();
        settle(null);
      },
      { once: true },
    );

    child.on("error", () => settle(null));
    child.on("close", (code) => {
      switch (code) {
        case 1:
          return settle("allow");
        case 2:
          return settle("deny");
        case 3:
          return settle("allowAlways");
        case 4:
          return settle("denyAlways");
        default:
          // Crash or anything unexpected: never guess "allow".
          return settle(null);
      }
    });
  });
}

/** POSIX: read a line from the controlling terminal. */
function promptPosix(question: string): PromptAnswer | null {
  let outFd: number;
  let inFd: number;
  try {
    inFd = openSync("/dev/tty", "rs");
    outFd = openSync("/dev/tty", "w");
  } catch {
    return null;
  }
  try {
    writeSync(outFd, `\n${question}: `);
    let line = "";
    const buf = Buffer.alloc(1);
    while (true) {
      const n = readSync(inFd, buf, 0, 1, null);
      if (n <= 0) break;
      if (buf[0] === 0x0a || buf[0] === 0x0d) {
        if (line.length > 0) break;
        continue;
      }
      line += buf.toString("utf8", 0, n);
    }
    switch (line.trim()) {
      case "a":
        return "allow";
      case "d":
        return "deny";
      case "A":
        return "allowAlways";
      case "D":
        return "denyAlways";
      default:
        // Anything unrecognized is a denial - never prompt-then-allow by accident.
        return "deny";
    }
  } finally {
    writeSync(outFd, "\n");
    closeSync(inFd);
    closeSync(outFd);
  }
}
