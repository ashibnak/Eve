/**
 * Forbids Tailwind utilities that use physical directions (left/right) so the UI works in
 * both RTL and LTR (CLAUDE.md rule 12, ADR-010). Use the logical utility instead:
 *   ml-* / mr-*  -> ms-* / me-*       pl-* / pr-*  -> ps-* / pe-*
 *   left-* / right-* -> start-* / end-*   text-left / text-right -> text-start / text-end
 *   border-l / border-r -> border-s / border-e   rounded-l* / rounded-r* -> rounded-s* / rounded-e*
 *   float-left / float-right -> float-start / float-end   scroll-ml/pl etc. -> scroll-ms/ps
 */

// Optional variant prefixes (hover:, md:, rtl: ...) and optional "-" for negative values.
const PHYSICAL = new RegExp(
  String.raw`(?:^|\s)(?:[\w-]+:)*-?(` +
    [
      String.raw`(?:scroll-)?[mp][lr]-\S+`,
      String.raw`(?:left|right)-\S+`,
      String.raw`text-(?:left|right)`,
      String.raw`float-(?:left|right)`,
      String.raw`clear-(?:left|right)`,
      String.raw`border-[lr](?:-\S+)?`,
      String.raw`rounded-(?:[lr]|tl|tr|bl|br)(?:-\S+)?`,
      String.raw`space-x-reverse`,
    ].join('|') +
    String.raw`)(?=\s|$)`,
);

/** @param {string} value @returns {string[]} every physical-direction class in a class list */
export function findPhysicalClasses(value) {
  return value.split(/\s+/).filter((token) => token !== '' && PHYSICAL.test(token));
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Disallow physical-direction Tailwind classes; use logical ones.' },
    messages: {
      physical:
        'Physical-direction class "{{name}}" is not allowed; use the logical equivalent (ms/me, ps/pe, start/end, text-start/end, border-s/e, rounded-s/e).',
    },
    schema: [],
  },
  create(context) {
    /** @param {import('estree').Node} node @param {string} text */
    function check(node, text) {
      for (const name of findPhysicalClasses(text)) {
        context.report({ node, messageId: 'physical', data: { name } });
      }
    }
    return {
      /** @param {any} node */
      JSXAttribute(node) {
        const attr = node.name && node.name.name;
        if (attr !== 'className' && attr !== 'class') return;
        const value = node.value;
        if (!value) return;
        if (value.type === 'Literal' && typeof value.value === 'string') check(value, value.value);
        if (value.type === 'JSXExpressionContainer') {
          const expr = value.expression;
          if (expr.type === 'Literal' && typeof expr.value === 'string') check(expr, expr.value);
          if (expr.type === 'TemplateLiteral') {
            for (const quasi of expr.quasis) check(quasi, quasi.value.cooked ?? '');
          }
        }
      },
    };
  },
};

export default {
  meta: { name: 'eve' },
  rules: { 'no-physical-tailwind': rule },
};
