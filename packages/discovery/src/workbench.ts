import { createServer, type Server } from "node:http";
import { isAbsolute, relative, resolve } from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import { contentHash, evidenceHash } from "./ids.js";
import { readDiscoveryBundle, saveDecision } from "./store.js";
import type { DiscoveryBundle, DiscoveryNode, ReviewerDecision, SourceSpan } from "./types.js";

const HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AIR Discovery Workbench</title><style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#0b1020;color:#e6edf3}*{box-sizing:border-box}body{margin:0}header{height:64px;padding:14px 20px;border-bottom:1px solid #29324a;display:flex;align-items:center;justify-content:space-between;background:#0e1528}.layout{display:grid;grid-template-columns:320px minmax(460px,1fr) 390px;height:calc(100vh - 64px)}aside,main{overflow:auto;padding:16px;border-right:1px solid #29324a}.summary{display:flex;gap:8px;flex-wrap:wrap}.metric{padding:7px 10px;border:1px solid #29324a;border-radius:8px;background:#111a30;font-size:12px}.filters{display:grid;grid-template-columns:1fr 1fr;gap:6px}.filters input{grid-column:1/-1}.node,.edge,.card{padding:10px;margin:7px 0;border:1px solid #29324a;border-radius:8px;background:#10182b}.node{cursor:pointer}.node:hover,.node.active,.card.active{border-color:#58a6ff;background:#14213a}.badge{font-size:11px;padding:2px 6px;border-radius:9px;background:#29324a}.opaque,.conflicting,.rejected{color:#ff7b72}.inferred,.invalidated{color:#d29922}.proven,.approved{color:#3fb950}.observed{color:#58a6ff}button,input,select,textarea{width:auto;background:#182238;color:#e6edf3;border:1px solid #36405a;border-radius:6px;padding:8px;margin:3px 0}input,select,textarea{width:100%}textarea{min-height:65px}button{cursor:pointer}button:hover{border-color:#58a6ff}.graph{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:9px}.muted{color:#9aa7bd;font-size:12px}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#080d18;padding:10px;border-radius:7px;max-height:300px;overflow:auto}.source-line{display:grid;grid-template-columns:42px 1fr;gap:8px}.source-line mark{background:#4b3b0b;color:#fff}.progress{height:7px;background:#29324a;border-radius:5px;overflow:hidden}.progress span{display:block;height:100%;background:#3fb950}h2{margin-top:8px}h3{margin:18px 0 7px}.empty{padding:16px;border:1px dashed #36405a;border-radius:8px;color:#9aa7bd}@media(max-width:1050px){.layout{grid-template-columns:280px 1fr}.detail{grid-column:1/-1;height:auto;border-top:1px solid #29324a}}
</style></head><body><header><strong>AIR Discovery Workbench</strong><span id="identity" class="muted"></span></header><div class="layout"><aside><div id="summary" class="summary"></div><h3>Review progress</h3><div class="progress"><span id="progress"></span></div><p id="progressText" class="muted"></p><h3>Coverage</h3><div id="coverage"></div><h3>Inventory filters</h3><div class="filters"><input id="filter" placeholder="Name, kind, module"><select id="kind"><option value="">All kinds</option></select><select id="confidence"><option value="">All confidence</option></select><select id="module"><option value="">All modules</option></select><select id="resolution"><option value="">All review states</option><option value="unresolved">Unresolved observable</option><option value="reviewed">Reviewed</option></select></div><div id="nodes"></div></aside><main><h2>Entry points</h2><div class="graph" id="entries"></div><h2 id="sliceTitle">System topology</h2><div id="slice" class="graph"></div><h2>Unresolved observable boundaries</h2><div class="graph" id="unresolved"></div><h2>Invalidated decisions and unmatched evidence</h2><div id="stale"></div></main><aside class="detail" id="detail"><p class="muted">Select a node to inspect its attributes, relationships, source evidence, and review state.</p></aside></div>
<script>
let data,selected,sliceRoot;const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const isEntry=n=>['endpoint','listener','schedule'].includes(n.kind)||(n.kind==='operation'&&n.attributes.entryPoint===true);const activeDecision=n=>data.decisions.find(d=>d.subjectId===n.id&&!d.invalidated);const inReviewScope=n=>n.observable||isEntry(n);const unresolved=n=>{const action=activeDecision(n)?.action;if(action==='approve'||action==='reject')return false;return action==='mark-opaque'||n.confidence==='opaque'||n.confidence==='conflicting'||(n.observable&&n.confidence==='inferred')};
function optionValues(selector,values){selector.innerHTML+=Array.from(new Set(values.filter(Boolean))).sort().map(v=>'<option>'+esc(v)+'</option>').join('')}
async function load(){data=await fetch('/api/discovery').then(r=>{if(!r.ok)throw new Error('Could not load bundle');return r.json()});const scope=data.nodes.filter(inReviewScope),reviewed=scope.filter(activeDecision).length,stale=data.decisions.filter(d=>d.invalidated).length,unmatched=data.evidence.filter(e=>e.nodeIds.length===0).length;document.querySelector('#identity').textContent=data.manifest.metadata.analyzer+' '+data.manifest.metadata.analyzerVersion;document.querySelector('#summary').innerHTML=[['nodes',data.nodes.length],['edges',data.edges.length],['entry points',data.nodes.filter(isEntry).length],['unresolved',data.nodes.filter(unresolved).length],['unmatched evidence',unmatched]].map(([l,v])=>'<span class="metric"><b>'+v+'</b> '+l+'</span>').join('');document.querySelector('#progress').style.width=(scope.length?reviewed/scope.length*100:100)+'%';document.querySelector('#progressText').textContent=reviewed+' of '+scope.length+' entry points and observable boundaries reviewed · '+stale+' invalidated';document.querySelector('#coverage').innerHTML=Object.entries(data.coverage).sort().map(([kind,c])=>'<p class="muted"><b>'+esc(kind)+'</b> '+c.proven+' proven · '+c.observed+' observed · '+c.inferred+' inferred · <span class="opaque">'+(c.opaque+c.conflicting)+' unresolved</span></p>').join('');if(!document.querySelector('#kind').dataset.ready){optionValues(document.querySelector('#kind'),data.nodes.map(n=>n.kind));optionValues(document.querySelector('#confidence'),data.nodes.map(n=>n.confidence));optionValues(document.querySelector('#module'),data.nodes.map(n=>n.module));document.querySelector('#kind').dataset.ready='1'}renderList();renderSystem();if(selected&&data.nodes.some(n=>n.id===selected))selectNode(selected)}
function filteredNodes(){const q=document.querySelector('#filter').value.toLowerCase(),kind=document.querySelector('#kind').value,confidence=document.querySelector('#confidence').value,module=document.querySelector('#module').value,resolution=document.querySelector('#resolution').value;return data.nodes.filter(n=>(n.name+' '+n.kind+' '+(n.module||'')).toLowerCase().includes(q)&&(!kind||n.kind===kind)&&(!confidence||n.confidence===confidence)&&(!module||n.module===module)&&(!resolution||(resolution==='unresolved'?unresolved(n):Boolean(activeDecision(n)))))}
function renderList(){document.querySelector('#nodes').innerHTML=filteredNodes().map(n=>'<div class="node '+(selected===n.id?'active':'')+'" onclick="selectNode(\''+n.id+'\')"><b>'+esc(n.name)+'</b><br><span class="badge">'+n.kind+'</span> <span class="'+n.confidence+'">'+n.confidence+'</span> <span class="muted">'+esc(n.module||'')+'</span></div>').join('')||'<p class="empty">No matching nodes.</p>'}
function entryCard(n){const method=n.attributes.method?'<span class="badge">'+esc(n.attributes.method)+'</span> ':'';return '<div class="card '+(sliceRoot===n.id?'active':'')+'"><b>'+esc(n.attributes.path||n.name)+'</b><p>'+method+'<span class="badge">'+n.kind+'</span> <span class="'+n.confidence+'">'+n.confidence+'</span></p><button onclick="showSlice(\''+n.id+'\')">Capability slice</button> <button onclick="selectNode(\''+n.id+'\')">Inspect</button></div>'}
function renderSystem(){const entries=data.nodes.filter(isEntry);document.querySelector('#entries').innerHTML=entries.map(entryCard).join('')||'<p class="empty">No entry points found.</p>';const unresolvedNodes=data.nodes.filter(unresolved);document.querySelector('#unresolved').innerHTML=unresolvedNodes.map(n=>'<div class="card"><b>'+esc(n.name)+'</b><p><span class="badge">'+n.kind+'</span> <span class="'+n.confidence+'">'+n.confidence+'</span></p><button onclick="selectNode(\''+n.id+'\')">Resolve boundary</button></div>').join('')||'<p class="empty">No unresolved observable boundaries.</p>';const stale=data.decisions.filter(d=>d.invalidated),unmatched=data.evidence.filter(e=>e.nodeIds.length===0);document.querySelector('#stale').innerHTML=(stale.length?'<p class="invalidated">'+stale.length+' invalidated decision(s)</p>':'')+(unmatched.length?'<p class="inferred">'+unmatched.length+' unmatched evidence record(s)</p>':'')||'<p class="empty">No stale decisions or unmatched evidence.</p>';renderSlice()}
function showSlice(id){sliceRoot=id;renderSystem();selectNode(id)}
function renderSlice(){let ids;if(sliceRoot){ids=new Set([sliceRoot]);let changed=true;while(changed){changed=false;data.edges.forEach(e=>{if(ids.has(e.from)&&!ids.has(e.to)){ids.add(e.to);changed=true}})}const root=data.nodes.find(n=>n.id===sliceRoot);document.querySelector('#sliceTitle').textContent='Capability topology · '+root.name}else{ids=new Set(data.nodes.map(n=>n.id));document.querySelector('#sliceTitle').textContent='System topology'}const edges=data.edges.filter(e=>ids.has(e.from)&&ids.has(e.to)&&e.kind!=='contains'),names=new Map(data.nodes.map(n=>[n.id,n.name]));document.querySelector('#slice').innerHTML=edges.map(e=>'<div class="edge"><b>'+esc(names.get(e.from)||e.from)+'</b><p class="muted">'+e.kind+' →</p><b>'+esc(names.get(e.to)||e.to)+'</b><br><button onclick="selectEdge(\''+e.id+'\')">Evidence</button></div>').join('')||'<p class="empty">No dependency edges in this view.</p>'}
function sourceButtons(n){return n.sources.map((s,i)=>'<p class="muted">'+esc(s.path)+':'+(s.startLine||1)+'<br><code>'+s.contentHash.slice(0,16)+'</code><br><button onclick="showSource(\''+n.id+'\','+i+')">View source evidence</button></p>').join('')}
function selectNode(id){selected=id;renderList();const n=data.nodes.find(x=>x.id===id),d=data.decisions.find(x=>x.subjectId===id&&!x.invalidated),out=data.edges.filter(e=>e.from===id),inc=data.edges.filter(e=>e.to===id),names=new Map(data.nodes.map(x=>[x.id,x.name]));document.querySelector('#detail').innerHTML='<h2>'+esc(n.name)+'</h2><p><span class="badge">'+n.kind+'</span> <span class="'+n.confidence+'">'+n.confidence+'</span></p><pre>'+esc(JSON.stringify(n.attributes,null,2))+'</pre><h3>Relationships</h3>'+[...out,...inc].map(e=>'<p class="muted"><button onclick="selectEdge(\''+e.id+'\')">'+(e.from===id?'→ '+e.kind:'← '+e.kind)+'</button> '+esc(names.get(e.from===id?e.to:e.from)||'unknown')+'</p>').join('')+'<h3>Provenance</h3>'+sourceButtons(n)+'<div id="source"></div><h3>Review</h3><input id="value" placeholder="rename value or merge target node ID" value="'+esc(d?.value||'')+'"><textarea id="reason" placeholder="Reason (required for reject and mark-opaque)">'+esc(d?.reason||'')+'</textarea>'+['approve','reject','rename','merge','mark-opaque'].map(a=>'<button onclick="decide(\''+a+'\')">'+a+'</button>').join('')+(d?'<p>Current: <span class="'+d.action+'">'+d.action+'</span> by '+esc(d.reviewer||'unknown')+'</p>':'')}
function selectEdge(id){const e=data.edges.find(x=>x.id===id),names=new Map(data.nodes.map(n=>[n.id,n.name]));document.querySelector('#detail').innerHTML='<h2>Edge evidence</h2><p><b>'+esc(names.get(e.from)||e.from)+'</b> '+esc(e.kind)+' <b>'+esc(names.get(e.to)||e.to)+'</b></p><p>'+e.confidence+'</p><h3>Provenance</h3>'+e.sources.map(s=>'<p class="muted">'+esc(s.path)+':'+(s.startLine||1)+'<br><code>'+s.contentHash.slice(0,16)+'</code></p>').join('')}
async function showSource(nodeId,index){const response=await fetch('/api/source?nodeId='+encodeURIComponent(nodeId)+'&sourceIndex='+index);if(!response.ok){document.querySelector('#source').innerHTML='<p class="opaque">'+esc(await response.text())+'</p>';return}const value=await response.json();document.querySelector('#source').innerHTML='<pre>'+value.lines.map(l=>'<span class="source-line"><span>'+l.number+'</span><span>'+(l.highlight?'<mark>'+esc(l.text)+'</mark>':esc(l.text))+'</span></span>').join('')+'</pre>'}
async function decide(action){const value=document.querySelector('#value').value.trim(),reason=document.querySelector('#reason').value.trim();const response=await fetch('/api/decisions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({subjectId:selected,action,...(value?{value}:{}),...(reason?{reason}:{})})});if(!response.ok){alert(await response.text());return}await load()}
['filter','kind','confidence','module','resolution'].forEach(id=>document.querySelector('#'+id).addEventListener(id==='filter'?'input':'change',renderList));load().catch(error=>{document.body.innerHTML='<pre>'+esc(error.message)+'</pre>'});
</script></body></html>`;

async function body(request: import("node:http").IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (chunks.reduce((size, chunk) => size + chunk.length, 0) > 64 * 1024) throw new Error("Request body is too large.");
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function activeSource(bundle: DiscoveryBundle, nodeId: string, sourceIndex: number): { readonly node: DiscoveryNode; readonly source: SourceSpan } {
  const node = bundle.nodes.find((candidate) => candidate.id === nodeId);
  const source = node?.sources[sourceIndex];
  if (!node || !source) throw new Error("Unknown source evidence.");
  return { node, source };
}

async function sourceExcerpt(bundle: DiscoveryBundle, nodeId: string, sourceIndex: number): Promise<Record<string, unknown>> {
  const { source } = activeSource(bundle, nodeId, sourceIndex);
  if (isAbsolute(source.path)) throw new Error("Source evidence must be repository-relative.");
  const repository = await realpath(bundle.manifest.metadata.repository);
  const path = await realpath(resolve(repository, source.path));
  const contained = relative(repository, path);
  if (contained.startsWith("..") || isAbsolute(contained)) throw new Error("Source evidence escapes the repository.");
  if ((await stat(path)).size > 1024 * 1024) throw new Error("Source evidence is too large to preview.");
  const contents = await readFile(path, "utf8");
  if (contentHash(contents) !== source.contentHash) throw new Error("Source evidence changed after discovery; rescan before review.");
  const allLines = contents.split(/\r?\n/u);
  const focus = Math.max(1, source.startLine ?? 1);
  const start = Math.max(1, focus - 7);
  const end = Math.min(allLines.length, Math.max(source.endLine ?? focus, focus) + 7);
  const lines = allLines.slice(start - 1, end).map((text, offset) => ({ number: start + offset, text, highlight: start + offset >= focus && start + offset <= (source.endLine ?? focus) }));
  return { path: source.path, startLine: focus, endLine: source.endLine ?? focus, contentHash: source.contentHash, lines };
}

export async function startWorkbench(directory: string, options: { readonly reviewer: string; readonly host?: string; readonly port?: number }): Promise<{ readonly server: Server; readonly url: string }> {
  const host = options.host ?? "127.0.0.1";
  const reviewer = options.reviewer.trim();
  if (!reviewer) throw new Error("A non-empty workbench reviewer identity is required.");
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") throw new Error("The discovery workbench binds to loopback only; use a self-hosted reverse proxy for remote access.");
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${host === "::1" ? "[::1]" : host}`);
      if (request.method === "GET" && url.pathname === "/") { response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" }); response.end(HTML); return; }
      if (request.method === "GET" && url.pathname === "/api/discovery") { const payload = JSON.stringify(await readDiscoveryBundle(directory)); response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(payload); return; }
      if (request.method === "GET" && url.pathname === "/api/source") {
        const nodeId = url.searchParams.get("nodeId");
        const sourceIndex = Number(url.searchParams.get("sourceIndex") ?? "0");
        if (!nodeId || !Number.isSafeInteger(sourceIndex) || sourceIndex < 0) throw new Error("Invalid source request.");
        const payload = JSON.stringify(await sourceExcerpt(await readDiscoveryBundle(directory), nodeId, sourceIndex));
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }); response.end(payload); return;
      }
      if (request.method === "POST" && url.pathname === "/api/decisions") {
        const input = await body(request) as Partial<ReviewerDecision>;
        if (typeof input.subjectId !== "string" || !["approve", "reject", "rename", "merge", "mark-opaque"].includes(String(input.action))) throw new Error("Invalid reviewer decision.");
        const value = typeof input.value === "string" ? input.value.trim() : "";
        const reason = typeof input.reason === "string" ? input.reason.trim() : "";
        if ((input.action === "rename" || input.action === "merge") && !value) throw new Error(`${input.action} requires a value.`);
        if ((input.action === "reject" || input.action === "mark-opaque") && !reason) throw new Error(`${input.action} requires a reason.`);
        const bundle = await readDiscoveryBundle(directory);
        const node = bundle.nodes.find((candidate) => candidate.id === input.subjectId);
        if (!node) throw new Error("Unknown discovery subject.");
        if (input.action === "merge" && (!bundle.nodes.some((candidate) => candidate.id === value) || value === node.id)) throw new Error("Merge requires another existing node ID.");
        await saveDecision(directory, { subjectId: input.subjectId, action: input.action as ReviewerDecision["action"], ...(value ? { value } : {}), ...(reason ? { reason } : {}), evidenceHash: evidenceHash(node.sources), decidedAt: new Date().toISOString(), reviewer });
        response.writeHead(204); response.end(); return;
      }
      response.writeHead(404, { "content-type": "text/plain" }); response.end("Not found");
    } catch (error) {
      if (!response.headersSent) response.writeHead(400, { "content-type": "text/plain", "cache-control": "no-store" });
      if (!response.writableEnded) response.end(error instanceof Error ? error.message : "The workbench request could not be processed.");
    }
  });
  await new Promise<void>((resolvePromise, reject) => { server.once("error", reject); server.listen(options.port ?? 4319, host, () => resolvePromise()); });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : options.port ?? 4319;
  return { server, url: `http://${host === "::1" ? "[::1]" : host}:${port}` };
}
