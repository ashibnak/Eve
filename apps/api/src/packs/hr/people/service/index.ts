/**
 * Public entry point of the `people` module (ADR-004): other modules' adapters may import this
 * file only (boundary rule `adapters-only-public-service`). The shapes are the `people/v1` contract.
 */
export { PeopleService } from './people.service';
export type { ListOptions } from './people.service';
