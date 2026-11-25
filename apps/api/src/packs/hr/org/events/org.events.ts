import { orgV1 } from '@eve/contracts';
import { defineEvent } from '../../../../platform/events/event-registry';

/** org events (spec §7), standard envelope (ADR-006); payloads in `contracts/org/v1`. */
export const PositionCreated = defineEvent({
  type: 'org.position.created',
  schemaVersion: 1,
  payload: orgV1.PositionCreatedPayload,
});

export const PositionChanged = defineEvent({
  type: 'org.position.changed',
  schemaVersion: 1,
  payload: orgV1.PositionChangedPayload,
});

export const AssignmentStarted = defineEvent({
  type: 'org.assignment.started',
  schemaVersion: 1,
  payload: orgV1.AssignmentStartedPayload,
});

export const AssignmentEnded = defineEvent({
  type: 'org.assignment.ended',
  schemaVersion: 1,
  payload: orgV1.AssignmentEndedPayload,
});

export const ManagerChanged = defineEvent({
  type: 'org.manager.changed',
  schemaVersion: 1,
  payload: orgV1.ManagerChangedPayload,
});

export const ORG_EVENTS = [
  PositionCreated,
  PositionChanged,
  AssignmentStarted,
  AssignmentEnded,
  ManagerChanged,
] as const;
