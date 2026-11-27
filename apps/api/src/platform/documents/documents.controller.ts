import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  StreamableFile,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentService } from './document.service';
import { LOGO_MAX_BYTES } from './letterhead';

/** The part of multer's file object we use (avoids depending on @types/multer). */
interface UploadedFileData {
  buffer: Buffer;
}

/** Issued documents (S11). Issuing itself happens only inside the owning module's workflow. */
@Controller('platform/documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentService) {}

  /** An issued document's PDF, for auditors (`platform.documents.read`). */
  @Get(':id/file')
  async file(@Param('id', ParseUUIDPipe) id: string) {
    const { content, fileName } = await this.documents.download(id);
    return new StreamableFile(content, {
      type: 'application/pdf',
      disposition: `attachment; filename="${fileName}"`,
    });
  }

  /**
   * Multipart `file`: a PNG or JPEG logo for the letterhead (system administrator). Returns the
   * reference to set as `logoFileRef` in the `platform.documents.letterhead` setting.
   */
  @Post('letterhead-logo')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: LOGO_MAX_BYTES + 1, files: 1 } }))
  logo(@UploadedFile() file: UploadedFileData | undefined) {
    if (!file) throw new BadRequestException('Attach the logo as "file"');
    return this.documents.storeLogo(file.buffer);
  }
}
