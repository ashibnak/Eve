import { persianCalendar } from '@eve/jurisdiction-ir';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { normalizePdfMetadata } from './pdf';
import { compile, formatDocumentDate, render, type RenderOptions, TemplateError } from './render';
import { defineDocumentTemplate } from './template';

const fa: RenderOptions = { language: 'fa', calendar: persianCalendar };
const en: RenderOptions = { language: 'en', calendar: persianCalendar };
const run = (source: string, data: Record<string, unknown>, options = fa) =>
  render(compile(source), data, options);

describe('document template language', () => {
  it('escapes every value: markup in data stays text', () => {
    expect(run('<p>{{name}}</p>', { name: '<script>alert("x")</script> & \'q\'' })).toBe(
      '<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</p>',
    );
    expect(run('<img alt="{{t}}">', { t: '" onerror="x' })).toBe(
      '<img alt="&quot; onerror=&quot;x">',
    );
  });

  it('has no unescaped output and rejects unknown tags at compile time', () => {
    expect(() => compile('{{{html}}}')).toThrow(TemplateError);
    expect(() => compile('{{> partial}}')).toThrow(TemplateError);
    expect(() => compile('{{#if a}}open')).toThrow(/Unclosed/);
    expect(() => compile('{{/each}}')).toThrow(TemplateError);
    expect(() => compile('{{a b c}}')).toThrow(TemplateError);
  });

  it('fails loudly on a missing value, prints nothing for null', () => {
    expect(() => run('{{person.name}}', { person: {} })).toThrow(
      /Missing value for \{\{person.name\}\}/,
    );
    expect(run('[{{x}}]', { x: null })).toBe('[]');
    expect(() => run('{{x}}', { x: { a: 1 } })).toThrow(/not text/);
  });

  it('guards optional values with if/else and repeats with each', () => {
    const t = '{{#if p.title}}{{p.title}}{{else}}—{{/if}}';
    expect(run(t, { p: { title: 'کارشناس' } })).toBe('کارشناس');
    expect(run(t, { p: {} })).toBe('—');
    expect(run(t, { p: { title: '' } })).toBe('—');
    const list = '{{#each rows as row}}<li>{{row.n}}</li>{{/each}}{{#if rows}}!{{/if}}';
    expect(run(list, { rows: [{ n: 1 }, { n: 2 }] })).toBe('<li>1</li><li>2</li>!');
    expect(run(list, { rows: [] })).toBe('');
    expect(() => run(list, { rows: 'x' })).toThrow(/not a list/);
  });

  it('prints dates in the document calendar and Persian digits in fa', () => {
    expect(formatDocumentDate('2026-11-27', fa)).toBe('۱۴۰۵/۰۹/۰۶');
    expect(formatDocumentDate('2026-03-21', fa)).toBe('۱۴۰۵/۰۱/۰۱');
    expect(formatDocumentDate('2026-11-27', en)).toBe('27 November 2026');
    expect(run('{{date d}} {{digits n}}', { d: '2026-11-27', n: 'FNP/1405/0012' })).toBe(
      '۱۴۰۵/۰۹/۰۶ FNP/۱۴۰۵/۰۰۱۲',
    );
    expect(run('{{digits n}}', { n: '0012' }, en)).toBe('0012');
    expect(() => run('{{date d}}', { d: '1405/09/06' })).toThrow(/not a business date/);
  });
});

describe('document templates', () => {
  const base = {
    id: 'test.sample',
    version: 1,
    schema: z.object({ name: z.string() }),
    body: { fa: '<p>{{name}}</p>' },
  };

  it('fingerprints everything that decides the output', () => {
    const a = defineDocumentTemplate(base);
    expect(defineDocumentTemplate(base).fingerprint).toBe(a.fingerprint);
    expect(
      defineDocumentTemplate({ ...base, body: { fa: '<p>{{name}}.</p>' } }).fingerprint,
    ).not.toBe(a.fingerprint);
    expect(defineDocumentTemplate({ ...base, css: 'p{}' }).fingerprint).not.toBe(a.fingerprint);
    expect(
      defineDocumentTemplate({ ...base, schema: z.object({ name: z.string().max(5) }) })
        .fingerprint,
    ).not.toBe(a.fingerprint);
  });

  it('checks ids, versions and syntax when defined', () => {
    expect(() => defineDocumentTemplate({ ...base, id: 'Bad' })).toThrow(
      /Invalid document template id/,
    );
    expect(() => defineDocumentTemplate({ ...base, version: 0 })).toThrow(/Invalid version/);
    expect(() => defineDocumentTemplate({ ...base, body: {} })).toThrow(/no body/);
    expect(() => defineDocumentTemplate({ ...base, body: { fa: '{{#if x}}' } })).toThrow(
      TemplateError,
    );
  });
});

describe('PDF metadata', () => {
  it('rewrites both dates to the issue date at the same length', () => {
    const pdf = Buffer.from(
      "%PDF-1.4\n/Creator (Chromium)\n/CreationDate (D:20261127095458+00'00')\n/ModDate (D:20261127095458+00'00')\n",
      'latin1',
    );
    const out = normalizePdfMetadata(pdf, '2026-11-27' as never).toString('latin1');
    expect(out).toContain("/CreationDate (D:20261127000000+00'00')");
    expect(out).toContain("/ModDate (D:20261127000000+00'00')");
    expect(out.length).toBe(pdf.length);
  });
});
