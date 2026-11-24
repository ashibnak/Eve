import { peopleV1 } from '@eve/contracts';
import { defineEvent } from '../../../../platform/events/event-registry';

/** A person was added to the register. */
export const PersonCreated = defineEvent({
  type: 'people.person.created',
  schemaVersion: 1,
  payload: peopleV1.PersonCreatedPayload,
});

/** A person's employment status changed; the envelope's effective_at is the change date. */
export const PersonStatusChanged = defineEvent({
  type: 'people.person.status_changed',
  schemaVersion: 1,
  payload: peopleV1.PersonStatusChangedPayload,
});
