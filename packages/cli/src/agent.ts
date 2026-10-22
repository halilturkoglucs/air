import { createInterface } from "node:readline";

interface CliIo { readonly stdout: (message: string) => void; readonly stderr: (message: string) => void }
type RunCli = (args: readonly string[], io: CliIo) => Promise<number>;

export const AGENT_INSTRUCTIONS = `AIR agent loop (protocol air.dev/agent/v1)

Goal: make the candidate behave exactly like the approved legacy baseline.

1. Run: air check run --agent --reveal
   Exit 0 = done. Exit 1 = behavioral differences. Exit 2 = invalid input. Exit 3 = infrastructure failure.
2. On exit 1, read each "- scenario" block. Every line is a JSON pointer with the
   expected (legacy) and actual (candidate) value. "(n)" means n differences under that pointer.
3. Edit candidate code only. Never edit the check, policy, baseline, or legacy target to make a run pass.
4. Rerun step 1. The header reports how many differences were fixed or are new since the last run.
5. Lines starting with NOTE or a NEXT line about a stale baseline or policy are harness problems:
   stop and report them instead of changing the candidate.
6. Stop on exit 0, or after the repair budget you were given, and report the last header line.

Status without running anything: air check status
Full machine output: add --json to any command.
`;

const tools = [
  { name: "air_check_status", description: "Show the check profile and the last run summary. Runs nothing.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "air_check_run", description: "Run the candidate against the approved baseline and return compact differences. Exit 0 means the candidate matches.", inputSchema: { type: "object", properties: { reveal: { type: "boolean", description: "Show expected and actual values for failing scenarios (local only)." }, maxLines: { type: "integer", minimum: 4 } }, additionalProperties: false } },
  { name: "air_check_explain", description: "Explain a saved result.json compactly.", inputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false } },
  { name: "air_check_baseline", description: "Create the baseline from the legacy target in the check profile. Fails if one already exists.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
] as const;

function toolArgs(name: string, args: Record<string, unknown>): readonly string[] | undefined {
  if (name === "air_check_status") return ["check", "status"];
  if (name === "air_check_run") return ["check", "run", "--agent", ...(args.reveal === true ? ["--reveal"] : []), ...(Number.isInteger(args.maxLines) ? ["--max-lines", String(args.maxLines)] : [])];
  if (name === "air_check_explain" && typeof args.result === "string") return ["check", "explain", args.result, "--agent"];
  if (name === "air_check_baseline") return ["check", "baseline"];
  return undefined;
}

// Minimal MCP server over stdio (newline-delimited JSON-RPC 2.0), hand-written so `air` stays dependency-free for agents.
export async function serveMcp(runCli: RunCli, version: string, input: NodeJS.ReadableStream = process.stdin, write: (line: string) => void = (line) => process.stdout.write(line)): Promise<number> {
  const send = (message: unknown): void => write(`${JSON.stringify(message)}\n`);
  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let request: { id?: string | number; method?: string; params?: Record<string, unknown> };
    try { request = JSON.parse(line) as typeof request; } catch { send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); continue; }
    const { id, method, params = {} } = request;
    if (id === undefined) continue; // notifications such as notifications/initialized need no reply
    if (method === "initialize") send({ jsonrpc: "2.0", id, result: { protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "air", version }, instructions: AGENT_INSTRUCTIONS } });
    else if (method === "ping") send({ jsonrpc: "2.0", id, result: {} });
    else if (method === "tools/list") send({ jsonrpc: "2.0", id, result: { tools } });
    else if (method === "tools/call") {
      const args = toolArgs(String(params.name), (params.arguments ?? {}) as Record<string, unknown>);
      if (!args) { send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool or arguments: ${String(params.name)}` } }); continue; }
      let text = "";
      const code = await runCli(args, { stdout: (message) => { text += message; }, stderr: (message) => { text += message; } });
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `${text.trimEnd()}\nexit ${code}` }], isError: code >= 2 } });
    } else send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(method)}` } });
  }
  return 0;
}
