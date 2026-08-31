/**
 * Ticket #126 — the sole compatibility pin for the Hermes surfaces Argus reads.
 *
 * These values are evidence, not a desired-version setting: the #47 live gate
 * is the authority that may justify changing them. Keeping both anchors here
 * makes `argus up` warn when either the CLI or its state database moves ahead
 * of a verified run, without making an upgrade a deployment blocker.
 */

/** The exact first line emitted by the Hermes CLI during the verified run. */
export const VERIFIED_HERMES_CLI_VERSION = "Hermes Agent v0.16.0 (2026.6.5)";

/** Hermes' state.db schema observed by the same verified run. */
export const VERIFIED_HERMES_SCHEMA_VERSION = 15;
