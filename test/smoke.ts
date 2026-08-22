/**
 * Groundlink MCP server — real smoke test.
 *
 * Starts the actual server as a child process over stdio, performs the MCP
 * initialize handshake, lists tools, calls `groundlink_search` with a real
 * query using the dev API key, and asserts the result shape
 * (results[].title/url/snippet/source). Also verifies the server fails
 * clearly when GROUNDLINK_API_KEY is missing.
 *
 * Run:  bun run test/smoke.ts   (from the project root)
 *       bun test               (package.json "test" script)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const PROJECT = new URL("..", import.meta.url).pathname;
const SERVER_CMD = ["bun", "run", `${PROJECT}src/index.ts`];

// Dev key from the site's key store (the one used across team smoke tests).
const KEY_STORE = "/home/team/shared/site/.data/keys.json";
const API_KEY: string = JSON.parse(readFileSync(KEY_STORE, "utf8")).keys
  ? Object.keys(JSON.parse(readFileSync(KEY_STORE, "utf8")).keys)[0] ?? ""
  : "";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  if (!API_KEY) throw new Error(`No dev key found in ${KEY_STORE}`);

  // --- (1) start server -----------------------------------------------------
  const transport = new StdioClientTransport({
    command: SERVER_CMD[0],
    args: SERVER_CMD.slice(1),
    env: { ...process.env, GROUNDLINK_API_KEY: API_KEY },
    stderr: "pipe",
  });
  const client = new Client({ name: "groundlink-smoke", version: "0.1.0" });
  let stderrLog = "";
  transport.stderr?.on("data", (d: Buffer) => (stderrLog += d.toString()));
  await client.connect(transport);
  check("server started over stdio", true);

  // --- (2) initialize handshake ---------------------------------------------
  // connect() above already performed the MCP initialize.
  check("initialize handshake completed", true);

  // --- (3) list tools --------------------------------------------------------
  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  check("tools/list returns groundlink_search", names.includes("groundlink_search"), `tools: ${names.join(", ")}`);

  // --- (4) call the tool with a real query -----------------------------------
  const result = await client.callTool({
    name: "groundlink_search",
    arguments: { query: "what is the capital of france", max_results: 3 },
  });

  const content = result.content ?? [];
  const textBlock = content.find((c: { type: string }) => c.type === "text") as
    | { type: string; text: string }
    | undefined;
  check("tool returned a text content block", !!textBlock);
  if (!textBlock) throw new Error("no text content block in tool result");

  let payload: { query?: string; results?: Array<{ title: string; url: string; snippet: string; source: string }>; meta?: unknown };
  try {
    payload = JSON.parse(textBlock.text);
    check("tool result is valid JSON", true);
  } catch {
    payload = {};
    check("tool result is valid JSON", false, textBlock.text.slice(0, 200));
  }
  check("result query echoes input", payload.query === "what is the capital of france", `got: ${payload.query}`);
  check("result has >= 1 result", Array.isArray(payload.results) && payload.results.length >= 1, `count: ${payload.results?.length}`);
  const r0 = payload.results?.[0];
  check("result[0] has title", !!r0?.title?.length, `title: ${r0?.title}`);
  check("result[0] has url", !!r0?.url?.length, `url: ${r0?.url}`);
  check("result[0] has snippet", !!r0?.snippet?.length);
  check("result[0] has source", !!r0?.source?.length, `source: ${r0?.source}`);
  check("result meta present", !!payload.meta, JSON.stringify(payload.meta));
  check("tool result not flagged as error", result.isError !== true);
  console.log("\n--- sample tool result (first result) ---");
  console.log(JSON.stringify(r0, null, 2));

  await client.close();
  check("client closed cleanly", true);

  // --- (5) missing GROUNDLINK_API_KEY must fail clearly ----------------------
  const noKey = spawn(SERVER_CMD[0], SERVER_CMD.slice(1), {
    env: { ...process.env, GROUNDLINK_API_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let noKeyErr = "";
  noKey.stderr.on("data", (d: Buffer) => (noKeyErr += d.toString()));
  const exitCode: number = await new Promise((resolve) => noKey.on("exit", (c) => resolve(c ?? -1)));
  check(
    "missing key: server exits non-zero",
    exitCode !== 0,
    `exit code: ${exitCode}; stderr: ${noKeyErr.trim().slice(0, 200)}`
  );
  check(
    "missing key: error names GROUNDLINK_API_KEY",
    noKeyErr.includes("GROUNDLINK_API_KEY"),
    noKeyErr.trim().slice(0, 200)
  );

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  if (stderrLog.trim()) console.log("--- server stderr ---\n" + stderrLog.trim());
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("SMOKE TEST ERROR:", err);
  process.exit(1);
});