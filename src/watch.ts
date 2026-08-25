import { mkdir, readdir, realpath, rename } from "node:fs/promises";
import { join } from "node:path";

import { readEnabledRepos } from "./supervisor/registry.ts";
import { EYE_NAMES, type EyeName } from "./supervisor/runtime.ts";
import { classifierFromRegistry, loadRegistry, registryPaths } from "./provenance/index.ts";
import { Tailer, type TranscriptSource } from "./tailing/index.ts";
import { ProvenanceFeed } from "./eyes/source.ts";
import { parseArgusEvent } from "./events/schema.ts";

interface OpenWatcher {
  readonly resource: unknown;
  close?(): void;
  tick?(): Promise<unknown>;
}

async function loadCursors(path: string): Promise<Record<string, number>> {
  try {
    const value = (await Bun.file(path).json()) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && entry[1] >= 0,
      ),
    );
  } catch {
    return {};
  }
}

async function persistCursors(
  path: string,
  cursors: Readonly<Record<string, number>>,
): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await Bun.write(temporary, `${JSON.stringify(cursors, null, 2)}\n`);
  await rename(temporary, path);
}

async function consumeLifecycleEvents(
  repo: string,
  seen: Set<string>,
  consume: (event: {
    kind: "session-end" | "session-blocked";
    sessionId: string;
    ts: string;
  }) => Promise<void>,
): Promise<void> {
  const directory = join(repo, ".argus", "events");
  const files = (await readdir(directory).catch(() => [] as string[])).sort();
  for (const name of files) {
    if (seen.has(name) || !name.endsWith(".json")) continue;
    const parsed = parseArgusEvent(await Bun.file(join(directory, name)).text());
    if (parsed === null || parsed.repo !== repo) continue;
    await consume({
      kind:
        parsed.kind === "end-of-session" ? "session-end" : "session-blocked",
      sessionId: parsed.sessionId,
      ts: parsed.createdAt,
    });
    seen.add(name);
  }
}

function reportAudits(eye: EyeName, audits: readonly unknown[]): void {
  for (const audit of audits) {
    console.error(`argus watch ${eye}: provenance audit: ${JSON.stringify(audit)}`);
  }
}

function isEyeName(value: string | undefined): value is EyeName {
  return EYE_NAMES.some((eye) => eye === value);
}

async function openEye(
  eye: EyeName,
  repo: string,
  source: TranscriptSource,
  signal: AbortSignal,
): Promise<OpenWatcher> {
  const cursorPath = join(repo, ".argus", "eyes", eye, "cursors.json");
  const feed = new ProvenanceFeed(source, repo, await loadCursors(cursorPath));
  const ingest = async (
    consume: (batch: Awaited<ReturnType<ProvenanceFeed["catchUp"]>>) => Promise<void>,
  ): Promise<void> => {
    const batch = await feed.catchUp();
    reportAudits(eye, batch.audits);
    await consume(batch);
    await persistCursors(cursorPath, feed.cursors());
  };
  switch (eye) {
    case "reviewer": {
      const { openReviewer } = await import("./eyes/reviewer/reviewer.ts");
      const resource = await openReviewer(repo, { signal });
      return {
        resource,
        async tick() {
          await ingest((batch) => resource.ingest(batch.records));
          await resource.tick();
        },
      };
    }
    case "digest": {
      const { openDigest } = await import("./eyes/digest/digest.ts");
      const resource = await openDigest(repo, { signal });
      const lifecyclePath = join(
        repo,
        ".argus",
        "eyes",
        "digest",
        "lifecycle.json",
      );
      const seenLifecycle = new Set(Object.keys(await loadCursors(lifecyclePath)));
      return {
        resource,
        async tick() {
          await ingest((batch) => resource.ingest(batch.records));
          await consumeLifecycleEvents(repo, seenLifecycle, (event) =>
            resource.ingestLifecycle(event),
          );
          await persistCursors(
            lifecyclePath,
            Object.fromEntries([...seenLifecycle].map((name) => [name, 1])),
          );
          await resource.tick();
        },
      };
    }
    case "retro": {
      const { openRetro } = await import("./eyes/retro/retro.ts");
      const resource = await openRetro(repo, { signal });
      return {
        resource,
        async tick() {
          await ingest(async (batch) => {
            for (const session of batch.sessions) resource.observeSession(session);
            await resource.ingest(batch.records);
          });
          await resource.tick();
        },
      };
    }
    case "archiver": {
      const { openArchiver } = await import("./eyes/archiver/archiver.ts");
      const resource = await openArchiver(repo);
      const tailer = new Tailer(source, { cursors: resource.cursors() });
      return {
        resource,
        close: () => resource.close(),
        async tick() {
          const { classifier, audits } = classifierFromRegistry(
            await loadRegistry(registryPaths(repo)),
          );
          for (const audit of audits) {
            console.error(`argus watch archiver: provenance audit: ${JSON.stringify(audit)}`);
          }
          await resource.catchUp(tailer, classifier);
        },
      };
    }
    case "honcho": {
      const { openHoncho } = await import("./eyes/honcho/honcho.ts");
      const resource = await openHoncho(repo, { signal });
      return {
        resource,
        close: () => resource.close(),
        tick: () => ingest((batch) => resource.ingest(batch.records)),
      };
    }
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function isEnrolled(registryPath: string, repo: string): Promise<boolean> {
  return (await readEnabledRepos(registryPath)).includes(repo);
}

async function runLoop(
  eye: EyeName,
  repo: string,
  registryPath: string,
): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let watcher: OpenWatcher | undefined;
  let source: TranscriptSource | undefined;
  const pollMilliseconds = positiveInteger(process.env.ARGUS_WATCH_POLL_MS, 250);
  try {
    while (!controller.signal.aborted) {
      if (!(await isEnrolled(registryPath, repo))) return 0;
      try {
        source ??= await (
          await import("./eyes/source.ts")
        ).createRepoTranscriptSource(repo);
        watcher ??= await openEye(eye, repo, source, controller.signal);
        await watcher.tick?.();
      } catch (error) {
        console.error(
          `argus watch ${eye}: recoverable error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await Bun.sleep(pollMilliseconds);
    }
    return 0;
  } finally {
    watcher?.close?.();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export async function runWatcher(args: string[]): Promise<number> {
  const eye = args[0];
  if (!isEyeName(eye)) {
    console.error(
      `argus watch: unknown eye '${eye ?? ""}'; expected one of ${EYE_NAMES.join(", ")}`,
    );
    return 1;
  }

  const repoFlag = args.indexOf("--repo");
  const requestedRepo = repoFlag === -1 ? undefined : args[repoFlag + 1];
  if (!requestedRepo) {
    console.error(`argus watch ${eye}: --repo is required`);
    return 1;
  }

  let repo: string;
  try {
    repo = await realpath(requestedRepo);
  } catch {
    console.error(`argus watch ${eye}: repo does not exist: ${requestedRepo}`);
    return 1;
  }

  const registryPath =
    process.env.ARGUS_REPOS_FILE ??
    (process.env.HOME ? join(process.env.HOME, ".argus-repos") : undefined);
  if (registryPath === undefined) {
    console.error(`argus watch ${eye}: HOME is not set`);
    return 1;
  }
  const enrolled = await readEnabledRepos(registryPath);
  if (!enrolled.includes(repo)) {
    console.error(`argus watch ${eye}: repo is not enrolled: ${repo}`);
    return 1;
  }

  return runLoop(eye, repo, registryPath);
}
