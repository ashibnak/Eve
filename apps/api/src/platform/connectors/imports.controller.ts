import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { platformV1 } from '@eve/contracts';
import { z } from 'zod';
import { parseInput } from '../http/validation';
import { ImportService } from './import.service';
import { HARD_MAX_BYTES } from './import.settings';

/** The part of multer's file object we use (avoids depending on @types/multer). */
interface UploadedFileData {
  originalname: string;
  size: number;
  buffer: Buffer;
}

const UploadFields = z.object({
  target: z.string().min(1),
  companyId: z.uuid(),
  effectiveDate: platformV1.BusinessDateSchema,
  sourceName: z.string().trim().min(1).max(100),
});
const MappingBody = z.object({ mapping: z.unknown(), save: z.boolean().default(true) });
const ReasonBody = z.object({ reason: z.string().trim().min(1).max(1000) });

/** File import (ADR-011): upload → mapping → validate → preview → commit. */
@Controller('platform/imports')
export class ImportsController {
  constructor(private readonly imports: ImportService) {}

  /** Multipart: `file` plus fields `target`, `companyId`, `effectiveDate`, `sourceName`. */
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: HARD_MAX_BYTES, files: 1 } }))
  upload(@UploadedFile() file: UploadedFileData | undefined, @Body() body: unknown) {
    if (!file) throw new BadRequestException('Attach the file as "file"');
    const fields = parseInput(UploadFields, body);
    // Browsers send non-ASCII file names as Latin-1 in multipart headers.
    const fileName = Buffer.from(file.originalname, 'latin1').toString('utf8');
    return this.imports.upload({ ...fields, fileName, content: file.buffer });
  }

  @Get(':id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.imports.get(id);
  }

  @Put(':id/mapping')
  map(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    const { mapping, save } = parseInput(MappingBody, body);
    return this.imports.map(id, mapping, save);
  }

  @Post(':id/validate')
  @HttpCode(200)
  validate(@Param('id', ParseUUIDPipe) id: string) {
    return this.imports.validate(id);
  }

  @Get(':id/preview')
  preview(@Param('id', ParseUUIDPipe) id: string) {
    return this.imports.preview(id);
  }

  @Post(':id/commit')
  @HttpCode(200)
  commit(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.imports.commit(id, parseInput(ReasonBody, body).reason);
  }

  @Post(':id/discard')
  @HttpCode(200)
  discard(@Param('id', ParseUUIDPipe) id: string, @Body() body: unknown) {
    return this.imports.discard(id, parseInput(ReasonBody, body).reason);
  }
}
