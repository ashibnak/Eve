import { BadRequestException, ConflictException } from '@nestjs/common';
import { platformV1 } from '@eve/contracts';
import { z } from 'zod';
import { defineApprovalRequestType } from '../approvals/request-types';
import { AuditService } from '../audit/audit.service';
import { EventPublisher } from '../events/event-publisher';
import { defineEvent } from '../events/event-registry';
import { ParamVersionsService } from './param-versions.service';
import { RuleRegistry } from './rule-registry';

export const RULE_PARAMS_CHANGE = 'platform.rule_params.change';

/** A new parameter version became effective-dated for a rule template. */
export const RuleParamsChanged = defineEvent({
  type: 'platform.rule_params.changed',
  schemaVersion: 1,
  payload: z.object({
    template_id: z.string(),
    template_version: z.number().int(),
    param_version_id: z.uuid(),
    valid_from: platformV1.BusinessDateSchema,
  }),
});

export const RuleParamsChangePayload = z.object({
  templateId: platformV1.RuleIdSchema,
  templateVersion: z.number().int().min(1),
  params: z.unknown(),
  validFrom: platformV1.BusinessDateSchema,
});
export type RuleParamsChangePayload = z.infer<typeof RuleParamsChangePayload>;

/**
 * Changing a customer's rule parameters (ADR-005): proposed by a system administrator, approved by
 * the `rule_approver` step (product-owner decision, S2), applied from today or a later date only.
 */
export function ruleParamsChangeType(deps: {
  rules: RuleRegistry;
  params: ParamVersionsService;
  audit: AuditService;
  events: EventPublisher;
}) {
  const templateOf = (payload: RuleParamsChangePayload) => {
    try {
      return deps.rules.get(payload.templateId, payload.templateVersion);
    } catch {
      throw new BadRequestException(
        `Unknown rule ${payload.templateId}@${payload.templateVersion}`,
      );
    }
  };

  return defineApprovalRequestType({
    type: RULE_PARAMS_CHANGE,
    payload: RuleParamsChangePayload,
    defaultChain: ['rule_approver'],
    check(payload, { today }) {
      const parsed = templateOf(payload).params.safeParse(payload.params);
      if (!parsed.success) {
        throw new BadRequestException({
          error: 'invalid_params',
          issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        });
      }
      if (payload.validFrom < today) {
        // Also re-checked at final approval: a request that waited past its date cannot apply.
        throw new ConflictException(
          `Parameters can take effect from today (${today}) or later, not ${payload.validFrom}; return the request so a new date can be set`,
        );
      }
    },
    async apply(tx, request) {
      const template = templateOf(request.payload);
      const { id } = await deps.params.schedule(tx, {
        template,
        companyId: request.companyId,
        params: request.payload.params,
        validFrom: request.payload.validFrom,
        approvalRequestId: request.requestId,
      });
      await deps.audit.record(tx, {
        action: 'platform.rule_params.set',
        entityType: 'rules_param_version',
        entityId: id,
        companyId: request.companyId,
        before: null,
        after: {
          rule: `${template.id}@${template.version}`,
          params: template.params.parse(request.payload.params),
          validFrom: request.payload.validFrom,
        },
        reason: `approved request ${request.requestId}`,
      });
      await deps.events.publish(tx, {
        event: RuleParamsChanged,
        payload: {
          template_id: template.id,
          template_version: template.version,
          param_version_id: id,
          valid_from: request.payload.validFrom,
        },
        effectiveAt: request.payload.validFrom,
        companyId: request.companyId,
      });
    },
  });
}
