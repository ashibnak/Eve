import type { TeamPort } from '../ports/team.port';

/** For a deployment or test without org: nobody leads a team. */
export class NoTeamAdapter implements TeamPort {
  membersLedBy(): Promise<ReadonlySet<string>> {
    return Promise.resolve(new Set());
  }
}
