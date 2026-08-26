import { mkdir, readdir, realpath, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readEnabledRepos } from "./supervisor/registry.ts";
import { EYE_NAMES, type EyeName } from "./supervisor/runtime.ts";
import { classifierFromRegistry, loadRegistry, registryPaths } from "./provenance/index.ts";
import { Tailer, type TranscriptSource } from "./tailing/index.ts";
import { ProvenanceFeed } from "./eyes/source.ts";
import { parseArgusEvent } from "./events/schema.ts";
import { acquireWatchLease } from "./watch/lease.ts";
import { EyeHealthReporter } from "./supervisor/health.ts";
import { recordAudits } from "./audits/store.ts";

interface OpenWatcher {
  readonly resource: unknown;
  backlog(): number | Promise<number>;
  close?(): void;
  tick?(): Promise<unknown>;
}

export const DEFAULT_WATCH_MAX_RSS_MIB = 512;

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
  await mkdir(dirname(path), { recursive: true });
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
    const file = join(directory, name);
    const raw = await Bun.file(file).text();
    const parsed = parseArgusEvent(raw);
    if (parsed === null) {
      await recordAudits(repo, "digest", [
        {
          type: "event-malformed",
          file,
          raw,
          reason: "payload does not match Argus event schema version 1",
        },
      ]);
      continue;
    }
    if (parsed.repo !== repo) continue;
    await consume({
      kind:
        parsed.kind === "end-of-session" ? "session-end" : "session-blocked",
      sessionId: parsed.sessionId,
      ts: parsed.createdAt,
    });
    seen.add(name);
  }
}

async function reportAudits(
  eye: EyeName,
  repo: string,
  audits: readonly import("./provenance/index.ts").ProvenanceAudit[],
): Promise<void> {
  await recordAudits(repo, eye, audits);
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
  registryPath: string,
  health: EyeHealthReporter,
): Promise<OpenWatcher> {
  const cursorPath = join(repo, ".argus", "eyes", eye, "cursors.json");
  const feed = new ProvenanceFeed(
    source,
    repo,
    await loadCursors(cursorPath),
  );
  const ingest = async (
    consume: (batch: Awaited<ReturnType<ProvenanceFeed["catchUp"]>>) => Promise<void>,
  ): Promise<void> => {
    const batch = await feed.catchUp();
    await reportAudits(eye, repo, batch.audits);
    await consume(batch);
    await persistCursors(cursorPath, feed.cursors());
  };
  switch (eye) {
    case "reviewer": {
      const { openReviewer } = await import("./eyes/reviewer/reviewer.ts");
      let resource: Awaited<ReturnType<typeof openReviewer>>;
      resource = await openReviewer(repo, {
        signal,
        onFailure: ({ lastError }) =>
          health.failure(lastError, resource.pendingCount()),
      });
      return {
        resource,
        backlog: () => resource.pendingCount(),
        async tick() {
          await ingest((batch) => resource.ingest(batch.records));
          await resource.tick();
        },
      };
    }
    case "digest": {
      const { openDigest } = await import("./eyes/digest/digest.ts");
      let resource: Awaited<ReturnType<typeof openDigest>>;
      resource = await openDigest(repo, {
        signal,
        onFailure: ({ lastError }) =>
          health.failure(lastError, resource.pendingCount()),
      });
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
        backlog: () => resource.pendingCount(),
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
      let resource: Awaited<ReturnType<typeof openRetro>>;
      resource = await openRetro(repo, {
        signal,
        onFailure: ({ lastError }) =>
          health.failure(lastError, resource.dueAt() === null ? 0 : 1),
      });
      return {
        resource,
        backlog: () => (resource.dueAt() === null ? 0 : 1),
        async tick() {
          await ingest(async (batch) => {
            for (const session of batch.sessions) await resource.observeSession(session);
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
        backlog: () => 0,
        close: () => resource.close(),
        async tick() {
          const { classifier, audits } = classifierFromRegistry(
            await loadRegistry(registryPaths(repo)),
          );
          await reportAudits("archiver", repo, audits);
          await resource.catchUp(tailer, classifier);
        },
      };
    }
    case "honcho": {
      const { openHoncho } = await import("./eyes/honcho/honcho.ts");
      let resource: Awaited<ReturnType<typeof openHoncho>>;
      resource = await openHoncho(repo, {
        signal,
        retry: {
          onFailure: async ({ lastError }) =>
            health.failure(lastError, await resource.pendingCount()),
        },
      });
      return {
        resource,
        backlog: () => resource.pendingCount(),
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

function optionalPositiveInteger(value: string | undefined): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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
  const maxRssMiB = positiveInteger(
    process.env.ARGUS_WATCH_MAX_RSS_MB,
    DEFAULT_WATCH_MAX_RSS_MIB,
  );
  const maxRssBytes = maxRssMiB * 1024 * 1024;
  const ownerPid = optionalPositiveInteger(process.env.ARGUS_WATCH_OWNER_PID);
  let checkingEnrollment = false;
  const enrollmentMonitor = setInterval(async () => {
    if (checkingEnrollment || controller.signal.aborted) return;
    checkingEnrollment = true;
    try {
      if (!(await isEnrolled(registryPath, repo))) controller.abort();
    } catch (error) {
      console.error(
        `argus watch ${eye}: enrollment check failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      checkingEnrollment = false;
    }
  }, pollMilliseconds);
  let lease: Awaited<ReturnType<typeof acquireWatchLease>> | undefined;
  const health = new EyeHealthReporter(repo, eye);
  try {
    lease = await acquireWatchLease(
      repo,
      eye,
      controller.signal,
      pollMilliseconds,
    );
    if (lease === null) return 0;
    await health.start();
    while (!controller.signal.aborted) {
      if (ownerPid !== null && !processIsAlive(ownerPid)) {
        console.error(
          `argus watch ${eye}: harness owner pid ${ownerPid} is gone; exiting`,
        );
        return 0;
      }
      const rssBytes = process.memoryUsage().rss;
      if (rssBytes > maxRssBytes) {
        console.error(
          `argus watch ${eye}: RSS ceiling exceeded (${Math.ceil(rssBytes / 1024 / 1024)} MiB > ${maxRssMiB} MiB); exiting for supervised restart`,
        );
        return 0;
      }
      if (!(await isEnrolled(registryPath, repo))) return 0;
      try {
        source ??= await (
          await import("./eyes/source.ts")
        ).createRepoTranscriptSource(repo);
        watcher ??= await openEye(
          eye,
          repo,
          source,
          controller.signal,
          registryPath,
          health,
        );
        await watcher.tick?.();
        await health.success(await watcher.backlog());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await health.failure(message, watcher === undefined ? 0 : await watcher.backlog());
        console.error(
          `argus watch ${eye}: recoverable error: ${message}`,
        );
      }
      await Bun.sleep(pollMilliseconds);
    }
    return 0;
  } finally {
    watcher?.close?.();
    await lease?.release();
    clearInterval(enrollmentMonitor);
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
