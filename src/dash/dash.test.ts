import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createDashServer } from "./dash";
import { openArchiveSearch } from "../search";

async function treeHash(root: string): Promise<string> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path); else files.push(path);
    }
  }
  await visit(root);
  const hash = createHash("sha256");
  for (const path of files.sort()) hash.update(path.slice(root.length) + "\0").update(Buffer.from(await Bun.file(path).arrayBuffer()));
  return hash.digest("hex");
}

describe("dashboard reader (#128)", () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  afterEach(() => { for (const server of servers) server.stop(true); servers.length = 0; });

  test("serves HTML, registry, sessions, search and events without writing .argus", async () => {
    const repo = await mkdtemp(join(tmpdir(), "argus-dash-"));
    await mkdir(join(repo, ".argus/sessions"), { recursive: true });
    await mkdir(join(repo, ".argus/registry"), { recursive: true });
    await mkdir(join(repo, ".argus/events"), { recursive: true });
    const archive = new Database(join(repo, ".argus/archive.db"));
    archive.exec("CREATE TABLE archive_messages (id INTEGER PRIMARY KEY, session_id TEXT, agent TEXT, role TEXT, provenance TEXT, ts TEXT, ticket TEXT, content TEXT);");
    archive.exec("CREATE VIRTUAL TABLE archive_messages_fts USING fts5(content, content='archive_messages', content_rowid='id');");
    archive.exec("INSERT INTO archive_messages VALUES (1, 's1', 'codex', 'assistant', 'agent', '2026-08-31', NULL, 'hello dashboard'); INSERT INTO archive_messages_fts(rowid,content) VALUES (1,'hello dashboard');"); archive.close();
    await writeFile(join(repo, ".argus/sessions/adhoc-s1.md"), "---\nagent: codex\nstatus: running\nstarted_by: johan\njohan_touched: false\n---\nA session\n");
    await writeFile(join(repo, ".argus/registry/sessions.jsonl"), JSON.stringify({ ts: "2026-08-31", sessionId: "s1", dispatchPrompt: "work", agent: "codex" }) + "\n");
    await writeFile(join(repo, ".argus/events/e1.json"), '{"type":"done"}');
    const before = await treeHash(join(repo, ".argus"));
    const archiveReader = openArchiveSearch({ repo });
    expect(() => (archiveReader as unknown as { database: Database }).database.exec("INSERT INTO archive_messages VALUES (2,'s2','x','user','x','x',NULL,'x')")).toThrow();
    archiveReader.close();
    const server = createDashServer({ repo, port: 0 }); servers.push(server);
    const base = `http://${server.hostname}:${server.port}`;
    expect((await fetch(base)).status).toBe(200);
    expect((await (await fetch(base + "/api/search?q=dashboard")).json()).length).toBe(1);
    expect((await (await fetch(base + "/api/search?q=missing")).json()).length).toBe(0);
    expect((await (await fetch(base + "/api/sessions")).json()).length).toBe(1);
    expect((await (await fetch(base + "/api/sessions/adhoc-s1.md")).json()).body).toContain("A session");
    expect((await fetch(base + "/api/sessions/..%2Farchive.db")).status).toBe(400);
    expect((await (await fetch(base + "/api/registry")).json()).sessions.length).toBe(1);
    const firstEvents = await (await fetch(base + "/api/events")).text();
    expect(firstEvents).toContain("retry: 1000");
    expect(firstEvents).toContain("id: e1.json");
    const afterFirst = await treeHash(join(repo, ".argus"));
    await writeFile(join(repo, ".argus/events/e2.json"), '{"type":"later"}');
    const beforeSecond = await treeHash(join(repo, ".argus"));
    const secondEvents = await (await fetch(base + "/api/events", { headers: { "Last-Event-ID": "e1.json" } })).text();
    expect(secondEvents).toContain("id: e2.json");
    expect(secondEvents).not.toContain("id: e1.json");
    expect(afterFirst).toBe(before);
    expect(await treeHash(join(repo, ".argus"))).toBe(beforeSecond);
  });
});
