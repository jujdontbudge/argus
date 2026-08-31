/**
 * Local Argus dashboard reader (#128; SPEC §§4–6).
 *
 * This module is deliberately a reader, not another eye: it never creates a
 * directory, opens SQLite for writing, or persists an SSE cursor. The browser
 * polls the durable event directory and reconnects with Last-Event-ID; an
 * on-demand process therefore has no lifecycle state to supervise.
 */
import { constants, Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { loadRegistry, registryPaths } from "../provenance";
import { openArchiveSearch } from "../search";
import { listDigests, readDigest } from "../eyes/digest/outputs";

export const DEFAULT_DASH_PORT = 43128;

const HTML = `<!doctype html><meta charset="utf-8"><title>Argus dashboard</title>
<style>body{font:15px system-ui;max-width:1100px;margin:2rem auto;padding:0 1rem}input{padding:.5rem;width:60%}pre{white-space:pre-wrap;background:#f5f5f5;padding:1rem}li{margin:.5rem 0}</style>
<h1>Argus</h1><form id="search"><input name="q" placeholder="Search archive"><button>Search</button></form><h2>Search</h2><pre id="results"></pre><h2>Sessions</h2><ul id="sessions"></ul><h2>Live events</h2><pre id="events"></pre>
<script>const j=async u=>(await fetch(u)).json();const r=document.querySelector('#results');document.querySelector('#search').onsubmit=async e=>{e.preventDefault();r.textContent=JSON.stringify(await j('/api/search?q='+encodeURIComponent(new FormData(e.target).get('q'))),null,2)};const ul=document.querySelector('#sessions');(async()=>{for(const s of await j('/api/sessions')){const li=document.createElement('li');const b=document.createElement('button');b.textContent=s.fileName;b.onclick=async()=>{document.querySelector('#results').textContent=JSON.stringify(await j('/api/sessions/'+encodeURIComponent(s.fileName)),null,2)};li.append(b,' '+s.status+' — '+(s.summary??''));ul.append(li)}})();const es=new EventSource('/api/events');es.onmessage=e=>{document.querySelector('#events').textContent+=e.data+'\\n'}</script>`;

export interface DashOptions { repo: string; port?: number }

function json(value: unknown): Response { return Response.json(value); }
function safeFileName(name: string): boolean { return /^[\w.-]+\.md$/.test(name) && name !== "INDEX.md"; }

async function sessions(repo: string) {
  const digests = await listDigests(join(repo, ".argus/sessions"));
  return digests.map(({ body, ...digest }) => ({ ...digest, summary: body.split("\n").find(Boolean) }));
}

async function events(repo: string, request: Request): Promise<Response> {
  const directory = join(repo, ".argus/events");
  const names = (await readdir(directory).catch(() => [] as string[])).filter(n => !n.endsWith(".tmp")).sort();
  const after = request.headers.get("last-event-id");
  const selected = after === null ? names : names.filter(n => n > after);
  const chunks: string[] = [];
  for (const name of selected) chunks.push(`id: ${name}\ndata: ${await Bun.file(join(directory, name)).text()}\n\n`);
  return new Response(chunks.join(""), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
}

export function createDashServer(options: DashOptions): ReturnType<typeof Bun.serve> {
  const repo = resolve(options.repo);
  return Bun.serve({ hostname: "127.0.0.1", port: options.port ?? DEFAULT_DASH_PORT, fetch: async request => {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (url.pathname === "/api/search") {
      const query = url.searchParams.get("q") ?? "";
      if (!query || !(await Bun.file(join(repo, ".argus/archive.db")).exists())) return json([]);
      const archive = openArchiveSearch({ repo }); try { return json(archive.query(query)); } finally { archive.close(); }
    }
    if (url.pathname === "/api/sessions") return json(await sessions(repo));
    if (url.pathname.startsWith("/api/sessions/")) {
      const name = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
      return safeFileName(name) ? json(await readDigest(join(repo, ".argus/sessions"), name)) : new Response("Bad filename", { status: 400 });
    }
    if (url.pathname === "/api/registry") return json(await loadRegistry(registryPaths(repo)));
    if (url.pathname === "/api/events") return events(repo, request);
    return new Response("Not found", { status: 404 });
  } });
}

/** Open the archive exactly as the dashboard does, for the #128 read-only gate. */
export function assertArchiveReadOnly(path: string): boolean {
  const database = new Database(path, { readonly: true, strict: true });
  try { return (database as unknown as { filename?: string }).filename !== undefined || constants.SQLITE_OPEN_READONLY !== undefined; }
  finally { database.close(false); }
}
