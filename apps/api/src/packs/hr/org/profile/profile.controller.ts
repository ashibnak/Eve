import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { orgV1 } from '@eve/contracts';
import { z } from 'zod';
import { parseInput } from '../../../../platform/http/validation';
import { OrgProfileService } from './profile.service';

const Reason = z.string().trim().min(1).max(1000);
const ProfileBody = orgV1.OrgProfileInputSchema.extend({ reason: Reason });
const LevelsBody = z.object({ levels: orgV1.UnitLevelsInputSchema, reason: Reason });

/** A company's org profile and unit levels (system administrator; spec §2). */
@Controller('org/companies')
export class OrgProfileController {
  constructor(private readonly profiles: OrgProfileService) {}

  @Get(':id/profile')
  async get(@Param('id', ParseUUIDPipe) id: string) {
    const profile = await this.profiles.get(id);
    if (!profile) throw new NotFoundException('No org profile for this company');
    return profile;
  }

  @Post(':id/profile')
  register(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { reason, ...input } = parseInput(ProfileBody, body);
    return this.profiles.register(id, input, reason);
  }

  @Put(':id/unit-levels')
  setLevels(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { levels, reason } = parseInput(LevelsBody, body);
    return this.profiles.setLevels(id, levels, reason);
  }
}
