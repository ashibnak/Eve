import { Global, Module } from '@nestjs/common';
import { DocumentService } from './document.service';
import { DocumentsController } from './documents.controller';
import { ChromiumPdfRenderer, PdfRenderer } from './pdf';
import { DocumentTemplateRegistry } from './template';

/** Document templates, PDF rendering and the record of issued documents (S11). */
@Global()
@Module({
  controllers: [DocumentsController],
  providers: [
    ChromiumPdfRenderer,
    { provide: PdfRenderer, useExisting: ChromiumPdfRenderer },
    DocumentTemplateRegistry,
    DocumentService,
  ],
  exports: [DocumentService, DocumentTemplateRegistry],
})
export class DocumentsModule {}
