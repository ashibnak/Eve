import type { platformV1 } from '@eve/contracts';

/**
 * The document template language: deliberately tiny, so templates stay data, not code.
 *
 *   {{path}}                 value, HTML-escaped (there is no unescaped output)
 *   {{date path}}            a business date (YYYY-MM-DD) in the document language's calendar
 *   {{digits path}}          the value with Persian digits in `fa`
 *   {{#if path}}…{{else}}…{{/if}}
 *   {{#each path as item}}…{{item.field}}…{{/each}}
 *
 * Output of a missing variable throws (no silent blanks, CLAUDE.md); `null` prints nothing.
 * `#if` treats missing, null, false, '' and [] as false, so optional fields are guarded with it.
 */
export class TemplateError extends Error {}

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'value'; helper: 'none' | 'date' | 'digits'; path: string[] }
  | { kind: 'if'; path: string[]; then: Node[]; otherwise: Node[] }
  | { kind: 'each'; path: string[]; alias: string; body: Node[] };

export interface CompiledTemplate {
  readonly nodes: readonly Node[];
}

const TAG = /\{\{(\{?)\s*([^{}]*?)\s*\}\}/g;
const PATH = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;

function parsePath(raw: string, source: string): string[] {
  if (!PATH.test(raw)) throw new TemplateError(`Invalid variable "${raw}" in ${source}`);
  return raw.split('.');
}

/** Parses a template once, so syntax errors surface when it is defined, not when it is used. */
export function compile(template: string, source = 'template'): CompiledTemplate {
  const root: Node[] = [];
  const stack: { node: Node | null; target: Node[]; open: 'root' | 'if' | 'else' | 'each' }[] = [
    { node: null, target: root, open: 'root' },
  ];
  const top = () => stack[stack.length - 1]!;
  let last = 0;
  for (const match of template.matchAll(TAG)) {
    const [whole, brace, inner] = match;
    if (match.index > last)
      top().target.push({ kind: 'text', text: template.slice(last, match.index) });
    last = match.index + whole.length;
    if (brace) throw new TemplateError(`Unescaped output {{{…}}} is not allowed in ${source}`);
    const words = inner!.split(/\s+/);
    const head = words[0]!;
    if (head === '#if' && words.length === 2) {
      const node: Node = {
        kind: 'if',
        path: parsePath(words[1]!, source),
        then: [],
        otherwise: [],
      };
      top().target.push(node);
      stack.push({ node, target: node.then, open: 'if' });
    } else if (head === 'else' && words.length === 1) {
      const frame = top();
      if (frame.open !== 'if' || frame.node?.kind !== 'if')
        throw new TemplateError(`{{else}} outside {{#if}} in ${source}`);
      stack.pop();
      stack.push({ node: frame.node, target: frame.node.otherwise, open: 'else' });
    } else if (head === '/if' && words.length === 1) {
      const frame = stack.pop()!;
      if (frame.open !== 'if' && frame.open !== 'else')
        throw new TemplateError(`Unexpected {{/if}} in ${source}`);
    } else if (head === '#each' && words.length === 4 && words[2] === 'as') {
      const alias = words[3]!;
      if (!/^[a-z][A-Za-z0-9]*$/.test(alias))
        throw new TemplateError(`Invalid alias "${alias}" in ${source}`);
      const node: Node = { kind: 'each', path: parsePath(words[1]!, source), alias, body: [] };
      top().target.push(node);
      stack.push({ node, target: node.body, open: 'each' });
    } else if (head === '/each' && words.length === 1) {
      if (stack.pop()!.open !== 'each')
        throw new TemplateError(`Unexpected {{/each}} in ${source}`);
    } else if ((head === 'date' || head === 'digits') && words.length === 2) {
      top().target.push({ kind: 'value', helper: head, path: parsePath(words[1]!, source) });
    } else if (words.length === 1 && !head.startsWith('#') && !head.startsWith('/')) {
      top().target.push({ kind: 'value', helper: 'none', path: parsePath(head, source) });
    } else {
      throw new TemplateError(`Unknown tag {{${inner}}} in ${source}`);
    }
  }
  if (stack.length !== 1) throw new TemplateError(`Unclosed {{#${top().open}}} in ${source}`);
  if (last < template.length) root.push({ kind: 'text', text: template.slice(last) });
  return { nodes: root };
}

export interface RenderOptions {
  language: platformV1.DocumentLanguage;
  /** The jurisdiction's calendar, used for `{{date}}` in `fa`. */
  calendar: platformV1.JurisdictionCalendar;
}

const MISSING = Symbol('missing');

function lookup(scope: Record<string, unknown>, path: readonly string[]): unknown {
  let value: unknown = scope;
  for (const key of path) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return MISSING;
    value = (value as Record<string, unknown>)[key];
  }
  return value === undefined ? MISSING : value;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
export function persianDigits(text: string): string {
  return text.replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)]!);
}

const MONTHS_EN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** A business date as printed on a document; no Intl, so output cannot drift with ICU data. */
export function formatDocumentDate(date: string, options: RenderOptions): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    throw new TemplateError(`"${date}" is not a business date`);
  if (options.language === 'fa') {
    const d = options.calendar.fromBusinessDate(date as platformV1.BusinessDate);
    const pad = (n: number) => String(n).padStart(2, '0');
    return persianDigits(`${d.year}/${pad(d.month)}/${pad(d.day)}`);
  }
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS_EN[m - 1]} ${y}`;
}

function print(
  value: unknown,
  helper: 'none' | 'date' | 'digits',
  path: string,
  options: RenderOptions,
): string {
  if (value === MISSING) throw new TemplateError(`Missing value for {{${path}}}`);
  if (value === null) return '';
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint')
    throw new TemplateError(`{{${path}}} is not text or a number`);
  const text = String(value);
  if (helper === 'date') return escapeHtml(formatDocumentDate(text, options));
  if (helper === 'digits')
    return escapeHtml(options.language === 'fa' ? persianDigits(text) : text);
  return escapeHtml(text);
}

function truthy(value: unknown): boolean {
  if (value === MISSING || value === null || value === false || value === '') return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function renderNodes(
  nodes: readonly Node[],
  scope: Record<string, unknown>,
  options: RenderOptions,
): string {
  let out = '';
  for (const node of nodes) {
    if (node.kind === 'text') out += node.text;
    else if (node.kind === 'value')
      out += print(lookup(scope, node.path), node.helper, node.path.join('.'), options);
    else if (node.kind === 'if')
      out += renderNodes(
        truthy(lookup(scope, node.path)) ? node.then : node.otherwise,
        scope,
        options,
      );
    else {
      const list = lookup(scope, node.path);
      if (!Array.isArray(list))
        throw new TemplateError(`{{#each ${node.path.join('.')}}} is not a list`);
      for (const item of list)
        out += renderNodes(node.body, { ...scope, [node.alias]: item }, options);
    }
  }
  return out;
}

export function render(
  template: CompiledTemplate,
  data: Record<string, unknown>,
  options: RenderOptions,
): string {
  return renderNodes(template.nodes, data, options);
}
