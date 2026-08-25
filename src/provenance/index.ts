/**
 * Provenance (ticket #25; SPEC §5): the registry reader over
 * `.argus/registry/` and the one classifier every eye consumes.
 * `ProvenanceRecord` / `ProvenanceAudit` are the seam for tickets #30–#33.
 */
export {
  ProvenanceClassifier,
  type Author,
  type ClassifyOutput,
  type ProvenanceAuditEvent,
  type ProvenanceRecord,
  type SessionProvenance,
  type Via,
} from "./classifier";
export {
  loadRegistry,
  parseSendsJsonl,
  parseSessionsJsonl,
  registryPaths,
  type ParsedSends,
  type ParsedSessions,
  type Registry,
  type RegistryLineAudit,
  type RegistryPaths,
  type SendRecord,
  type SessionRecord,
} from "./registry";

import { ProvenanceClassifier, type ProvenanceAuditEvent } from "./classifier";
import type { Registry, RegistryLineAudit } from "./registry";

/** Everything provenance surfaces loudly: registry file problems + classifier audits. */
export type ProvenanceAudit = RegistryLineAudit | ProvenanceAuditEvent;

export interface ClassifierFromRegistry {
  classifier: ProvenanceClassifier;
  audits: ProvenanceAudit[];
}

/**
 * Build a classifier preloaded with a read registry. Sessions register before
 * sends so a deployment's follow-ups bind to its matcher; the registry's own
 * parse audits ride along.
 */
export function classifierFromRegistry(registry: Registry): ClassifierFromRegistry {
  const classifier = new ProvenanceClassifier();
  const audits: ProvenanceAudit[] = [...registry.audits];
  for (const session of registry.sessions) {
    audits.push(...classifier.registerSession(session));
  }
  for (const send of registry.sends) {
    audits.push(...classifier.recordSend(send));
  }
  return { classifier, audits };
}
