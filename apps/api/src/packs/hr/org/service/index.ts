/**
 * Public entry point of the `org` module (ADR-004): other modules' adapters may import this file
 * only (boundary rule `adapters-only-public-service`). The shapes are the `org/v1` contract.
 */
export { OrgService } from './org.service';
