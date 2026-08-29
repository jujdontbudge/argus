import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { convergePushHooks } from "./hooks";

/**
 * #103. Argus delimits its region of Codex's config.toml with COMMENT markers,
 * and TOML does not respect comments as scope. These tests pin the property the
 * markers are supposed to imply but cannot enforce on their own: a converge may
 * only remove the key Argus itself wrote. Every foreign key, table and comment
 * survives, wherever it sits relative to the markers.
 */

interface Scratch {
  codexHome: string;
  repo: string;
  root: string;
}

const scratches: string[] = [];

async function scratch(): Promise<Scratch> {
  const root = await mkdtemp(join(tmpdir(), "argus-103-"));
  scratches.push(root);
  const codexHome = join(root, "codex");
  const repo = join(root, "repo");
  await mkdir(codexHome, { recursive: true });
  await mkdir(repo, { recursive: true });
  return { codexHome, repo, root };
}

async function converge(place: Scratch): Promise<string> {
  await convergePushHooks({ codexHome: place.codexHome, repo: place.repo });
  return await Bun.file(join(place.codexHome, "config.toml")).text();
}

async function seed(place: Scratch, config: string): Promise<void> {
  await Bun.write(join(place.codexHome, "config.toml"), config);
}

/** The block as `argus up` writes it, for hand-building the damaged shapes. */
function blockOf(config: string): string {
  const begin = config.indexOf("# argus:notify:begin");
  const end = config.indexOf("# argus:notify:end");
  return config.slice(begin, end + "# argus:notify:end".length);
}

describe("codex config managed-block boundary (#103)", () => {
  test("keeps a foreign key appended immediately after the end-marker", async () => {
    const place = await scratch();
    const first = await converge(place);
    await seed(place, `${first.trimEnd()}\ntrust_level = "trusted"\n`);

    const second = await converge(place);

    expect(second).toContain('trust_level = "trusted"');
  });

  test("keeps a foreign key after the end-marker when a later table exists", async () => {
    const place = await scratch();
    await seed(place, '[profiles.luna]\nmodel = "gpt-5.6-sol"\n');
    const first = await converge(place);
    const damaged = first.replace(
      "# argus:notify:end\n",
      '# argus:notify:end\napprovals = "never"\n',
    );
    await seed(place, damaged);

    const second = await converge(place);

    expect(second).toContain('approvals = "never"');
    expect(second).toContain("[profiles.luna]");
    expect(second).toContain('model = "gpt-5.6-sol"');
  });

  test("keeps a whole foreign table appended after the block", async () => {
    const place = await scratch();
    const first = await converge(place);
    await seed(
      place,
      `${first.trimEnd()}\n\n[projects."/tmp/widgets"]\ntrust_level = "trusted"\n`,
    );

    const second = await converge(place);

    expect(second).toContain('[projects."/tmp/widgets"]');
    expect(second).toContain('trust_level = "trusted"');
  });

  test("keeps a foreign table that a TOML round-trip left INSIDE the markers", async () => {
    // The shape #99 actually observed: a comment-preserving TOML writer appended
    // [projects."..."] to the document and left Argus's dangling end-marker
    // comment trailing it, so the foreign table is between begin and end.
    const place = await scratch();
    await seed(place, 'model = "gpt-5.6-sol"\nsandbox_mode = "workspace-write"\n');
    const first = await converge(place);
    const block = blockOf(first);
    const damaged = first.replace(
      block,
      block.replace(
        "\n# argus:notify:end",
        '\n\n[projects."/private/tmp/argus-99-run/repo"]\ntrust_level = "trusted"\n# argus:notify:end',
      ),
    );
    await seed(place, damaged);

    const second = await converge(place);

    expect(second).toContain('[projects."/private/tmp/argus-99-run/repo"]');
    expect(second).toContain('trust_level = "trusted"');
    expect(second).toContain('model = "gpt-5.6-sol"');
    expect(second).toContain('sandbox_mode = "workspace-write"');
  });

  test("stays a converger: a second run over a repaired file changes nothing", async () => {
    const place = await scratch();
    await seed(place, 'model = "gpt-5.6-sol"\n\n[profiles.luna]\nmodel = "gpt-5.6-sol"\n');
    const first = await converge(place);
    await seed(
      place,
      `${first.trimEnd()}\n\n[projects."/tmp/widgets"]\ntrust_level = "trusted"\n`,
    );

    const second = await converge(place);
    const third = await converge(place);

    expect(third).toBe(second);
    expect(second.match(/# argus:notify:begin/g)).toHaveLength(1);
    expect(second.match(/# argus:notify:end/g)).toHaveLength(1);
    expect(second.match(/^notify = /gm)).toHaveLength(1);
  });

  test("wraps a foreign root notify once and preserves it as the delegate", async () => {
    const place = await scratch();
    await seed(place, 'notify = ["/bin/echo", "stale"]\nmodel = "gpt-5.6-sol"\n');

    const first = await converge(place);
    const second = await converge(place);
    const notify = (Bun.TOML.parse(second) as { notify: string[] }).notify;
    const flag = notify.indexOf("--delegate");
    const delegate = JSON.parse(
      Buffer.from(notify[flag + 1]!, "base64url").toString("utf8"),
    );

    expect(second).toBe(first);
    expect(second.match(/^notify = /gm)).toHaveLength(1);
    expect(second).toContain("scripts/codex-notify.ts");
    expect(delegate).toEqual(["/bin/echo", "stale"]);
  });

  test("forwards the exact payload to the previous notifier", async () => {
    const place = await scratch();
    const delegate = join(place.root, "delegate.ts");
    const received = join(place.root, "received.json");
    await Bun.write(
      delegate,
      'await Bun.write(process.argv[2]!, process.argv[3] ?? "");\n',
    );
    await seed(
      place,
      `notify = ${JSON.stringify([process.execPath, delegate, received])}\n`,
    );
    const config = await converge(place);
    const notify = (Bun.TOML.parse(config) as { notify: string[] }).notify;
    const payload = JSON.stringify({
      type: "agent-turn-complete",
      "thread-id": "notify-preservation",
      cwd: place.repo,
      "last-assistant-message": "done",
    });

    const child = Bun.spawn([...notify, payload], {
      cwd: place.repo,
      env: Bun.env,
      stderr: "pipe",
      stdout: "pipe",
    });
    expect(await child.exited).toBe(0);
    expect(await Bun.file(received).text()).toBe(payload);
  });

  test("leaves a notify key that belongs to a profile table alone", async () => {
    const place = await scratch();
    await seed(place, '[profiles.luna]\nnotify = ["/bin/echo", "profile"]\n');

    const config = await converge(place);

    expect(config).toContain('notify = ["/bin/echo", "profile"]');
    expect(config.match(/^notify = /gm)).toHaveLength(2);
  });
});

process.on("exit", () => {
  for (const root of scratches) void rm(root, { force: true, recursive: true });
});
