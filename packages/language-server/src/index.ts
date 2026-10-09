import { AirParseError, AirValidationError, parseAir } from "@air/parser";

export interface LspPosition { readonly line: number; readonly character: number }
export interface LspRange { readonly start: LspPosition; readonly end: LspPosition }
export interface LspDiagnostic {
  readonly range: LspRange;
  readonly severity: 1;
  readonly source: "air";
  readonly code: string;
  readonly message: string;
}

function rangeForPath(source: string, path: string): LspRange {
  const raw = path.split("/").filter(Boolean).at(-1)?.replaceAll("~1", "/").replaceAll("~0", "~");
  const lines = source.split(/\r?\n/);
  if (raw) {
    for (let line = 0; line < lines.length; line += 1) {
      const text = lines[line]!;
      const match = new RegExp(`(^|\\s)${raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).exec(text);
      if (match) {
        const character = match.index + match[1]!.length;
        return { start: { line, character }, end: { line, character: character + raw.length } };
      }
    }
  }
  return { start: { line: 0, character: 0 }, end: { line: 0, character: Math.max(1, lines[0]?.length ?? 1) } };
}

export function diagnoseAirDocument(source: string, uri = "<editor>"): readonly LspDiagnostic[] {
  try {
    parseAir(source, uri);
    return [];
  } catch (error) {
    if (error instanceof AirValidationError) {
      return error.issues.map((issue) => ({
        range: rangeForPath(source, issue.path),
        severity: 1,
        source: "air",
        code: issue.code,
        message: issue.message,
      }));
    }
    if (error instanceof AirParseError) {
      const match = /at line (\d+), column (\d+)/i.exec(error.message) ?? /line (\d+), column (\d+)/i.exec(error.message);
      const line = Math.max(0, Number(match?.[1] ?? 1) - 1);
      const character = Math.max(0, Number(match?.[2] ?? 1) - 1);
      return [{
        range: { start: { line, character }, end: { line, character: character + 1 } },
        severity: 1,
        source: "air",
        code: "AIR_YAML_PARSE",
        message: error.message,
      }];
    }
    throw error;
  }
}

interface JsonRpcRequest { readonly jsonrpc: "2.0"; readonly id?: string | number; readonly method: string; readonly params?: any }

function wordAt(source: string, position: LspPosition): string {
  const line = source.split(/\r?\n/)[position.line] ?? "";
  const left = line.slice(0, position.character).match(/[A-Za-z0-9_.-]+$/)?.[0] ?? "";
  const right = line.slice(position.character).match(/^[A-Za-z0-9_.-]+/)?.[0] ?? "";
  return `${left}${right}`;
}

export const AIR_COMPLETION_ITEMS = [
  ["apiVersion", "AIR schema version, normally air.dev/v0.9"], ["kind", "AIR document kind: Application"],
  ["metadata", "Application identity and release metadata"], ["spec", "Application semantics"],
  ["entities", "Persistent domain entities"], ["contracts", "Closed command input contracts"],
  ["principals", "Authenticated principal claim shapes"], ["commands", "Transactional domain commands"],
  ["http", "HTTP operation declarations"], ["authorization", "Principal authorization policy"],
  ["invariants", "Typed business invariants"], ["effects", "Named atomic effects"],
  ["collection", "Pagination, filtering, and ordering contract"],
  ["events", "Versioned domain and integration events"], ["tasks", "Point-to-point asynchronous tasks"],
  ["consumers", "Durable event and task consumers"], ["schedules", "UTC command schedules"],
  ["cachedReads", "Derived reads with freshness and canonical fallback"],
  ["realtime", "Authenticated WebSocket and SSE channels"],
].map(([label, documentation]) => ({ label: label!, kind: 10, documentation: documentation! }));

const HOVER_DOCUMENTATION: Readonly<Record<string, string>> = Object.fromEntries(AIR_COMPLETION_ITEMS.map((item) => [item.label, item.documentation]));

export function hoverAirDocument(source: string, position: LspPosition): { readonly contents: { readonly kind: "markdown"; readonly value: string } } | null {
  const word = wordAt(source, position);
  const documentation = HOVER_DOCUMENTATION[word];
  return documentation ? { contents: { kind: "markdown", value: `**${word}**\n\n${documentation}` } } : null;
}

export function airDocumentSymbols(source: string, uri = "<editor>"): readonly Record<string, unknown>[] {
  try {
    const air = parseAir(source, uri);
    return [
      ...Object.keys(air.spec.entities).map((name) => ({ name, kind: 5, range: rangeForPath(source, name), selectionRange: rangeForPath(source, name) })),
      ...Object.keys(air.spec.contracts ?? {}).map((name) => ({ name, kind: 23, range: rangeForPath(source, name), selectionRange: rangeForPath(source, name) })),
      ...Object.keys(air.spec.commands ?? {}).map((name) => ({ name, kind: 12, range: rangeForPath(source, name), selectionRange: rangeForPath(source, name) })),
    ];
  } catch {
    return [];
  }
}

function writeMessage(message: unknown): void {
  const body = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

export function startLanguageServer(): void {
  const documents = new Map<string, string>();
  let buffer = Buffer.alloc(0);
  let shutdown = false;

  const publish = (uri: string, text: string): void => {
    writeMessage({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: diagnoseAirDocument(text, uri) } });
  };

  const handle = (request: JsonRpcRequest): void => {
    const respond = (result: unknown): void => {
      if (request.id !== undefined) writeMessage({ jsonrpc: "2.0", id: request.id, result });
    };
    switch (request.method) {
      case "initialize":
        respond({ capabilities: {
          textDocumentSync: { openClose: true, change: 1 },
          diagnosticProvider: { interFileDependencies: false, workspaceDiagnostics: false },
          completionProvider: { triggerCharacters: [":", " "] },
          hoverProvider: true,
          documentSymbolProvider: true,
        }, serverInfo: { name: "AIR Language Server", version: "0.2.0" } });
        break;
      case "shutdown":
        shutdown = true;
        respond(null);
        break;
      case "exit":
        process.exitCode = shutdown ? 0 : 1;
        process.stdin.pause();
        break;
      case "textDocument/didOpen": {
        const document = request.params?.textDocument;
        if (document?.uri && typeof document.text === "string") {
          documents.set(document.uri, document.text);
          publish(document.uri, document.text);
        }
        break;
      }
      case "textDocument/didChange": {
        const uri = request.params?.textDocument?.uri;
        const text = request.params?.contentChanges?.at(-1)?.text;
        if (uri && typeof text === "string") {
          documents.set(uri, text);
          publish(uri, text);
        }
        break;
      }
      case "textDocument/didClose": {
        const uri = request.params?.textDocument?.uri;
        if (uri) {
          documents.delete(uri);
          writeMessage({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [] } });
        }
        break;
      }
      case "textDocument/completion":
        respond({ isIncomplete: false, items: AIR_COMPLETION_ITEMS });
        break;
      case "textDocument/hover": {
        const uri = request.params?.textDocument?.uri;
        const source = documents.get(uri) ?? "";
        respond(hoverAirDocument(source, request.params?.position ?? { line: 0, character: 0 }));
        break;
      }
      case "textDocument/documentSymbol": {
        const uri = request.params?.textDocument?.uri;
        const source = documents.get(uri) ?? "";
        respond(airDocumentSymbols(source, uri));
        break;
      }
      case "textDocument/diagnostic": {
        const uri = request.params?.textDocument?.uri;
        respond({ kind: "full", items: diagnoseAirDocument(documents.get(uri) ?? "", uri) });
        break;
      }
      default:
        if (request.id !== undefined) writeMessage({ jsonrpc: "2.0", id: request.id, result: null });
    }
  };

  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const separator = buffer.indexOf("\r\n\r\n");
      if (separator < 0) break;
      const headers = buffer.subarray(0, separator).toString("ascii");
      const length = Number(/Content-Length:\s*(\d+)/i.exec(headers)?.[1]);
      if (!Number.isFinite(length)) {
        buffer = Buffer.alloc(0);
        break;
      }
      const start = separator + 4;
      if (buffer.length < start + length) break;
      const body = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      try { handle(JSON.parse(body) as JsonRpcRequest); }
      catch (error) {
        writeMessage({ jsonrpc: "2.0", error: { code: -32700, message: error instanceof Error ? error.message : String(error) }, id: null });
      }
    }
  });
  process.stdin.resume();
}
