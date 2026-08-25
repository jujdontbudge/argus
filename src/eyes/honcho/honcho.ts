import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";

import type { ProvenanceRecord } from "../../provenance";
import type {
  HonchoIngestionClient,
  HonchoMessageInput,
  HonchoPeerId,
  HonchoPeerInput,
  HonchoSessionInput,
} from "../../up/bindings";
import {
  fileAlertEmitter,
  retryForever,
  type RetryForeverOptions,
  type StuckAlert,
} from "../backpressure";

const PEERS: readonly HonchoPeerInput[] = [
  { id: "johan" },
  { configuration: { observe_me: false }, id: "claude-code" },
  { configuration: { observe_me: false }, id: "codex" },
  { configuration: { observe_me: false }, id: "hermes" },
];

const SESSION_PEERS: HonchoSessionInput["peers"] = {
  johan: {},
  "claude-code": {},
  codex: {},
  hermes: {},
};

interface HonchoBinding {
  url: string;
  workspace: string;
}

interface QueuedMessage {
  id: number;
  message: HonchoMessageInput;
  session: HonchoSessionInput;
}

interface QueueState {
  version: 1;
  nextId: number;
  messages: QueuedMessage[];
}

export interface HonchoEyeOptions {
  /** Repo root containing the `.argus/honcho.yaml` binding from `argus up`. */
  repo: string;
  /** Ticket #28's shared binding/ingestion client; tests inject a fake here. */
  client: HonchoIngestionClient;
  /** Defaults true. Tests and manually driven callers may explicitly drain. */
  autoFlush?: boolean;
  onAlert?: (alert: StuckAlert) => void | Promise<void>;
  retry?: Omit<RetryForeverOptions, "eye" | "onAlert">;
}

function unquote(value: string): string {
  return value.replace(/^(['"])(.*)\1$/, "$2");
}

export async function loadHonchoBinding(repo: string): Promise<HonchoBinding> {
  const path = join(repo, ".argus/honcho.yaml");
  const file = Bun.file(path);
  if (!(await file.exists())) {
    throw new Error(`Honcho binding is missing: ${path}`);
  }
  const values = new Map<string, string>();
  for (const line of (await file.text()).split(/\r?\n/)) {
    const match = line.match(/^(url|workspace):\s*([^#]+?)\s*(?:#.*)?$/);
    if (match?.[1] && match[2]) values.set(match[1], unquote(match[2].trim()));
  }
  const url = values.get("url");
  const workspace = values.get("workspace");
  if (!url || !workspace) {
    throw new Error(`Honcho binding must contain url and workspace: ${path}`);
  }
  return { url, workspace };
}

function peerFor(record: ProvenanceRecord): HonchoPeerId | null {
  if (record.author === "johan") return "johan";
  if (record.author === "hermes") return "hermes";
  if (record.author === "system") return null;
  if (record.agent === "claude" || record.agent === "claude-code") {
    return "claude-code";
  }
  if (record.agent === "codex") return "codex";
  throw new Error(
    `Honcho cannot route agent-authored message for '${record.agent ?? "unknown"}'`,
  );
}

function queuedMessage(record: ProvenanceRecord): Omit<QueuedMessage, "id"> | null {
  const peer = peerFor(record);
  if (peer === null) return null;
  const metadata: HonchoMessageInput["metadata"] = {
    provenance: record.author,
    via: record.via,
    session_id: record.sessionId,
    registered: record.registered,
    started_by: record.startedBy,
    johan_touched: record.johanTouched,
    timestamp: record.ts,
    source_file: record.event.file,
  };
  if (record.agent !== undefined) metadata.agent = record.agent;
  if (record.ticket !== undefined) metadata.ticket = record.ticket;
  if (record.event.uuid !== undefined) metadata.source_uuid = record.event.uuid;

  const sessionMetadata: Record<string, string> = {};
  if (record.agent !== undefined) sessionMetadata.agent = record.agent;
  if (record.ticket !== undefined) sessionMetadata.ticket = record.ticket;
  return {
    message: { peer_id: peer, content: record.text, metadata },
    session: {
      id: record.sessionId,
      metadata: sessionMetadata,
      peers: SESSION_PEERS,
    },
  };
}

/**
 * Durable, at-least-once Honcho delivery. Queue removal happens only after a
 * successful API response; a crash in that narrow interval may duplicate a
 * message, but can never drop it.
 */
export class HonchoEye {
  readonly #autoFlush: boolean;
  readonly #binding: HonchoBinding;
  readonly #client: HonchoIngestionClient;
  readonly #onAlert: (alert: StuckAlert) => void | Promise<void>;
  readonly #repo: string;
  readonly #retry: Omit<RetryForeverOptions, "eye" | "onAlert">;
  readonly #statePath: string;
  #flushPromise: Promise<void> | null = null;
  #mutation: Promise<void> = Promise.resolve();
  #state: QueueState;

  private constructor(
    options: HonchoEyeOptions,
    binding: HonchoBinding,
    statePath: string,
    state: QueueState,
  ) {
    this.#repo = options.repo;
    this.#client = options.client;
    this.#binding = binding;
    this.#statePath = statePath;
    this.#state = state;
    this.#autoFlush = options.autoFlush ?? true;
    this.#onAlert =
      options.onAlert ?? fileAlertEmitter(join(options.repo, ".argus/events"));
    this.#retry = options.retry ?? {};
  }

  static async open(options: HonchoEyeOptions): Promise<HonchoEye> {
    const binding = await loadHonchoBinding(options.repo);
    const directory = join(options.repo, ".argus/eyes/honcho");
    const statePath = join(directory, "queue.json");
    await mkdir(directory, { recursive: true });
    const file = Bun.file(statePath);
    const state = (await file.exists())
      ? ((await file.json()) as QueueState)
      : { version: 1 as const, nextId: 1, messages: [] };
    const eye = new HonchoEye(options, binding, statePath, state);
    if (eye.#autoFlush && state.messages.length > 0) eye.#startFlush();
    return eye;
  }

  async #locked<T>(operation: () => Promise<T> | T): Promise<T> {
    const result = this.#mutation.then(operation, operation);
    this.#mutation = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  async #persist(): Promise<void> {
    const temporaryPath = `${this.#statePath}.tmp`;
    await Bun.write(temporaryPath, `${JSON.stringify(this.#state, null, 2)}\n`);
    await rename(temporaryPath, this.#statePath);
  }

  async ingest(records: readonly ProvenanceRecord[]): Promise<void> {
    const pending = records
      .map(queuedMessage)
      .filter((message): message is Omit<QueuedMessage, "id"> => message !== null);
    if (pending.length === 0) return;
    await this.#locked(async () => {
      for (const message of pending) {
        this.#state.messages.push({ id: this.#state.nextId++, ...message });
      }
      await this.#persist();
    });
    if (this.#autoFlush) this.#startFlush();
  }

  async pendingCount(): Promise<number> {
    return this.#locked(() => this.#state.messages.length);
  }

  #startFlush(): void {
    void this.flush().catch((error) => {
      console.error(
        `Honcho eye flush stopped: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  flush(): Promise<void> {
    if (this.#flushPromise !== null) return this.#flushPromise;
    const running = this.#drain();
    this.#flushPromise = running.finally(() => {
      this.#flushPromise = null;
      if (this.#autoFlush && this.#state.messages.length > 0) this.#startFlush();
    });
    return this.#flushPromise;
  }

  async #headBatch(): Promise<QueuedMessage[]> {
    return this.#locked(() => {
      const first = this.#state.messages[0];
      if (first === undefined) return [];
      const batch: QueuedMessage[] = [];
      for (const queued of this.#state.messages) {
        if (queued.session.id !== first.session.id || batch.length === 100) break;
        batch.push(queued);
      }
      return batch;
    });
  }

  async #deliver(batch: readonly QueuedMessage[]): Promise<void> {
    const first = batch[0];
    if (first === undefined) return;
    await this.#client.ensureWorkspace({
      id: this.#binding.workspace,
      metadata: { repo: this.#repo },
    });
    for (const peer of PEERS) {
      await this.#client.ensurePeer(this.#binding.workspace, peer);
    }
    await this.#client.ensureSession(this.#binding.workspace, first.session);

    // Honcho's Deriver intentionally waits for either 512 tokens or 30 minutes.
    // Successful ingest is the watcher gate; an empty representation is not a hang.
    await this.#client.createMessages(
      this.#binding.workspace,
      first.session.id,
      batch.map(({ message }) => message),
    );
    await this.#locked(async () => {
      const delivered = new Set(batch.map(({ id }) => id));
      while (
        this.#state.messages[0] !== undefined &&
        delivered.has(this.#state.messages[0]!.id)
      ) {
        this.#state.messages.shift();
      }
      await this.#persist();
    });
  }

  async #drain(): Promise<void> {
    for (;;) {
      const batch = await this.#headBatch();
      if (batch.length === 0) return;
      await retryForever(() => this.#deliver(batch), {
        ...this.#retry,
        eye: "honcho",
        onAlert: this.#onAlert,
      });
    }
  }
}
