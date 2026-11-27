import { Global, Module } from '@nestjs/common';
import { FileStore, LocalDiskFileStore } from './file-store';

/**
 * Stored files behind one interface (architecture doc: server disk now, S3-compatible later
 * without code change). Used by connectors (uploaded imports) and documents (issued PDFs).
 */
@Global()
@Module({
  // The folder comes from EVE_FILES_DIR; built by a factory so Nest does not try to inject it.
  providers: [{ provide: FileStore, useFactory: () => new LocalDiskFileStore() }],
  exports: [FileStore],
})
export class FilesModule {}
