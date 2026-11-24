/**
 * Eve contracts. Each module publishes its services, commands, events and MCP tools under
 * `<slug>/v1/` (ADR-003). Within a version only additive changes are allowed.
 */
export * as platformV1 from './platform/v1/index.js';
export * as hrCanonicalV1 from './hr/canonical/v1/index.js';
