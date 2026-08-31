import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { createDashServer } from "./dash";

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
    const before = await Bun.file(join(repo, ".argus/sessions/adhoc-s1.md")).text();
    const server = createDashServer({ repo, port: 0 }); servers.push(server);
    const base = `http://${server.hostname}:${server.port}`;
    expect((await fetch(base)).status).toBe(200);
    expect((await (await fetch(base + "/api/search?q=dashboard")).json()).length).toBe(1);
    expect((await (await fetch(base + "/api/sessions")).json()).length).toBe(1);
    expect((await (await fetch(base + "/api/registry")).json()).sessions.length).toBe(1);
    expect((await fetch(base + "/api/events")).text()).resolves.toContain("id: e1.json");
    expect(await Bun.file(join(repo, ".argus/sessions/adhoc-s1.md")).text()).toBe(before);
  });
});
