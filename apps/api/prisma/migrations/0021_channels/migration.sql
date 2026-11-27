-- Channels (S12): which chat belongs to which login, and the bookkeeping of the Bale poller.
-- No message text and no phone number is stored.

-- A user's address on a channel (e.g. their Bale chat). Ended, never deleted.
CREATE TABLE channels_link (
  id        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id   uuid        NOT NULL REFERENCES auth_user (id),
  channel   text        NOT NULL CHECK (channel ~ '^[a-z][a-z0-9_]*$'),
  address   text        NOT NULL CHECK (address <> ''),
  linked_at timestamptz NOT NULL,
  ended_at  timestamptz,
  CONSTRAINT channels_link_ended_ck CHECK (ended_at IS NULL OR ended_at >= linked_at)
);
-- One active link per chat, and one active chat per user and channel.
CREATE UNIQUE INDEX channels_link_address_uq ON channels_link (channel, address) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX channels_link_user_uq ON channels_link (user_id, channel) WHERE ended_at IS NULL;

-- Updates already processed, so a redelivered update has no second effect.
CREATE TABLE channels_update (
  channel     text        NOT NULL,
  update_id   bigint      NOT NULL,
  received_at timestamptz NOT NULL,
  PRIMARY KEY (channel, update_id)
);

-- Where the poller resumes after a restart.
CREATE TABLE channels_poll_state (
  channel     text   PRIMARY KEY,
  next_offset bigint NOT NULL
);

-- Linking attempts per chat, for rate limiting. Outcome only; never the number tried.
CREATE TABLE channels_link_attempt (
  id      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel text        NOT NULL,
  address text        NOT NULL,
  at      timestamptz NOT NULL,
  outcome text        NOT NULL CHECK (outcome IN ('linked', 'not_found', 'not_own', 'already'))
);
CREATE INDEX channels_link_attempt_idx ON channels_link_attempt (channel, address, at DESC);

REVOKE DELETE, TRUNCATE ON TABLE channels_link FROM eve_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE channels_update FROM eve_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE channels_link_attempt FROM eve_app;
