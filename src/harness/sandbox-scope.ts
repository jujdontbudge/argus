/**
 * Ticket #49 — scripted scope, made explicit and enforceable.
 *
 * In #41's hermetic mode the harness's blast radius is an OS boundary: the
 * child gets a scratch HOME and a scratch CLAUDE_CONFIG_DIR, so a destructive
 * operation physically cannot reach Johan's state. Subscription mode gives
 * that up on purpose — a normal terminal Claude session runs under the REAL
 * home, because that is where its subscription credential already lives and
 * the only alternative is a token nobody asked for.
 *
 * What replaces the OS boundary is this module. Every destructive and
 * harness-side operation goes through a `SandboxScope`, which refuses by name
 * anything outside the sandbox root and any process this harness did not
 * itself spawn. That makes the safety property TESTABLE — `sandbox-scope.test`
 * asserts the refusals fire and, for the cases that matter, that the target
 * still exists afterwards — instead of leaving it as a convention that holds
 * only while everyone remembers it.
 *
 * The two guards answer the two ways a §13 scenario can escape:
 *
 *   - PATHS. Scenario 10 wipes a `.argus/` tree and the sandbox teardown
 *     removes a whole root. Both resolve symlinks first, because a lexical
 *     check passes happily on a symlink inside the sandbox that points at
 *     `~/.claude`.
 *   - PROCESSES. Scenario 6 SIGKILLs watchers. This machine also runs the
 *     production dispatcher and several live Claude sessions, so a kill that
 *     matched too broadly would take them out. A pid is killable only after
 *     `adopt`, which the harness calls for children it started itself.
 */
import { realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** Lexical containment: is `child` at or below `parent`? */
export function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(child));
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
  );
}

export class SandboxScope {
  readonly #adopted = new Set<number>();

  readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  /**
   * The cheap, synchronous guard: refuse a path outside the sandbox.
   *
   * `operation` is in the message on purpose — a refusal has to say WHICH
   * scripted step overreached, or the safety property reads as a mystery.
   */
  path(candidate: string, operation: string): string {
    if (!isWithin(this.root, candidate)) {
      throw new Error(
        `sandbox scope refused ${operation}: ${candidate} is outside ${this.root}`,
      );
    }
    return candidate;
  }

  /**
   * The guard destructive operations use: resolve symlinks, THEN decide.
   *
   * A missing leaf is normal — a scenario removes a path that may already be
   * gone — so the nearest existing ancestor is resolved instead and the tail
   * re-appended. That still catches the escape, because the escape is always
   * a link somewhere along the existing part of the path.
   */
  async resolved(candidate: string, operation: string): Promise<string> {
    const [realRoot, realCandidate] = await Promise.all([
      realpath(this.root),
      realpathNearest(candidate),
    ]);
    if (!isWithin(realRoot, realCandidate)) {
      throw new Error(
        `sandbox scope refused ${operation}: ${candidate} resolves to ${realCandidate}, outside ${realRoot}`,
      );
    }
    return candidate;
  }

  /** `rm -rf`, refused unless the target really lives in the sandbox. */
  async remove(target: string): Promise<void> {
    this.path(target, "remove");
    await this.resolved(target, "remove");
    await rm(target, { force: true, recursive: true });
  }

  /**
   * Record a pid this harness started. Only adopted pids are killable.
   *
   * An allowlist rather than a pattern match, because the thing that must
   * never happen is killing something that merely LOOKS like a harness
   * watcher — on this machine the near neighbours are the production
   * dispatcher and Johan's live Claude sessions.
   */
  adopt(pid: number): number {
    this.#adopted.add(pid);
    return pid;
  }

  /** The pids this scope is allowed to signal. */
  get adopted(): ReadonlySet<number> {
    return this.#adopted;
  }

  kill(pid: number, signal: NodeJS.Signals | number): void {
    if (!this.#adopted.has(pid)) {
      throw new Error(
        `sandbox scope refused kill: pid ${pid} was not spawned by this harness`,
      );
    }
    process.kill(pid, signal);
  }
}

/** `realpath` of the deepest existing ancestor, with the missing tail re-appended. */
async function realpathNearest(candidate: string): Promise<string> {
  const absolute = resolve(candidate);
  const missing: string[] = [];
  let cursor = absolute;
  for (;;) {
    try {
      return join(await realpath(cursor), ...missing.reverse());
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) return absolute;
      missing.push(cursor.slice(parent.length + 1));
      cursor = parent;
    }
  }
}

/** The part of a supervisor status snapshot the adoption rule reads. */
export interface AdoptableWatchers {
  watchers: ReadonlyArray<{ eye: string; pid: number; repo: string }>;
}

/**
 * Adopt exactly the watchers this sandbox's supervisor started.
 *
 * Scenario 6 kills watchers by pid, and a supervisor status file is not a
 * per-sandbox document — the production dispatcher supervises the REAL
 * `~/argus` on this same machine. Selecting by repo, and adopting before any
 * signal, is what keeps "kill each watcher mid-run" from reaching a watcher
 * that belongs to somebody else. Returns the pids now killable, in the order
 * the snapshot listed them.
 */
export function adoptSandboxWatchers(
  scope: SandboxScope,
  repo: string,
  status: AdoptableWatchers,
): number[] {
  return status.watchers
    .filter((watcher) => isWithin(repo, watcher.repo))
    .map((watcher) => scope.adopt(watcher.pid));
}
