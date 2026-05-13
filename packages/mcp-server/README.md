# @aipehub/mcp-server

MCP (Model Context Protocol) bridge for [AipeHub](https://github.com/AipeHub/AipeHub). Lets any MCP client — Claude Desktop, Cursor, Cline, Zed, the official `@modelcontextprotocol/inspector` — operate on a running Hub: list participants, dispatch tasks, read the contribution leaderboard, evaluate completed work.

## Install

> ⚠️ **Source-only at this stage.** `npm publish` is descoped — see
> [`.github/RELEASE-CHECKLIST.md`](../../.github/RELEASE-CHECKLIST.md)
> "Distribution decision". The `npx -y @aipehub/mcp-server` invocations
> shown in the **Configure your MCP client** examples below will start
> working once a JS registry is picked; until then, substitute
> `npx -y @aipehub/mcp-server` with the absolute path:
>
> ```
> "command": "node",
> "args": ["/absolute/path/to/AipeHub/packages/mcp-server/bin/server.js"]
> ```

```bash
# 1. Build from source
git clone https://github.com/AipeHub/AipeHub.git && cd AipeHub
pnpm install && pnpm build

# 2. (Future, after npm publish — NOT available yet)
# As an MCP client config (no global install needed):
#   "command": "npx", "args": ["-y", "@aipehub/mcp-server"]
# Or globally:
# npm i -g @aipehub/mcp-server
```

## Configure your MCP client

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%/Claude/claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "aipehub": {
      "command": "npx",
      "args": ["-y", "@aipehub/mcp-server"],
      "env": {
        "AIPE_HUB_URL": "http://127.0.0.1:3000",
        "AIPE_ADMIN_TOKEN": "<your-admin-bearer-token>"
      }
    }
  }
}
```

Restart Claude Desktop. The Hub's tools (5 of them) become available next to whatever else you've configured.

### Cursor / Cline / Zed

Same pattern, follow each editor's MCP guide. The required `command` + `args` + `env` is identical.

## Tools

| Tool | What it does |
|---|---|
| `list_participants` | Who's in the room — agents + humans + capability tags + load |
| `dispatch_task` | Fire a task into the Hub (direct / capability / broadcast) and **wait** for the result |
| `list_tasks` | Recent tasks with status (pending / done / failed / cancelled) |
| `get_leaderboard` | Contribution leaderboard for today / 7d / 30d / all |
| `evaluate_task` | Attach a rating (0–5, 1 decimal) + optional comment to a completed task |

All tools translate to ordinary HTTP calls against the Hub's `/api/*` admin surface (Bearer-token authenticated), so there's no extra wire protocol to worry about.

## CLI flags

```bash
aipehub-mcp                  # reads AIPE_HUB_URL + AIPE_ADMIN_TOKEN env
aipehub-mcp --hub <URL> --token <BEARER>
aipehub-mcp --help
aipehub-mcp --version
```

`--hub` accepts `http://` or `https://`. Trailing slashes are stripped. The server pings `/healthz` on startup and exits with code `3` if the Hub is unreachable.

## Where do I get the admin token?

When you first launch the AipeHub host (`pnpm host` or `docker compose up`), stdout prints:

```
First-run admin URL (shown ONCE — save it):
  http://127.0.0.1:3000/admin?token=<HEX>
```

That `<HEX>` is the token. Subsequent admin invites can be minted via [the API](https://github.com/AipeHub/AipeHub/blob/main/docs/DEPLOY.md#c8-onboard-more-admins).

The token must belong to an **admin** account — worker tokens cannot dispatch tasks.

## Architecture notes

- Stateless: every tool call is a fresh HTTP round-trip. Restart the MCP server and you lose nothing.
- All logs go to **stderr** (stdio is reserved for MCP protocol frames).
- The Hub's existing security (Bearer auth, rate limiting, `ALLOWED_HOSTS`) still applies — this package adds nothing of its own.

## License

MIT — see [LICENSE](../../LICENSE).
