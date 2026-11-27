import { z } from 'zod';

/** Languages a document can be issued in. Persian first (ADR-010); English for e.g. embassies. */
export const DocumentLanguageSchema = z.enum(['fa', 'en']);
export type DocumentLanguage = z.infer<typeof DocumentLanguageSchema>;

export interface PageMargins {
  readonly top: number;
  readonly inlineEnd: number;
  readonly bottom: number;
  readonly inlineStart: number;
}

/**
 * The frame every issued document of a jurisdiction is printed in (ADR-010): page, letterhead,
 * number/date block and footer. Written in the platform's template syntax; the body of the
 * document goes where the frame has the `<!--body-->` marker. Versioned like templates: an
 * issued document records the layout version it was printed with.
 */
export interface DocumentLayout {
  readonly id: string;
  readonly version: number;
  readonly page: { readonly size: 'A4' | 'A5'; readonly marginsMm: PageMargins };
  /** Frame HTML per language. Variables: `letterhead.*`, `document.*`, `dir`. */
  readonly frame: Readonly<Record<DocumentLanguage, string>>;
  readonly css: string;
}

/** Payload of `platform.document.issued` (ADR-006 envelope around it). */
export const DocumentIssuedPayloadSchema = z.object({
  document_id: z.uuid(),
  template_id: z.string(),
  template_version: z.number().int().positive(),
  language: DocumentLanguageSchema,
  number: z.string().nullable(),
  file_sha256: z.string().length(64),
});
export type DocumentIssuedPayload = z.infer<typeof DocumentIssuedPayloadSchema>;
