import { Injectable } from '@nestjs/common';
import type { platformV1 } from '@eve/contracts';
import { z } from 'zod';
import { defineSetting } from '../config/settings';

/**
 * The customer's home jurisdiction: whose calendar defines reporting periods such as the usage
 * month (product-owner decision, S1). No default: a deployment must choose it (bootstrap CLI).
 */
export const HomeJurisdictionSetting = defineSetting({
  key: 'platform.home_jurisdiction',
  schema: z.string().regex(/^[a-z]{2}$/),
  scope: 'customer',
});

export const JURISDICTION_PACKS = Symbol('JurisdictionPacks');

/**
 * Jurisdiction packs available in this deployment (ADR-010). Packs are handed in by the app
 * wiring, so platform code never names a country.
 */
@Injectable()
export class JurisdictionRegistry {
  private readonly packs = new Map<string, platformV1.JurisdictionPack>();

  constructor(packs: readonly platformV1.JurisdictionPack[] = []) {
    for (const pack of packs) this.register(pack);
  }

  register(pack: platformV1.JurisdictionPack): void {
    if (!/^[a-z]{2}$/.test(pack.code)) throw new Error(`Invalid jurisdiction code ${pack.code}`);
    if (this.packs.has(pack.code))
      throw new Error(`Jurisdiction ${pack.code} is already registered`);
    this.packs.set(pack.code, pack);
  }

  has(code: string): boolean {
    return this.packs.has(code);
  }

  get(code: string): platformV1.JurisdictionPack {
    const pack = this.packs.get(code);
    if (!pack) throw new Error(`Jurisdiction ${code} is not available in this deployment`);
    return pack;
  }

  codes(): string[] {
    return [...this.packs.keys()];
  }
}
