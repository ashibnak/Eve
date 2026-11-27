import { createHash } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
} from '@nestjs/common';
import { platformV1 } from '@eve/contracts';
import { AuditService } from '../audit/audit.service';
import { canonicalJson, toCanonicalValue } from '../audit/canonical-json';
import { Permissions } from '../auth/roles';
import { ConfigService, SettingNotConfiguredError } from '../config/config.service';
import { SettingsRegistry, TimeZoneSetting } from '../config/settings';
import { Clock } from '../context/clock';
import { currentContext } from '../context/request-context';
import { TxRunner } from '../context/tx-runner';
import { businessDateIn } from '../dates/dates';
import { PrismaService } from '../db/prisma.service';
import { defineEvent, EventRegistry } from '../events/event-registry';
import { EventPublisher } from '../events/event-publisher';
import { FileStore } from '../files/file-store';
import { JurisdictionRegistry } from '../jurisdiction/jurisdiction.registry';
import { AccessService } from '../scope/access.service';
import { type Letterhead, LetterheadSetting, LOGO_MAX_BYTES, logoMimeType } from './letterhead';
import { PdfRenderer } from './pdf';
import { compile, type CompiledTemplate, escapeHtml, render } from './render';
import { type DefinedDocumentTemplate, templateKey } from './template';
import { embeddedFontCss } from './pdf';

export const DocumentIssued = defineEvent({
  type: 'platform.document.issued',
  schemaVersion: 1,
  payload: platformV1.DocumentIssuedPayloadSchema,
});

export class DocumentSetupError extends Error {}

export interface IssueRequest {
  companyId: string;
  template: DefinedDocumentTemplate;
  /** Validated against the template's schema before anything is rendered. */
  data: unknown;
  language: platformV1.DocumentLanguage;
  /** From the owning module's register, if it numbers its documents. */
  number?: string | null;
  /** For the number/date block, e.g. "ندارد"; the layout prints its own word when absent. */
  attachments?: string | null;
  reason: string;
}

export interface IssuedDocument {
  documentId: string;
  fileRef: string;
  inputsHash: string;
  issuedOn: platformV1.BusinessDate;
}

interface Prepared {
  html: string;
  inputsHash: string;
  issuedOn: platformV1.BusinessDate;
  layout: platformV1.DocumentLayout;
  dir: 'rtl' | 'ltr';
}

/**
 * Issues documents (S11): template + data + the company's letterhead, printed in its
 * jurisdiction's layout, rendered to PDF and kept as evidence. Domain-free: the owning module
 * decides who may get which document and calls `issue` from its own workflow, after its checks.
 *
 * Rendering happens outside the transaction (it can take a moment); the file is content-addressed,
 * so a retry stores nothing twice. The record, its audit row and its event commit together.
 */
@Injectable()
export class DocumentService {
  private readonly frames = new Map<string, CompiledTemplate>();
  private fontCss: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly txRunner: TxRunner,
    private readonly audit: AuditService,
    private readonly events: EventPublisher,
    private readonly config: ConfigService,
    private readonly clock: Clock,
    private readonly access: AccessService,
    private readonly jurisdictions: JurisdictionRegistry,
    private readonly files: FileStore,
    private readonly pdf: PdfRenderer,
    settings: SettingsRegistry,
    eventRegistry: EventRegistry,
  ) {
    settings.register(LetterheadSetting);
    eventRegistry.register(DocumentIssued);
  }

  async issue(request: IssueRequest): Promise<IssuedDocument> {
    const context = currentContext();
    if (request.reason.trim() === '') throw new BadRequestException('A reason is required');
    const prepared = await this.prepare(request);
    const content = await this.pdf.render({
      html: prepared.html,
      page: prepared.layout.page,
      dir: prepared.dir,
      issuedOn: prepared.issuedOn,
    });
    const stored = await this.files.put(content);
    const number = request.number ?? null;

    return this.txRunner.run(async (tx) => {
      const row = await tx.docDocument.create({
        data: {
          companyId: request.companyId,
          templateId: request.template.id,
          templateVersion: request.template.version,
          layoutId: prepared.layout.id,
          layoutVersion: prepared.layout.version,
          language: request.language,
          number,
          issuedOn: new Date(`${prepared.issuedOn}T00:00:00Z`),
          inputsHash: prepared.inputsHash,
          fileRef: stored.ref,
          fileSize: stored.size,
          issuedAt: this.clock.now(),
          actorKind: context.actor.kind,
          actorId: context.actor.id,
          source: context.source,
          correlationId: context.correlationId,
        },
      });
      await this.audit.record(tx, {
        action: 'platform.document.issue',
        entityType: 'doc_document',
        entityId: row.id,
        companyId: request.companyId,
        before: null,
        after: {
          template: templateKey(request.template),
          layout: templateKey(prepared.layout),
          language: request.language,
          number,
          issuedOn: prepared.issuedOn,
          inputsHash: prepared.inputsHash,
          fileSha256: stored.ref,
        },
        reason: request.reason,
      });
      await this.events.publish(tx, {
        event: DocumentIssued,
        payload: {
          document_id: row.id,
          template_id: request.template.id,
          template_version: request.template.version,
          language: request.language,
          number,
          file_sha256: stored.ref,
        },
        effectiveAt: prepared.issuedOn,
        companyId: request.companyId,
      });
      return {
        documentId: row.id,
        fileRef: stored.ref,
        inputsHash: prepared.inputsHash,
        issuedOn: prepared.issuedOn,
      };
    });
  }

  /** The PDF the request would issue, for a preview before approval. Not stored, not audited. */
  async preview(request: Omit<IssueRequest, 'reason'>): Promise<Buffer> {
    const prepared = await this.prepare(request);
    return this.pdf.render({
      html: prepared.html,
      page: prepared.layout.page,
      dir: prepared.dir,
      issuedOn: prepared.issuedOn,
    });
  }

  /** The PDF of an issued document, for holders of `platform.documents.read` (auditors). */
  async download(documentId: string): Promise<{ content: Buffer; fileName: string }> {
    const row = await this.prisma.docDocument.findUnique({ where: { id: documentId } });
    if (!row) throw new NotFoundException();
    await this.access.requireFor(Permissions.documentsRead, row.companyId);
    return {
      content: await this.files.get(row.fileRef),
      fileName: `${row.templateId}-${row.id}.pdf`,
    };
  }

  /**
   * The PDF of an issued document for its owning module, which has already checked that the
   * caller may see it (e.g. an employee their own letter) — like `ScopedDb.afterOwnCheck`.
   */
  async contentAfterOwnCheck(documentId: string): Promise<Buffer> {
    const row = await this.prisma.docDocument.findUnique({ where: { id: documentId } });
    if (!row) throw new NotFoundException();
    return this.files.get(row.fileRef);
  }

  /** Stores a letterhead logo (PNG or JPEG) and returns the reference to put in the setting. */
  async storeLogo(content: Buffer): Promise<{ logoFileRef: string }> {
    await this.access.requireFor(Permissions.configWrite, null);
    if (content.length > LOGO_MAX_BYTES)
      throw new PayloadTooLargeException(`The logo may be at most ${LOGO_MAX_BYTES} bytes`);
    if (!logoMimeType(content))
      throw new BadRequestException('The logo must be a PNG or JPEG image');
    const stored = await this.files.put(content);
    return { logoFileRef: stored.ref };
  }

  private async prepare(request: Omit<IssueRequest, 'reason'>): Promise<Prepared> {
    const { template, language } = request;
    const compiledBody = template.compiled[language];
    if (!compiledBody)
      throw new BadRequestException(`${templateKey(template)} has no ${language} version`);
    const parsed = template.schema.safeParse(request.data);
    if (!parsed.success)
      throw new BadRequestException(`Data for ${templateKey(template)}: ${parsed.error.message}`);
    const data = toCanonicalValue<Record<string, unknown>>(parsed.data);

    const company = await this.prisma.coreCompany.findUnique({ where: { id: request.companyId } });
    if (!company) throw new NotFoundException(`Company ${request.companyId} not found`);
    const jurisdiction = this.jurisdictions.get(company.jurisdictionCode);
    const layout = jurisdiction.documentLayout;
    if (!layout)
      throw new DocumentSetupError(`Jurisdiction ${jurisdiction.code} has no document layout`);
    let letterhead: Letterhead;
    try {
      letterhead = await this.config.get(LetterheadSetting, request.companyId);
    } catch (error) {
      if (error instanceof SettingNotConfiguredError)
        throw new DocumentSetupError('No letterhead is configured for this company');
      throw error;
    }
    const issuedOn = businessDateIn(this.clock.now(), await this.config.get(TimeZoneSetting));
    const number = request.number ?? null;
    const attachments = request.attachments ?? null;

    const inputsHash = createHash('sha256')
      .update(
        canonicalJson({
          template: { key: templateKey(template), fingerprint: template.fingerprint },
          layout: templateKey(layout),
          language,
          data,
          letterhead,
          number,
          attachments,
          issuedOn,
        }),
      )
      .digest('hex');

    const options = { language, calendar: jurisdiction.calendar };
    const logo = letterhead.logoFileRef ? await this.logoDataUrl(letterhead.logoFileRef) : null;
    const frame = render(
      this.frame(layout, language),
      {
        dir: language === 'fa' ? 'rtl' : 'ltr',
        letterhead: {
          nameFa: letterhead.nameFa,
          nameEn: letterhead.nameEn ?? null,
          addressFa: letterhead.addressFa ?? null,
          phone: letterhead.phone ?? null,
          footerFa: letterhead.footerFa ?? null,
          logo,
        },
        document: { number, date: issuedOn, attachments },
      },
      options,
    );
    const body = render(compiledBody, data, options);
    const dir = language === 'fa' ? 'rtl' : 'ltr';
    this.fontCss ??= embeddedFontCss();
    const html = [
      `<!doctype html><html lang="${language}" dir="${dir}"><head><meta charset="utf-8">`,
      `<title>${escapeHtml(templateKey(template))}</title>`,
      `<style>${this.fontCss}</style><style>${layout.css}</style><style>${template.css ?? ''}</style>`,
      '</head><body>',
      frame.replace('<!--body-->', () => body),
      '</body></html>',
    ].join('');
    return { html, inputsHash, issuedOn, layout, dir };
  }

  private frame(layout: platformV1.DocumentLayout, language: platformV1.DocumentLanguage) {
    const key = `${templateKey(layout)}:${language}`;
    let compiled = this.frames.get(key);
    if (!compiled) {
      const source = layout.frame[language];
      if (!source.includes('<!--body-->'))
        throw new DocumentSetupError(`Layout ${key} has no <!--body--> marker`);
      compiled = compile(source, `layout ${key}`);
      this.frames.set(key, compiled);
    }
    return compiled;
  }

  private async logoDataUrl(ref: string): Promise<string> {
    const content = await this.files.get(ref);
    const mime = logoMimeType(content);
    if (!mime) throw new DocumentSetupError('The letterhead logo is not a PNG or JPEG image');
    return `data:${mime};base64,${content.toString('base64')}`;
  }
}
