import {
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  StreamableFile,
} from '@nestjs/common';
import { platformV1 } from '@eve/contracts';
import { z } from 'zod';
import { parseInput } from '../../../platform/http/validation';
import { OrgWorkspace } from './service/workspace.service';

const ExportQuery = z.object({
  asOf: platformV1.BusinessDateSchema.optional(),
  locale: z.enum(['fa', 'en']).default('fa'),
});

/** Reads for the web UI (S9): my companies, a position's history, the positions table export. */
@Controller('org')
export class WorkspaceController {
  constructor(private readonly workspace: OrgWorkspace) {}

  @Get('companies')
  companies() {
    return this.workspace.companies();
  }

  @Get('positions/:id/history')
  async history(@Param('id', ParseUUIDPipe) id: string) {
    const history = await this.workspace.history(id);
    if (!history) throw new NotFoundException('Position not found');
    return history;
  }

  @Get('companies/:id/positions.xlsx')
  async export(@Param('id', ParseUUIDPipe) id: string, @Query() query: unknown) {
    const { asOf, locale } = parseInput(ExportQuery, query);
    const content = await this.workspace.positionsWorkbook(id, asOf, locale);
    return new StreamableFile(content, {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      disposition: `attachment; filename="positions-${asOf ?? 'today'}.xlsx"`,
    });
  }
}
