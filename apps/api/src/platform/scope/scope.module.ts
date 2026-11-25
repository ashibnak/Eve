import { Global, Module } from '@nestjs/common';
import { RoleRegistry } from '../auth/roles';
import { AccessService } from './access.service';
import { UNIT_SUBTREE_PORT } from './ports/unit-subtree.port';
import { ScopedDb } from './scoped-db';
import { UnitSubtreeRegistry } from './unit-subtree.registry';

@Global()
@Module({
  providers: [
    RoleRegistry,
    AccessService,
    ScopedDb,
    UnitSubtreeRegistry,
    // The org pack registers its adapter in the registry at start-up (S5).
    { provide: UNIT_SUBTREE_PORT, useExisting: UnitSubtreeRegistry },
  ],
  exports: [RoleRegistry, AccessService, ScopedDb, UnitSubtreeRegistry, UNIT_SUBTREE_PORT],
})
export class ScopeModule {}
