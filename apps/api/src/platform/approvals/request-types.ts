import { Injectable } from '@nestjs/common';
import type { platformV1 } from '@eve/contracts';
import { z } from 'zod';
import { type SettingDefinition, defineSetting, SettingsRegistry } from '../config/settings';
import { type Tx } from '../context/tx-runner';

/** What a request type's `check` and `apply` get to know about the request. */
export interface ApprovalContext<TPayload> {
  requestId: string;
  companyId: string | null;
  payload: TPayload;
  /** Rule template versions fixed at submission: `{ "<rule id>": <version> }`. */
  pinnedRules: Readonly<Record<string, number>>;
  requestedBy: string;
}

/**
 * A kind of request that needs approval, owned by the module that owns the change (the approvals
 * component never knows what a request changes). `apply` runs in the same transaction as the
 * final approval, so the change, its audit row and its events commit together.
 */
export interface ApprovalRequestType<TPayload extends z.ZodType = z.ZodType> {
  /** `<component-or-slug>.<subject>.<verb>`, e.g. `platform.rule_params.change`. */
  type: string;
  payload: TPayload;
  /** Default ordered chain of role names; each customer may configure its own (a setting). */
  defaultChain: readonly string[];
  /** Rule ids whose latest version is pinned at submission and used until the request ends. */
  pinRules?: readonly string[];
  /**
   * Business checks at submit, resubmit and again right before `apply` (e.g. an effective date that
   * has passed while waiting). Throw an HTTP exception to refuse.
   */
  check?(
    payload: z.output<TPayload>,
    context: { companyId: string | null; today: platformV1.BusinessDate },
  ): Promise<void> | void;
  apply(tx: Tx, request: ApprovalContext<z.output<TPayload>>): Promise<void>;
}

export function defineApprovalRequestType<TPayload extends z.ZodType>(
  definition: ApprovalRequestType<TPayload>,
): ApprovalRequestType<TPayload> {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/.test(definition.type)) {
    throw new Error(`Invalid approval request type "${definition.type}"`);
  }
  if (definition.defaultChain.length === 0)
    throw new Error(`${definition.type} needs at least one step`);
  return definition;
}

const ChainSchema = z
  .array(z.string().regex(/^[a-z][a-z0-9_]*$/))
  .min(1)
  .max(10);

/** Request types by name, each with its customer-configurable chain setting. */
@Injectable()
export class ApprovalTypeRegistry {
  private readonly types = new Map<string, ApprovalRequestType>();
  private readonly chains = new Map<string, SettingDefinition<typeof ChainSchema>>();

  constructor(private readonly settings: SettingsRegistry) {}

  register(definition: ApprovalRequestType): void {
    if (this.types.has(definition.type))
      throw new Error(`Request type ${definition.type} is already registered`);
    const chain = defineSetting({
      key: `approvals.chain.${definition.type}`,
      schema: ChainSchema,
      scope: 'customer_or_company',
      default: [...definition.defaultChain],
    });
    this.settings.register(chain);
    this.types.set(definition.type, definition);
    this.chains.set(definition.type, chain);
  }

  get(type: string): ApprovalRequestType {
    const definition = this.types.get(type);
    if (!definition) throw new Error(`Request type ${type} is not registered`);
    return definition;
  }

  /** The setting holding the customer's chain for a request type (`approvals.chain.<type>`). */
  chainSetting(type: string): SettingDefinition<typeof ChainSchema> {
    const setting = this.chains.get(type);
    if (!setting) throw new Error(`Request type ${type} is not registered`);
    return setting;
  }
}
