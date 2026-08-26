/**
 * Provenance (ticket #25; SPEC §5): the registry reader over
 * `.argus/registry/` and the one classifier every eye consumes.
 * `ProvenanceRecord` / `ProvenanceAudit` are the seam for tickets #30–#33.
 */
export {
  classifierFromRegistry,
  ProvenanceClassifier,
  type Author,
  type ClassifierFromRegistry,
  type ClassifyOutput,
  type ProvenanceAudit,
  type ProvenanceAuditEvent,
  type ProvenanceRecord,
  type SessionProvenance,
  type Via,
} from "./classifier";
export {
  appendDurably,
  appendSendRow,
  appendSessionRow,
  type SendRow,
  type SessionRow,
} from "./append";
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
export {
  createFixtureProvenanceDriver,
  poisoningScenario,
  registerProvenanceScenarios,
  takeoverScenario,
  unloggedSendScenario,
  type DeployOptions,
  type ProvenanceScenarioDriver,
  type ScenarioSessionHandle,
} from "./scenarios";
