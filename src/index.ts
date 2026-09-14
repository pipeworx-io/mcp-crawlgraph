interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * CrawlGraph MCP — backlink intelligence on the public Common Crawl webgraph
 * (4.4B edges, 120M domains).
 *
 * BYO key from https://crawlgraph.com — passed via _apiKey (Bearer token like
 * "cg_live_<key>"). Endpoints:
 *   - POST /api/v1/backlinks        — referring domains for a single target
 *   - POST /api/v1/gap-analysis     — async job: domains linking to competitors
 *                                     but not you
 *   - GET  /api/v1/gap-analysis/{id} — poll the gap job
 *   - GET  /api/v1/releases         — list Common Crawl release IDs (free, no quota)
 *   - GET  /api/v1/changes          — quarter-over-quarter referring-domain diff
 *
 * gap_analysis is async (jobs take seconds-minutes). We poll up to ~10s on the
 * same call; if not done, return the job_id + tell the agent to call
 * crawlgraph_gap_status to resume. crawlgraph_gap_outreach_targets reuses the
 * same job pipeline, then post-filters to gaps that cover ALL competitors —
 * the warm-outreach subset (every competitor has a backlink the caller doesn't).
 */


const BASE = 'https://crawlgraph.com/api/v1';
const FETCH_TIMEOUT_MS = 8000;          // single-call upstream timeout
const GAP_POLL_INTERVAL_MS = 1500;      // between status polls
const GAP_POLL_BUDGET_MS = 10000;       // total polling budget per call

interface GapResultGap {
  linking_domain: string;
  found_on: string[];
}

interface GapJob {
  job_id: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  started_at?: string;
  completed_at?: string;
  progress_pct?: number;
  poll_url?: string;
  result?: {
    my_domain: string;
    competitor_domains: string[];
    gaps: GapResultGap[];
    total_gaps: number;
  };
  error?: { code: string; message: string };
}

function extractKey(args: Record<string, unknown>): string {
  const key = args._apiKey as string | undefined;
  delete args._apiKey;
  if (!key) {
    throw new Error('CrawlGraph API key required. Get one at https://crawlgraph.com and pass via _apiKey (cg_live_… Bearer token).');
  }
  return key;
}

async function cgFetch(key: string, path: string, init?: RequestInit): Promise<unknown> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      throw new Error('CrawlGraph timeout: upstream did not respond within 8s.');
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`CrawlGraph error (${res.status}): ${text.slice(0, 240)}`);
  }
  return res.json();
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Tool definitions ────────────────────────────────────────────────────

const tools: McpToolExport['tools'] = [
  {
    name: 'crawlgraph_backlinks',
    description:
      'Referring domains for a target domain from the Common Crawl webgraph (4.4B edges, 120M domains). Returns linking domains ranked by CrawlGraph authority — useful for SEO audits, competitor backlink profiles, link-building gap research, and verifying who is citing a brand. One call = one quota credit.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        domain: { type: 'string', description: 'Target domain to look up (e.g., "example.com"). Bare host, no scheme.' },
        release_id: { type: 'string', description: 'Optional Common Crawl release (e.g., "CC-MAIN-2026-04"). Default = latest. Use crawlgraph_releases to list.' },
        limit: { type: 'number', description: 'Max linking domains to return (default 1000, max 10000).' },
        sort: { type: 'string', enum: ['authority', 'hosts'], description: 'Sort by "authority" (default) or "hosts" (number of distinct linking hosts).' },
        _apiKey: { type: 'string', description: 'CrawlGraph API key (cg_live_… Bearer token).' },
      },
      required: ['domain', '_apiKey'],
    },
  },
  {
    name: 'crawlgraph_gap_analysis',
    description:
      'Backlink gap analysis: find domains linking to your competitors but NOT to you. Submit your domain + 1–5 competitor domains and CrawlGraph runs an async job (typically completes in seconds; longer for large profiles). This tool polls up to ~10s and either returns the full gap list, or — if still running — returns the job_id so you can resume via crawlgraph_gap_status. Counts against the gap-analysis quota when the job is submitted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        my_domain: { type: 'string', description: 'Your domain (bare host).' },
        competitor_domains: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 5,
          description: '1–5 competitor domains to compare against.',
        },
        _apiKey: { type: 'string', description: 'CrawlGraph API key.' },
      },
      required: ['my_domain', 'competitor_domains', '_apiKey'],
    },
  },
  {
    name: 'crawlgraph_gap_outreach_targets',
    description:
      'The warm-outreach play: gap_analysis filtered to ONLY the linking domains that link to EVERY competitor you listed but not to you. These are the highest-conviction outreach candidates — every competitor in the set has the link, so the topic/audience is verified. Same async pattern as crawlgraph_gap_analysis (polls up to ~10s; returns job_id if still running). Counts as one gap-analysis quota call.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        my_domain: { type: 'string', description: 'Your domain.' },
        competitor_domains: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 5,
          description: '2–5 competitor domains. The filter is strongest with more competitors; 2 is the minimum for "warm outreach" to be meaningful.',
        },
        min_authority: { type: 'number', description: 'Optional minimum CrawlGraph authority threshold to filter results client-side.' },
        _apiKey: { type: 'string', description: 'CrawlGraph API key.' },
      },
      required: ['my_domain', 'competitor_domains', '_apiKey'],
    },
  },
  {
    name: 'crawlgraph_gap_status',
    description:
      'Poll a previously-submitted gap analysis job by ID. Use this when crawlgraph_gap_analysis or crawlgraph_gap_outreach_targets returned status=pending with a job_id — call this with the same job_id to retrieve the result once status=completed. Read-only; no quota cost.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        job_id: { type: 'string', description: 'The gap job ID (looks like "gap_a1b2c3").' },
        _apiKey: { type: 'string', description: 'CrawlGraph API key.' },
      },
      required: ['job_id', '_apiKey'],
    },
  },
  {
    name: 'crawlgraph_releases',
    description: 'List the Common Crawl releases CrawlGraph has indexed (used as release_id in backlinks). Free; not counted against quota.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        _apiKey: { type: 'string', description: 'CrawlGraph API key.' },
      },
      required: ['_apiKey'],
    },
  },
  {
    name: 'crawlgraph_domain_changes',
    description:
      'Quarter-over-quarter diff of referring domains for a domain — what was added or lost between two Common Crawl releases. Useful for catching link rot, sudden spikes (PR coverage), and outreach campaign attribution. Counts as one call against the backlinks quota.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        domain: { type: 'string', description: 'Target domain.' },
        from: { type: 'string', description: 'Older release_id (e.g., "CC-MAIN-2025-51"). Default = previous release.' },
        to: { type: 'string', description: 'Newer release_id (e.g., "CC-MAIN-2026-04"). Default = latest release.' },
        _apiKey: { type: 'string', description: 'CrawlGraph API key.' },
      },
      required: ['domain', '_apiKey'],
    },
  },
];

// ── Tool implementations ────────────────────────────────────────────────

async function backlinks(args: Record<string, unknown>): Promise<unknown> {
  const key = extractKey(args);
  const body: Record<string, unknown> = { domain: args.domain };
  if (args.release_id) body.release_id = args.release_id;
  if (args.limit) body.limit = args.limit;
  if (args.sort) body.sort = args.sort;
  return cgFetch(key, '/backlinks', { method: 'POST', body: JSON.stringify(body) });
}

// Submit a gap job + poll up to GAP_POLL_BUDGET_MS. Returns the completed
// result if it finishes in time, or a pending envelope (status='pending',
// job_id, message) so the agent knows to resume via gap_status.
async function submitAndPollGap(
  key: string,
  my_domain: unknown,
  competitor_domains: unknown,
): Promise<GapJob | { status: 'pending'; job_id: string; message: string }> {
  const submit = (await cgFetch(key, '/gap-analysis', {
    method: 'POST',
    body: JSON.stringify({ my_domain, competitor_domains }),
  })) as GapJob;
  if (submit.status === 'completed' || submit.status === 'failed') return submit;

  const job_id = submit.job_id;
  const deadline = Date.now() + GAP_POLL_BUDGET_MS;
  let latest: GapJob = submit;
  while (Date.now() < deadline) {
    await delay(GAP_POLL_INTERVAL_MS);
    latest = (await cgFetch(key, `/gap-analysis/${encodeURIComponent(job_id)}`)) as GapJob;
    if (latest.status === 'completed' || latest.status === 'failed') return latest;
  }
  return {
    status: 'pending',
    job_id,
    message: `Gap analysis still running after ${GAP_POLL_BUDGET_MS / 1000}s (last seen ${latest.status}${latest.progress_pct != null ? `, ${latest.progress_pct}% done` : ''}). Call crawlgraph_gap_status({job_id:"${job_id}"}) to resume.`,
  };
}

async function gapAnalysis(args: Record<string, unknown>): Promise<unknown> {
  const key = extractKey(args);
  return submitAndPollGap(key, args.my_domain, args.competitor_domains);
}

async function gapOutreachTargets(args: Record<string, unknown>): Promise<unknown> {
  const key = extractKey(args);
  const competitors = Array.isArray(args.competitor_domains) ? (args.competitor_domains as string[]) : [];
  const minAuthority = typeof args.min_authority === 'number' ? args.min_authority : undefined;
  const job = await submitAndPollGap(key, args.my_domain, competitors);

  // Still running — return the pending envelope unchanged.
  if ('status' in job && job.status === 'pending') return job;

  const gj = job as GapJob;
  if (gj.status !== 'completed' || !gj.result) return gj;

  // Filter: only gaps that link to ALL listed competitors. min_authority is a
  // client-side cap; CrawlGraph's response shape doesn't include per-gap
  // authority, so when min_authority is set we mark the field as unfilterable.
  const need = competitors.length;
  const full_coverage = gj.result.gaps.filter((g) => g.found_on.length >= need);
  return {
    job_id: gj.job_id,
    status: gj.status,
    completed_at: gj.completed_at,
    my_domain: gj.result.my_domain,
    competitor_domains: gj.result.competitor_domains,
    total_gaps: gj.result.total_gaps,
    full_coverage_gaps: full_coverage.length,
    gaps: full_coverage,
    ...(minAuthority !== undefined
      ? { note: 'min_authority filter is not enforced — the gap-analysis response does not include per-gap authority. Use crawlgraph_backlinks on a candidate to get its authority.' }
      : {}),
  };
}

async function gapStatus(args: Record<string, unknown>): Promise<unknown> {
  const key = extractKey(args);
  return cgFetch(key, `/gap-analysis/${encodeURIComponent(String(args.job_id))}`);
}

async function releases(args: Record<string, unknown>): Promise<unknown> {
  const key = extractKey(args);
  return cgFetch(key, '/releases');
}

async function domainChanges(args: Record<string, unknown>): Promise<unknown> {
  const key = extractKey(args);
  const params = new URLSearchParams({ domain: String(args.domain) });
  if (args.from) params.set('from', String(args.from));
  if (args.to) params.set('to', String(args.to));
  return cgFetch(key, `/changes?${params}`);
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  delete args._context;
  switch (name) {
    case 'crawlgraph_backlinks': return backlinks(args);
    case 'crawlgraph_gap_analysis': return gapAnalysis(args);
    case 'crawlgraph_gap_outreach_targets': return gapOutreachTargets(args);
    case 'crawlgraph_gap_status': return gapStatus(args);
    case 'crawlgraph_releases': return releases(args);
    case 'crawlgraph_domain_changes': return domainChanges(args);
    default: throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 2 }, provider: 'crawlgraph' } satisfies McpToolExport;
