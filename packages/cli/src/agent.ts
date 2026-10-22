import { createInterface } from "node:readline";

interface CliIo { readonly stdout: (message: string) => void; readonly stderr: (message: string) => void }
type RunCli = (args: readonly string[], io: CliIo) => Promise<number>;

export const AGENT_INSTRUCTIONS = `## Behavior checks with AIR (protocol air.dev/agent/v1)

AIR locks what a service observably does, so changes do not alter behavior by accident.

- Before changing a service: if .air/check.json does not exist, make sure the service is running and run
  \`air protect --url http://localhost:<port>\`. AIR builds safe read-only scenarios from an OpenAPI file or
  from the routes in the code and records a baseline. If AIR asks a QUESTION, ask the developer.
  Then grow coverage until the COVERAGE line is high: \`air protect --add --tests\` runs the project's own
  API tests through AIR's proxy (base-URL variables such as API_URL point at it), or
  \`air protect --add -- <command that calls $AIR_PROXY_URL>\` for a request script you write.
- Read every NOTE after the first run. If most scenarios hit a login wall, ask the developer how to sign in,
  put the session cookie or token in an environment variable, and run
  \`air protect --header Cookie=<ENV_VAR> --rebaseline\` (only the variable name is stored). If the code stores
  data, ask for a command that restores a clean state and run \`air protect --reset "<command>" --rebaseline\`;
  otherwise earlier requests can change later answers and hide real changes.
- After each change: restart the service and run \`air protect\`.
  Exit 0 = behavior unchanged. Exit 1 = each "- scenario" block lists pointers with expected and actual
  values; "(n)" means n differences under that pointer. Exit 2 = setup question. Exit 3 = the service or
  environment failed, not the behavior.
- Fix the code unless the difference is intended. If it might be intended, ask the developer, then run
  \`air check approve <scenario> --reason "<their reason>"\`.
- Never edit the check, policy, baseline, or anything under .air/ to make a run pass.
- NOTE lines and a NEXT line about a stale baseline or policy are setup problems: report them instead of
  changing the code.
- Behavior HTTP cannot see (events, caches, data, jobs, files, emails): when \`air protect\` prints a TASK, run
  \`air harness task\` and follow it. You write a small harness; AIR only trusts it after
  \`air harness verify <name> --mutation <patch>\` proves it is stable, input-sensitive, and catches a planted break.
- \`air check status\` shows the last result without running anything.
`;

const tools = [
  { name: "air_protect", description: "Protect a running service: the first call (with url) records and baselines it, later calls check the current code against that baseline and return compact differences.", inputSchema: { type: "object", properties: { url: { type: "string", description: "Base URL of the running service, e.g. http://localhost:3000; needed only the first time." }, command: { type: "array", items: { type: "string" }, description: "Optional argv that sends requests to $AIR_PROXY_URL, for richer first-time recording." } }, additionalProperties: false } },
  { name: "air_check_status", description: "Show the check profile and the last run summary. Runs nothing.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "air_check_run", description: "Run the candidate against the approved baseline and return compact differences. Exit 0 means the candidate matches.", inputSchema: { type: "object", properties: { reveal: { type: "boolean", description: "Show expected and actual values for failing scenarios (local only)." }, maxLines: { type: "integer", minimum: 4 } }, additionalProperties: false } },
  { name: "air_check_explain", description: "Explain a saved result.json compactly.", inputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false } },
  { name: "air_check_baseline", description: "Create the baseline from the legacy target in the check profile. Fails if one already exists.", inputSchema: { type: "object", properties: {}, additionalProperties: false } },
] as const;

function toolArgs(name: string, args: Record<string, unknown>): readonly string[] | undefined {
  if (name === "air_protect") return ["protect", ...(typeof args.url === "string" ? ["--url", args.url] : []), ...(Array.isArray(args.command) && args.command.every((item) => typeof item === "string") && args.command.length > 0 ? ["--", ...(args.command as string[])] : [])];
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
