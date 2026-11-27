import { z } from 'zod';
import { defineSetting } from '../config/settings';

/**
 * A company's letterhead on issued documents (S11). Customer-wide with per-company override; no
 * default, because printing a document under a made-up name is worse than refusing to print.
 * The logo is a file in the store (PNG or JPEG, uploaded by a system administrator).
 */
export const LetterheadSetting = defineSetting({
  key: 'platform.documents.letterhead',
  scope: 'customer_or_company',
  schema: z
    .object({
      nameFa: z.string().trim().min(1).max(200),
      nameEn: z.string().trim().min(1).max(200).optional(),
      addressFa: z.string().trim().min(1).max(300).optional(),
      phone: z
        .string()
        .trim()
        .regex(/^[0-9+\-\s()]{4,30}$/)
        .optional(),
      footerFa: z.string().trim().min(1).max(300).optional(),
      logoFileRef: z
        .string()
        .regex(/^[0-9a-f]{64}$/)
        .optional(),
    })
    .strict(),
});
export type Letterhead = z.output<typeof LetterheadSetting.schema>;

export const LOGO_MAX_BYTES = 512 * 1024;

/** PNG or JPEG by its magic bytes; anything else (SVG can carry script) is refused. */
export function logoMimeType(content: Buffer): 'image/png' | 'image/jpeg' | null {
  if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return 'image/jpeg';
  return null;
}
