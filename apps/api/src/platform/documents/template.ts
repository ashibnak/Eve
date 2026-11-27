import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { platformV1 } from '@eve/contracts';
import { z } from 'zod';
import { canonicalJson } from '../audit/canonical-json';
import { compile, type CompiledTemplate } from './render';

/**
 * A document template is code with an id and a version, like a rule template (ADR-005):
 * a published version never changes; fixing it means publishing the next version, and documents
 * issued with the old one still name it. Packs define and register their templates.
 */
export interface DocumentTemplate<TSchema extends z.ZodType = z.ZodType> {
  /** `<slug>.<name>`, e.g. `letters.employment_certificate`. */
  readonly id: string;
  readonly version: number;
  /** The data the body needs; validated before anything is rendered. */
  readonly schema: TSchema;
  /** Body HTML per language it can be issued in. */
  readonly body: Partial<Record<platformV1.DocumentLanguage, string>>;
  /** Extra CSS for the body, on top of the jurisdiction layout's. */
  readonly css?: string;
}

export interface DefinedDocumentTemplate<
  TSchema extends z.ZodType = z.ZodType,
> extends DocumentTemplate<TSchema> {
  readonly compiled: Partial<Record<platformV1.DocumentLanguage, CompiledTemplate>>;
  /** SHA-256 of everything that decides the output (body, css, data schema); see golden files. */
  readonly fingerprint: string;
}

export function templateKey(template: { id: string; version: number }): string {
  return `${template.id}@${template.version}`;
}

export function defineDocumentTemplate<TSchema extends z.ZodType>(
  template: DocumentTemplate<TSchema>,
): DefinedDocumentTemplate<TSchema> {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(template.id))
    throw new Error(`Invalid document template id "${template.id}"`);
  if (!Number.isInteger(template.version) || template.version < 1)
    throw new Error(`Invalid version for document template ${template.id}`);
  const languages = Object.keys(template.body) as platformV1.DocumentLanguage[];
  if (languages.length === 0) throw new Error(`Document template ${template.id} has no body`);
  const key = templateKey(template);
  const compiled = Object.fromEntries(
    languages.map((language) => [
      language,
      compile(template.body[language]!, `${key} (${language})`),
    ]),
  );
  const fingerprint = createHash('sha256')
    .update(
      canonicalJson({
        id: template.id,
        version: template.version,
        body: template.body,
        css: template.css ?? '',
        schema: z.toJSONSchema(template.schema),
      }),
    )
    .digest('hex');
  return { ...template, compiled, fingerprint };
}

/** Templates available in this deployment, by id and version. */
@Injectable()
export class DocumentTemplateRegistry {
  private readonly templates = new Map<string, DefinedDocumentTemplate>();

  register(...templates: DefinedDocumentTemplate[]): void {
    for (const template of templates) {
      const key = templateKey(template);
      const existing = this.templates.get(key);
      if (existing && existing.fingerprint !== template.fingerprint)
        throw new Error(`Document template ${key} is already registered with different content`);
      this.templates.set(key, template);
    }
  }

  get(id: string, version: number): DefinedDocumentTemplate {
    const template = this.templates.get(`${id}@${version}`);
    if (!template) throw new Error(`Document template ${id}@${version} is not registered`);
    return template;
  }
}
