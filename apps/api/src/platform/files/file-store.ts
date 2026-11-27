import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface StoredFile {
  /** SHA-256 of the content (hex); also its name in the store. */
  ref: string;
  size: number;
}

/**
 * Where uploaded files live (architecture doc: server disk behind a storage interface, so an S3
 * store can replace it without code changes). Content-addressed: the reference is the SHA-256,
 * so stored evidence cannot change unnoticed.
 */
export abstract class FileStore {
  abstract put(content: Buffer): Promise<StoredFile>;
  abstract get(ref: string): Promise<Buffer>;
  abstract delete(ref: string): Promise<void>;
}

const REF = /^[0-9a-f]{64}$/;

/** Local-disk store under EVE_FILES_DIR (Docker volume `eve_files`). */
export class LocalDiskFileStore extends FileStore {
  constructor(
    private readonly root = process.env.EVE_FILES_DIR ?? join(process.cwd(), 'var', 'files'),
  ) {
    super();
  }

  private path(ref: string): string {
    if (!REF.test(ref)) throw new Error(`Invalid file reference ${ref}`);
    return join(this.root, ref.slice(0, 2), ref);
  }

  async put(content: Buffer): Promise<StoredFile> {
    const ref = createHash('sha256').update(content).digest('hex');
    const path = this.path(ref);
    await mkdir(join(this.root, ref.slice(0, 2)), { recursive: true });
    const exists = await stat(path).then(
      () => true,
      () => false,
    );
    if (!exists) await writeFile(path, content, { flag: 'wx', mode: 0o600 });
    return { ref, size: content.length };
  }

  async get(ref: string): Promise<Buffer> {
    const content = await readFile(this.path(ref));
    if (createHash('sha256').update(content).digest('hex') !== ref) {
      throw new Error(`Stored file ${ref} does not match its hash`);
    }
    return content;
  }

  async delete(ref: string): Promise<void> {
    await rm(this.path(ref), { force: true });
  }
}
