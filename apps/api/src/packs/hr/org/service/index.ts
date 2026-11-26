/**
 * Public entry point of the `org` module (ADR-004): other modules' adapters may import this file
 * only (boundary rule `adapters-only-public-service`). The shapes are the `org/v1` contract.
 */
export { OrgService } from './org.service';
/** The `apply_assignment` command, for the personnel-action workflow's adapter (spec §7). */
export { ApplyAssignment } from '../commands/apply-assignment';
