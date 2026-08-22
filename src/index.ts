#!/usr/bin/env node

/**
 * Groundlink MCP server.
 *
 * Exposes Groundlink's verified, cited search as a single MCP tool so that MCP
 * hosts (Claude Desktop, Claude Code, Cursor, etc.) can ground their answers
 * with sourced results instead of hallucinating.
 *
 * The tool is thin: it forwards a query to the live Groundlink API
 * (POST /api/v1/ground) and returns the cited results to the model.
 *
 * Transport: stdio (the MCP default). Run with `bun run src/index.ts` or the
 * built `node dist/index.js`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Configuration (env vars)
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URL = "https://9ea69cec60fa01f65bbb647a092bcbb4.ctonew.app";
const DEFAULT_MAX_RESULTS = 5;
const MAX_RESULTS_CAP = 10;

function loadConfig(): {
  apiKey: string;
  baseUrl: string;
  defaultMaxResults: number;
} {
  const apiKey = process.env.GROUNDLINK_API_KEY;
  if (!apiKey || apiKey.trim() === "") {
    throw new Error(
      "GROUNDLINK_API_KEY is required. Set it to a Groundlink API key " +
        "(e.g. export GROUNDLINK_API_KEY=glk_...) before starting the server."
    );
  }
  const baseUrl = (process.env.GROUNDLINK_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  let defaultMaxResults = DEFAULT_MAX_RESULTS;
  const raw = process.env.GROUNDLINK_MAX_RESULTS;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new Error(
        `GROUNDLINK_MAX_RESULTS must be a positive integer (got "${raw}").`
      );
    }
    defaultMaxResults = Math.min(MAX_RESULTS_CAP, Math.round(parsed));
  }
  return { apiKey, baseUrl, defaultMaxResults };
}

const config = loadConfig();

// ---------------------------------------------------------------------------
// Groundlink API client
// ---------------------------------------------------------------------------

interface GroundResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

interface GroundResponse {
  query: string;
  results: GroundResult[];
  meta: { request_id: string; result_count: number; processing_ms: number };
}

const TOOL_NAME = "groundlink_search";

async function callGroundlink(
  query: string,
  maxResults: number
): Promise<GroundResponse> {
  const endpoint = `${config.baseUrl}/api/v1/ground`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        "User-Agent": "groundlink-mcp/0.1",
      },
      body: JSON.stringify({ query, max_results: maxResults }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw new Error(
      `Groundlink API request to ${endpoint} failed (network/transport error): ${(err as Error).message}`
    );
  }

  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw new Error(
      `Groundlink API returned HTTP ${res.status} with a non-JSON body.`
    );
  }

  if (!res.ok) {
    // Surface API errors as a tool error the model can understand. The key
    // case is 402 insufficient_credits — the model should NOT keep retrying;
    // a human needs to fund/check the key.
    const errObj = (payload as { error?: { code?: string; message?: string } })?.error;
    const code = errObj?.code ?? `http_${res.status}`;
    const message = errObj?.message ?? `Groundlink API error (HTTP ${res.status}).`;
    if (res.status === 402) {
      throw new Error(
        `Groundlink: ${code}. ${message} This is an account/billing state — ` +
          `no retry will help. A human must purchase credits (POST /api/v1/checkout) ` +
          `or top up the key before searching again.`
      );
    }
    if (res.status === 401) {
      throw new Error(
        `Groundlink: unauthorized (HTTP 401). The GROUNDLINK_API_KEY is invalid or ` +
          `was revoked. Check the key — no retry will help.`
      );
    }
    if (res.status === 400) {
      throw new Error(
        `Groundlink: invalid request (HTTP 400): ${message} Fix the query and retry.`
      );
    }
    if (res.status === 502) {
      throw new Error(
        `Groundlink: search sources temporarily unavailable (HTTP 502). A short ` +
          `retry may work — try again once.`
      );
    }
    throw new Error(`Groundlink: ${code} — ${message}`);
  }

  // Success — but guard the shape.
  const data = payload as Partial<GroundResponse>;
  if (!Array.isArray(data.results)) {
    throw new Error(`Groundlink returned an unexpected response shape (no results array).`);
  }
  return data as GroundResponse;
}

// ---------------------------------------------------------------------------
// MCP server + tool registration
// ---------------------------------------------------------------------------

const GroundlinkSearchArgs = z.object({
  query: z
    .string()
    .min(1, "query must be a non-empty string")
    .describe("The search query to ground. Use a concise, factual question or phrase."),
  max_results: z
    .number()
    .int()
    .min(1)
    .max(MAX_RESULTS_CAP)
    .optional()
    .describe(
      `How many cited results to return (1–${MAX_RESULTS_CAP}). ` +
        `Defaults to ${config.defaultMaxResults}.`
    ),
});

const server = new McpServer(
  { name: "groundlink-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.registerTool(
  TOOL_NAME,
  {
    description:
      "Search Groundlink's verified index (Wikipedia + DuckDuckGo) for a query and " +
      "return cited results (title, url, snippet, source) so the model can answer " +
      "with sources. Each call costs a fraction of a cent against the API key's " +
      "free/credit balance. Prefer this over guessing when a factual claim needs " +
      "verification or a source.",
    inputSchema: GroundlinkSearchArgs.shape,
  },
  async (args: z.infer<typeof GroundlinkSearchArgs>) => {
    const query = args.query.trim();
    const maxResults = args.max_results ?? config.defaultMaxResults;

    if (!query) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { error: "invalid_request", message: "query must be a non-empty string." },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    let data: GroundResponse;
    try {
      data = await callGroundlink(query, maxResults);
    } catch (err) {
      // Surface API/billing errors as a tool error the model can read.
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { error: "groundlink_request_failed", message: (err as Error).message },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }

    // Structured payload so the LLM can cite precisely. We only include what
    // the API actually exposes — cost/credits aren't in the success response
    // (only the meta block), so we don't invent them.
    const payload = {
      query: data.query,
      results: data.results,
      meta: data.meta,
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
