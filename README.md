# mcpfence

**Local-first MCP permission firewall: observe → tighten → intercept.**

Your MCP servers declare all their tools. Your agent client grants all of them.
Nobody ever looks at the gap. mcpfence sits between your client and your MCP
servers as a transparent stdio proxy, watches what your agent *actually* uses,
and shrinks the permission surface down to that — from 100% to the 20% you need.

```
agent client ──stdio──▶ mcpfence proxy ──stdio──▶ real MCP server
                          │
                          ├─ records every call (~/.mcpfence/)
                          ├─ report: declared vs actually used
                          ├─ ask mode: prompts before unknown tool calls
                          └─ tighten: turns usage data into a policy
```

## Why

Static MCP security scanners tell you a server *might* be risky. mcpfence
answers the question scanners don't: **which of these 30 tools has your agent
ever actually called?** Then it enforces the answer.

- **No daemon, no cloud.** One binary command, all state in `~/.mcpfence/`.
- **Zero client changes.** The client still speaks plain stdio MCP; it just
  doesn't know the server it talks to is a proxy.
- **Fail-closed.** Unknown tool + no terminal to answer a prompt = denied,
  never silently allowed.

## Quickstart

```bash
npm install -g mcpfence   # not yet published; see Development below

# Wrap any stdio MCP server - just prefix the original command:
mcpfence run -- npx -y @modelcontextprotocol/server-filesystem ~/proj

# In your client config (Claude Desktop / Cursor / ZCode / ...), replace
#   "command": "npx", "args": ["-y", "server-filesystem", "~/proj"]
# with
#   "command": "mcpfence", "args": ["run", "--name", "fs", "--",
#                                    "npx", "-y", "server-filesystem", "~/proj"]
```

## Commands

| Command | What it does |
|---|---|
| `mcpfence run [--name N] [--mode ask] -- <cmd> [args...]` | Proxy a server; record everything |
| `mcpfence report [--name N] [--json]` | Declared vs actually-used per tool |
| `mcpfence tighten --name N [--apply] [--json]` | Usage-based policy: used→allow, unused→deny |

### observe (default)

Every request is forwarded and logged to `~/.mcpfence/servers/<name>/`:

- `usage.jsonl` — one line per request (method, target, duration, ok)
- `calls.jsonl` — concrete tool invocations
- `tools.json` — last observed declared-tool catalog

### report

```
Server: fs
  declared tools: 14 | actually used: 3 (21%)
  requests: 132 (130 ok, 2 failed) across 5 methods

  USED TOOLS
    read_file    88  last 2026-10-31 09:12:00 UTC
    ...

  NEVER USED (11) - tightening candidates:
    - move_file
    - ...
```

### ask mode

```bash
mcpfence run --mode ask --name fs -- npx -y server-filesystem ~/proj
```

Tool calls are checked against `policy.json`. An unlisted tool prompts the
terminal (POSIX `/dev/tty`, Windows `CONIN$`):

```
[mcpfence] server "fs" wants to call tool "move_file".
  [a] allow once  [d] deny once  [A] always allow  [D] always deny:
```

- `[A]`/`[D]` are written back to `policy.json` — the policy learns as you use it.
- No terminal available (GUI hosts, CI)? **Denied**, never guessed.
- Unattended use: pre-approve via `policy.json`:

```json
{ "default": "ask", "tools": { "read_file": "allow", "write_file": "deny" } }
```

### tighten

Turns observation into enforcement:

```bash
mcpfence tighten --name fs --apply
# allow: read_file, list_dir, search_files
# deny:  move_file, ... (never used since recording began)
# default: ask (tools added after the observation window will prompt)
```

The previous policy is kept as `policy.backup.json`.

## Data & privacy

Everything stays in `~/.mcpfence/` on your machine. Nothing leaves it — there
is no telemetry, no account, no network listener.

## Development

```bash
git clone <repo> && cd mcpfence
npm install
npm run build
npm test        # end-to-end suite against the official server-everything
```

Requires Node >= 18. The e2e suite spawns real MCP servers and runs the proxy
in both `observe` and `ask` modes; it needs no network after `npm install`.

## Roadmap

- [ ] Resource & prompt interception (currently tools only)
- [ ] `mcpfence doctor`: flag servers whose tool descriptions changed since last run
- [ ] Per-argument policy (e.g. allow `write_file` only under `~/proj`)
- [ ] Server identity pinning (manifest hash, like `package-lock` for MCP)

## License

MIT
