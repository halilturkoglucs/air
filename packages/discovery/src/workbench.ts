import { createServer, type Server } from "node:http";
import { evidenceHash } from "./ids.js";
import { readDiscoveryBundle, saveDecision } from "./store.js";
import type { ReviewerDecision } from "./types.js";

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIR Discovery Workbench</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#0d1117;color:#e6edf3}*{box-sizing:border-box}body{margin:0}header{padding:18px 24px;border-bottom:1px solid #30363d;display:flex;justify-content:space-between}main{display:grid;grid-template-columns:280px 1fr 360px;height:calc(100vh - 64px)}aside,section{overflow:auto;padding:16px;border-right:1px solid #30363d}.node{padding:10px;margin:6px 0;border:1px solid #30363d;border-radius:8px;cursor:pointer}.node:hover,.node.active{border-color:#58a6ff;background:#161b22}.badge{font-size:11px;padding:2px 6px;border-radius:9px;background:#30363d}.opaque,.conflicting{color:#ff7b72}.proven{color:#3fb950}.observed{color:#58a6ff}button,input{background:#21262d;color:#e6edf3;border:1px solid #30363d;border-radius:6px;padding:8px;margin:4px}button{cursor:pointer}.graph{display:flex;flex-wrap:wrap;gap:12px}.card{width:210px;padding:14px;border:1px solid #30363d;border-radius:10px}.muted{color:#8b949e;font-size:13px}pre{white-space:pre-wrap;overflow-wrap:anywhere}</style></head>
<body><header><strong>AIR Discovery Workbench</strong><span id="summary"></span></header><main><aside><h3>Coverage</h3><div id="coverage"></div><h3>Inventory</h3><input id="filter" placeholder="Filter nodes"><div id="nodes"></div></aside><section><h2>Capability graph</h2><div class="graph" id="graph"></div><h2>Unresolved boundaries</h2><div class="graph" id="unresolved"></div></section><aside id="detail"><p class="muted">Select a node to inspect provenance and review it.</p></aside></main>
<script>
let data,selected;const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
async function load(){data=await fetch('/api/discovery').then(r=>r.json());document.querySelector('#summary').textContent=data.nodes.length+' nodes · '+data.edges.length+' edges';document.querySelector('#coverage').innerHTML=Object.entries(data.coverage).sort().map(([kind,c])=>'<p class="muted"><b>'+kind+'</b> '+c.proven+' proven · '+c.observed+' observed · '+c.inferred+' inferred · <span class="opaque">'+(c.opaque+c.conflicting)+' unresolved</span></p>').join('');renderList();renderGraph()}
function renderList(){const q=document.querySelector('#filter').value.toLowerCase();document.querySelector('#nodes').innerHTML=data.nodes.filter(n=>(n.name+' '+n.kind).toLowerCase().includes(q)).map(n=>'<div class="node '+(selected===n.id?'active':'')+'" onclick="selectNode(\''+n.id+'\')"><b>'+esc(n.name)+'</b><br><span class="badge">'+n.kind+'</span> <span class="'+n.confidence+'">'+n.confidence+'</span></div>').join('')}
function renderGraph(){document.querySelector('#graph').innerHTML=data.nodes.filter(n=>n.kind==='endpoint'||n.kind==='listener'||n.kind==='schedule').map(n=>'<div class="card"><b>'+esc(n.name)+'</b><p class="muted">'+n.kind+' · '+n.confidence+'</p><button onclick="selectNode(\''+n.id+'\')">Review capability</button></div>').join('');document.querySelector('#unresolved').innerHTML=data.nodes.filter(n=>n.confidence==='opaque'||n.confidence==='conflicting').map(n=>'<div class="card"><b>'+esc(n.name)+'</b><p class="'+n.confidence+'">'+n.kind+' · '+n.confidence+'</p><button onclick="selectNode(\''+n.id+'\')">Resolve boundary</button></div>').join('')||'<p class="muted">No opaque or conflicting boundaries.</p>'}
function selectNode(id){selected=id;renderList();const n=data.nodes.find(x=>x.id===id),d=data.decisions.find(x=>x.subjectId===id&&!x.invalidated);document.querySelector('#detail').innerHTML='<h2>'+esc(n.name)+'</h2><p><span class="badge">'+n.kind+'</span> <span class="'+n.confidence+'">'+n.confidence+'</span></p><pre>'+esc(JSON.stringify(n.attributes,null,2))+'</pre><h3>Provenance</h3>'+n.sources.map(s=>'<p class="muted">'+esc(s.path)+':'+(s.startLine||1)+'<br>'+s.contentHash.slice(0,16)+'</p>').join('')+'<h3>Review</h3><input id="value" placeholder="rename or merge target" value="'+esc(d?.value||'')+'"><br>'+['approve','reject','rename','merge','mark-opaque'].map(a=>'<button onclick="decide(\''+a+'\')">'+a+'</button>').join('')+(d?'<p>Current: '+d.action+(d.invalidated?' (invalidated)':'')+'</p>':'')}
async function decide(action){const value=document.querySelector('#value').value;const response=await fetch('/api/decisions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({subjectId:selected,action,...(value?{value}:{})})});if(!response.ok){alert(await response.text());return}await load();selectNode(selected)}
document.querySelector('#filter').addEventListener('input',renderList);load();
</script></body></html>`;

async function body(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.reduce((size, chunk) => size + chunk.length, 0) > 64 * 1024) throw new Error("Request body is too large.");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

export async function startWorkbench(directory: string, options: { readonly host?: string; readonly port?: number } = {}): Promise<{ readonly server: Server; readonly url: string }> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") throw new Error("The discovery workbench binds to loopback only; use a self-hosted reverse proxy for remote access.");
  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/") { response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'" }); response.end(HTML); return; }
      if (request.method === "GET" && request.url === "/api/discovery") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(await readDiscoveryBundle(directory))); return; }
      if (request.method === "POST" && request.url === "/api/decisions") {
        const input = await body(request) as Partial<ReviewerDecision>;
        if (typeof input.subjectId !== "string" || !["approve", "reject", "rename", "merge", "mark-opaque"].includes(String(input.action))) throw new Error("Invalid reviewer decision.");
        if ((input.action === "rename" || input.action === "merge") && typeof input.value !== "string") throw new Error(`${input.action} requires a value.`);
        const bundle = await readDiscoveryBundle(directory);
        const node = bundle.nodes.find((candidate) => candidate.id === input.subjectId);
        if (!node) throw new Error("Unknown discovery subject.");
        await saveDecision(directory, { subjectId: input.subjectId, action: input.action as ReviewerDecision["action"], ...(input.value ? { value: input.value } : {}), evidenceHash: evidenceHash(node.sources), decidedAt: new Date().toISOString(), reviewer: "local-workbench" });
        response.writeHead(204); response.end(); return;
      }
      response.writeHead(404, { "content-type": "text/plain" }); response.end("Not found");
    } catch (error) { response.writeHead(400, { "content-type": "text/plain" }); response.end(error instanceof Error ? error.message : String(error)); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port ?? 4319, host, () => resolve()); });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : options.port ?? 4319;
  return { server, url: `http://${host === "::1" ? "[::1]" : host}:${port}` };
}
