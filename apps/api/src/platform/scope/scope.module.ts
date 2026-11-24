import { Global, Module } from '@nestjs/common';
import { RoleRegistry } from '../auth/roles';
import { AccessService } from './access.service';
import { DenyAllUnitSubtreeAdapter } from './adapters/deny-all-unit-subtree.adapter';
import { UNIT_SUBTREE_PORT } from './ports/unit-subtree.port';
import { ScopedDb } from './scoped-db';

@Global()
@Module({
  providers: [
    RoleRegistry,
    AccessService,
    ScopedDb,
    // Replaced by the org adapter in S5.
    { provide: UNIT_SUBTREE_PORT, useClass: DenyAllUnitSubtreeAdapter },
  ],
  exports: [RoleRegistry, AccessService, ScopedDb, UNIT_SUBTREE_PORT],
})
export class ScopeModule {}
