# Groundlink MCP Server

Use Groundlink's cited web-search results from any Model Context Protocol (MCP)
host. The server exposes one focused tool, `groundlink_search`, which sends a
query to Groundlink and returns source-bearing results (`title`, `url`,
`snippet`, and `source`) for the model to use when it needs evidence rather
than a guess.

Groundlink currently combines Wikipedia and DuckDuckGo results. Each Groundlink
API key includes **100 free test queries**; after that, prepaid usage is
**$0.001 per query** (one credit per query).

> **Package:** [`groundlink-mcp@0.1.1`](https://www.npmjs.com/package/groundlink-mcp) is published on npm.
> **Source:** https://github.com/ohhavefun/groundlink

- Live API documentation: https://9ea69cec60fa01f65bbb647a092bcbb4.ctonew.app/docs
- Pricing and credits: https://9ea69cec60fa01f65bbb647a092bcbb4.ctonew.app/pricing

## Tool

| Field | Value |
| --- | --- |
| Tool name | `groundlink_search` |
| Input | `{ query: string, max_results?: number }` |
| `max_results` | 1–10; default 5 (or `GROUNDLINK_MAX_RESULTS`) |
| Output | JSON: `{ query, results: [{ title, url, snippet, source }], meta }` |

Use it for factual questions where the host should return URLs/sources with its
answer. The MCP server is deliberately thin: it forwards the query to the
Groundlink HTTPS API and returns the API response over MCP **stdio**.

## Install and run

You need a Groundlink API key (`glk_...`). Ask the Groundlink operator for one
or obtain one through the Groundlink onboarding flow.

```bash
npm install -g groundlink-mcp
export GROUNDLINK_API_KEY=glk_your_key_here
groundlink-mcp
```

Alternatively, an MCP host can execute the package without a global install:

```bash
npx -y groundlink-mcp
```

The process uses stdio; it does not open an HTTP port or print normal output to
stdout. MCP hosts should launch it rather than running it interactively.

### Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `GROUNDLINK_API_KEY` | Yes | — | API key used for every Groundlink request. |
| `GROUNDLINK_BASE_URL` | No | Groundlink live URL | Override only for a compatible deployment. |
| `GROUNDLINK_MAX_RESULTS` | No | `5` | Default results per tool call; capped at `10`. |

## Claude Desktop configuration

Add this entry to Claude Desktop's MCP configuration file
and restart Claude Desktop. Keep the API key private: do not commit it to a
repository or share the configuration file.

```json
{
  "mcpServers": {
    "groundlink": {
      "command": "npx",
      "args": ["-y", "groundlink-mcp"],
      "env": {
        "GROUNDLINK_API_KEY": "glk_your_key_here"
      }
    }
  }
}
```

If the package is installed globally, use `"command": "groundlink-mcp"` and
omit `args`. For hosts that need an absolute executable path, point `command`
at the installed `groundlink-mcp` binary.

## What happens on errors

- Missing `GROUNDLINK_API_KEY`: the server exits at startup with a clear setup
  error.
- API key rejected (401): returned to the MCP host as a tool error; correct the
  key rather than retrying.
- No remaining free or prepaid credits (402): returned as a tool error; fund
  the key before another search.
- Search-source outage (502): returned as a tool error; a short retry may help.

## Marketplace description

**Groundlink — cited web search for MCP.** Give Claude, Cursor, and other MCP
hosts one `groundlink_search` tool that returns source-bearing results instead
of unsupported factual guesses. Every key starts with 100 free tests, then
usage is $0.001 per query through prepaid credits.

## Development and release checks

```bash
bun install
bun run typecheck
bun run build             # emits executable dist/index.js
bun run test              # MCP stdio smoke test
npm run pack:check        # inspect the npm tarball without publishing
```

The npm package intentionally ships only the compiled `dist/` runtime, this
README, and npm's required package metadata. Source and smoke tests stay out of
the tarball.
