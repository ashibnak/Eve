import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import type { platformV1 } from '@eve/contracts';
import { type Browser, type BrowserContext, chromium } from 'playwright-core';

export interface PdfRequest {
  /** A complete HTML document; it may not load anything (fonts are inlined). */
  html: string;
  page: platformV1.DocumentLayout['page'];
  /** Writing direction of the document; decides which physical side inline-start is. */
  dir: 'rtl' | 'ltr';
  /** Written as the PDF's creation and modification date, so the bytes depend on inputs only. */
  issuedOn: platformV1.BusinessDate;
}

/** Turns HTML into PDF bytes. Abstract so tests and other deployments can swap the engine. */
export abstract class PdfRenderer {
  abstract render(request: PdfRequest): Promise<Buffer>;
}

/**
 * Chromium's PDF metadata carries the wall-clock time; nothing else in its output varies between
 * runs (S11 spike). Rewrites both dates, at the same length, to the document's issue date.
 */
export function normalizePdfMetadata(pdf: Buffer, issuedOn: platformV1.BusinessDate): Buffer {
  const stamp = `D:${issuedOn.replaceAll('-', '')}000000+00'00'`;
  const text = pdf.toString('latin1');
  const normalized = text.replace(
    /\/(CreationDate|ModDate) \(D:\d{14}[+\-Z][^)]*\)/g,
    (whole, key: string) => {
      const replacement = `/${key} (${stamp})`;
      // Keep byte offsets valid for the xref table: same length or refuse.
      if (replacement.length !== whole.length)
        throw new Error(`Unexpected PDF date format: ${whole}`);
      return replacement;
    },
  );
  return Buffer.from(normalized, 'latin1');
}

/** Vazirmatn (design-system font) as CSS with the font files inlined, so rendering needs no network. */
export function embeddedFontCss(): string {
  const cssPath = require.resolve('@fontsource-variable/vazirmatn/index.css');
  const css = readFileSync(cssPath, 'utf8');
  return css
    .replace(/url\(\.\/files\/([^)]+\.woff2)\)/g, (_, file: string) => {
      const data = readFileSync(join(dirname(cssPath), 'files', file)).toString('base64');
      return `url(data:font/woff2;base64,${data})`;
    })
    .replace(/font-family:\s*'Vazirmatn Variable'/g, "font-family: 'Vazirmatn'");
}

const MAX_PAGES = 2;

/**
 * Headless Chromium, locked down: no JavaScript, every network request refused, one warm browser
 * shared by all renders with at most `MAX_PAGES` at a time. Launched on first use.
 */
@Injectable()
export class ChromiumPdfRenderer extends PdfRenderer implements OnApplicationShutdown {
  private readonly logger = new Logger(ChromiumPdfRenderer.name);
  private context: Promise<{ browser: Browser; context: BrowserContext }> | null = null;
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  /** Requests the page tried to make; always refused. Exposed for tests. */
  blockedRequests = 0;

  private start(): Promise<{ browser: Browser; context: BrowserContext }> {
    this.context ??= (async () => {
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
      await context.route('**/*', async (route) => {
        this.blockedRequests += 1;
        await route.abort('blockedbyclient');
      });
      this.logger.log('Chromium started for document rendering');
      return { browser, context };
    })();
    this.context.catch(() => {
      this.context = null;
    });
    return this.context;
  }

  private async slot(): Promise<void> {
    if (this.active < MAX_PAGES) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
  }

  async render(request: PdfRequest): Promise<Buffer> {
    const { context } = await this.start();
    await this.slot();
    const page = await context.newPage();
    try {
      await page.setContent(request.html, { waitUntil: 'load' });
      const m = request.page.marginsMm;
      // The page box is physical; map the layout's logical margins by writing direction.
      const [left, right] =
        request.dir === 'rtl' ? [m.inlineEnd, m.inlineStart] : [m.inlineStart, m.inlineEnd];
      const pdf = await page.pdf({
        format: request.page.size,
        printBackground: true,
        margin: {
          top: `${m.top}mm`,
          bottom: `${m.bottom}mm`,
          left: `${left}mm`,
          right: `${right}mm`,
        },
      });
      return normalizePdfMetadata(pdf, request.issuedOn);
    } finally {
      await page.close();
      this.release();
    }
  }

  async onApplicationShutdown(): Promise<void> {
    const started = this.context;
    this.context = null;
    if (started) await (await started).browser.close().catch(() => undefined);
  }
}
