import type { Tx } from '../context/tx-runner';

/** A person a phone number belongs to, in one company. */
export interface PersonMatch {
  companyId: string;
  personId: string;
}

/**
 * Who a channel user is (S12). The platform knows no people; the module that owns person records
 * implements this port and registers it at start-up (ADR-001, like the unit-subtree port).
 */
export interface ChannelIdentityDirectory {
  /** People employed today whose contact number is `phone` (international digits); ≤ 1 per company. */
  findEmployedByPhone(phone: string): Promise<PersonMatch[]>;
  /** A login account already linked to any of these people, if there is one. */
  linkedUserOf(matches: readonly PersonMatch[]): Promise<string | null>;
  /** Links the account to the person, in the caller's transaction; audited by the owner. */
  linkUser(tx: Tx, link: PersonMatch & { userId: string; reason: string }): Promise<void>;
}

/** Until a module registers a directory, nobody can be found, so nobody can link. */
class NobodyDirectory implements ChannelIdentityDirectory {
  findEmployedByPhone(): Promise<PersonMatch[]> {
    return Promise.resolve([]);
  }
  linkedUserOf(): Promise<string | null> {
    return Promise.resolve(null);
  }
  linkUser(): Promise<void> {
    return Promise.reject(new Error('No identity directory is registered'));
  }
}

export class ChannelIdentities implements ChannelIdentityDirectory {
  private delegate: ChannelIdentityDirectory = new NobodyDirectory();
  private registered = false;

  use(directory: ChannelIdentityDirectory): void {
    if (this.registered && this.delegate !== directory)
      throw new Error('A channel identity directory is already registered');
    this.delegate = directory;
    this.registered = true;
  }

  findEmployedByPhone(phone: string): Promise<PersonMatch[]> {
    return this.delegate.findEmployedByPhone(phone);
  }
  linkedUserOf(matches: readonly PersonMatch[]): Promise<string | null> {
    return this.delegate.linkedUserOf(matches);
  }
  linkUser(tx: Tx, link: PersonMatch & { userId: string; reason: string }): Promise<void> {
    return this.delegate.linkUser(tx, link);
  }
}
