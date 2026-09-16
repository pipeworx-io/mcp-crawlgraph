# mcp-crawlgraph

CrawlGraph MCP — backlink intelligence on the public Common Crawl webgraph

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1576+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `crawlgraph_backlinks` | Referring domains for a target domain from the Common Crawl webgraph (4.4B edges, 120M domains). Returns linking domains ranked by CrawlGraph authority — useful for SEO audits, competitor backlink profiles, link-building gap research, and verifying who is citing a brand. One call = one quota credit. |
| `crawlgraph_gap_analysis` | Backlink gap analysis: find domains linking to your competitors but NOT to you. Submit your domain + 1–5 competitor domains and CrawlGraph runs an async job (typically completes in seconds; longer for large profiles). This tool polls up to ~10s and either returns the full gap list, or — if still running — returns the job_id so you can resume via crawlgraph_gap_status. Counts against the gap-analysis quota when the job is submitted. |
| `crawlgraph_gap_outreach_targets` | The warm-outreach play: gap_analysis filtered to ONLY the linking domains that link to EVERY competitor you listed but not to you. These are the highest-conviction outreach candidates — every competitor in the set has the link, so the topic/audience is verified. Same async pattern as crawlgraph_gap_analysis (polls up to ~10s; returns job_id if still running). Counts as one gap-analysis quota call. |
| `crawlgraph_gap_status` | Poll a previously-submitted gap analysis job by ID. Use this when crawlgraph_gap_analysis or crawlgraph_gap_outreach_targets returned status=pending with a job_id — call this with the same job_id to retrieve the result once status=completed. Read-only; no quota cost. |
| `crawlgraph_releases` | List the Common Crawl releases CrawlGraph has indexed (used as release_id in backlinks). Free; not counted against quota. |
| `crawlgraph_domain_changes` | Quarter-over-quarter diff of referring domains for a domain — what was added or lost between two Common Crawl releases. Useful for catching link rot, sudden spikes (PR coverage), and outreach campaign attribution. Counts as one call against the backlinks quota. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "crawlgraph": {
      "url": "https://gateway.pipeworx.io/crawlgraph/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/crawlgraph/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1576+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Standalone (no gateway account)

This package also runs as a local stdio MCP server — no Pipeworx account, no
gateway round-trip:

```json
{
  "mcpServers": {
    "crawlgraph": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-crawlgraph"]
    }
  }
}
```

Or run it directly to confirm it starts:

```bash
npx -y @pipeworx/mcp-crawlgraph
```

It speaks MCP over stdin/stdout and answers `initialize`/`tools/list`/`tools/call`
for **only** this pack's tools — none of the shared meta-tools the gateway
connection above adds. Same source, same tools, no ask_pipeworx routing.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Crawlgraph data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
