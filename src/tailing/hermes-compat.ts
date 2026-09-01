/**
 * Ticket #126 — the sole compatibility pin for the Hermes surfaces Argus reads.
 *
 * These values are evidence, not a desired-version setting: the #47 live gate
 * is the authority that may justify changing them. Keeping both anchors here
 * makes `argus up` warn when either the CLI or its state database moves ahead
 * of a verified run, without making an upgrade a deployment blocker. The CLI
 * pin is the stable version prefix only; Hermes appends ` · upstream <hash>`
 * for the remote tip, which identifies origin state rather than the install.
 */

/** The stable version prefix emitted by the Hermes CLI during verification. */
export const VERIFIED_HERMES_CLI_VERSION = "Hermes Agent v0.21.0 (2026.8.31)";

/** Hermes' state.db schema observed by the same verified run. */
export const VERIFIED_HERMES_SCHEMA_VERSION = 26;
