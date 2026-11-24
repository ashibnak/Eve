import { Body, Controller, Get, Param, ParseIntPipe, Post } from '@nestjs/common';
import { platformV1 } from '@eve/contracts';
import { z } from 'zod';
import { ApprovalService } from '../approvals/approval.service';
import { Permissions } from '../auth/roles';
import { ConfigService } from '../config/config.service';
import { TimeZoneSetting } from '../config/settings';
import { Clock } from '../context/clock';
import { businessDateIn } from '../dates/dates';
import { parseInput } from '../http/validation';
import { AccessService } from '../scope/access.service';
import { ParamVersionsService } from './param-versions.service';
import { RULE_PARAMS_CHANGE } from './rule-params.request';
import { RuleRegistry } from './rule-registry';

const ProposeBody = z.object({
  companyId: z.uuid().nullable().default(null),
  params: z.unknown(),
  validFrom: platformV1.BusinessDateSchema,
  reason: z.string().trim().min(1).max(1000),
});

@Controller('platform/rules')
export class RulesController {
  constructor(
    private readonly rules: RuleRegistry,
    private readonly params: ParamVersionsService,
    private readonly approvals: ApprovalService,
    private readonly access: AccessService,
    private readonly config: ConfigService,
    private readonly clock: Clock,
  ) {}

  /** Every registered template version with its customer-wide parameters as of today. */
  @Get()
  async list() {
    await this.access.requireFor(Permissions.rulesRead, null);
    const today = businessDateIn(this.clock.now(), await this.config.get(TimeZoneSetting));
    return Promise.all(
      this.rules.list().map(async (template) => {
        const current = await this.params.resolve(template, null, today, this.clock.now());
        return {
          id: template.id,
          version: template.version,
          latest: this.rules.latest(template.id).version === template.version,
          description: template.description,
          defaultParams: template.defaultParams,
          params: current.params,
          paramVersionId: current.paramVersionId,
        };
      }),
    );
  }

  /** Proposes new parameters; they apply only after the approval chain approves them. */
  @Post(':id/:version/params')
  async propose(
    @Param('id') id: string,
    @Param('version', ParseIntPipe) version: number,
    @Body() body: unknown,
  ) {
    const { companyId, params, validFrom, reason } = parseInput(ProposeBody, body);
    await this.access.requireFor(Permissions.rulesPropose, companyId);
    return this.approvals.submit({
      type: RULE_PARAMS_CHANGE,
      companyId,
      payload: { templateId: id, templateVersion: version, params, validFrom },
      reason,
    });
  }
}
