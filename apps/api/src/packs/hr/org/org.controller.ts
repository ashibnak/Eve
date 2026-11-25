import { Controller, Get, NotFoundException, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { orgV1, platformV1 } from '@eve/contracts';
import { z } from 'zod';
import { parseInput } from '../../../platform/http/validation';
import { OrgService } from './service/org.service';

const AsOfQuery = z.object({ asOf: platformV1.BusinessDateSchema.optional() });
const TeamQuery = AsOfQuery.extend({ depth: z.enum(['direct', 'subtree']).default('direct') });
const ChainQuery = AsOfQuery.extend({ levels: z.coerce.number().int().min(1).max(20).default(3) });
const DiffQuery = z.object({
  from: platformV1.BusinessDateSchema,
  to: platformV1.BusinessDateSchema,
});
const { OrgTools: T } = orgV1;

/** org read services over HTTP, one endpoint per agent tool (contracts/org/v1). */
@Controller('org')
export class OrgController {
  constructor(private readonly org: OrgService) {}

  @Get('positions/:id')
  async position(@Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    const input = parseInput(T.getPosition.input, {
      positionId: id,
      ...parseInput(AsOfQuery, query),
    });
    const view = await this.org.getPosition(input);
    if (!view) throw new NotFoundException('Position not found');
    return view;
  }

  @Get('positions/:id/team')
  team(@Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    return this.org.getTeam(
      parseInput(T.getTeam.input, { positionId: id, ...parseInput(TeamQuery, query) }),
    );
  }

  @Get('persons/:id/positions')
  personPositions(@Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    return this.org.getPersonPosition(
      parseInput(T.getPersonPosition.input, { personId: id, ...parseInput(AsOfQuery, query) }),
    );
  }

  @Get('persons/:id/manager')
  async manager(@Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    return {
      manager: await this.org.getManager(
        parseInput(T.getManager.input, { personId: id, ...parseInput(AsOfQuery, query) }),
      ),
    };
  }

  @Get('persons/:id/approval-chain')
  chain(@Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    return this.org.getApprovalChain(
      parseInput(T.getApprovalChain.input, { personId: id, ...parseInput(ChainQuery, query) }),
    );
  }

  @Get('persons/:id/informed')
  informed(@Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    return this.org.getInformed(
      parseInput(T.getInformed.input, { personId: id, ...parseInput(AsOfQuery, query) }),
    );
  }

  @Get('companies/:id/structure')
  structure(@Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    return this.org.getStructure(
      parseInput(T.getStructure.input, { companyId: id, ...parseInput(AsOfQuery, query) }),
    );
  }

  @Get('companies/:id/structure-diff')
  diff(@Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    return this.org.diffStructure(
      parseInput(T.diffStructure.input, { companyId: id, ...parseInput(DiffQuery, query) }),
    );
  }
}
