import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { Permissions } from '../auth/roles';
import { parseInput } from '../http/validation';
import { AccessService } from '../scope/access.service';
import { ConfigService } from './config.service';
import { type SettingDefinition, SettingsRegistry } from './settings';

const CompanyQuery = z.object({ companyId: z.uuid().optional() });
const SetBody = z.object({
  companyId: z.uuid().nullable().default(null),
  value: z.unknown(),
  reason: z.string().trim().min(1).max(1000),
});

@Controller('platform/config')
export class ConfigController {
  constructor(
    private readonly config: ConfigService,
    private readonly settings: SettingsRegistry,
    private readonly access: AccessService,
  ) {}

  @Get(':key')
  async get(@Param('key') key: string, @Query() query: unknown) {
    const companyId = parseInput(CompanyQuery, query).companyId ?? null;
    await this.access.requireFor(Permissions.configRead, companyId);
    const setting = this.definition(key);
    return { key, companyId, value: await this.config.get(setting, companyId) };
  }

  @Put(':key')
  @HttpCode(204)
  async set(@Param('key') key: string, @Body() body: unknown) {
    const { companyId, value, reason } = parseInput(SetBody, body);
    await this.access.requireFor(Permissions.configWrite, companyId);
    await this.config.set({ setting: this.definition(key), companyId, value, reason });
  }

  private definition(key: string): SettingDefinition {
    try {
      return this.settings.get(key);
    } catch {
      throw new NotFoundException(`Unknown setting ${key}`);
    }
  }
}
