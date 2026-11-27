import type { platformV1 } from '@eve/contracts';

/**
 * The frame Iranian organizational letters are printed in: letterhead at the top, the usual
 * number / date / attachment block on the inline-end side, body, and a footer with address and
 * phone. Text in the frame is part of the jurisdiction pack (ADR-010), not UI text.
 *
 * Template syntax is the platform renderer's: `{{x}}` escapes, `{{date x}}` prints a business
 * date in the document language's calendar, `{{digits x}}` uses Persian digits in `fa`.
 */
const fa = `<div class="frame" dir="rtl" lang="fa">
<header class="lh">
  <div class="lh-brand">
    {{#if letterhead.logo}}<img class="lh-logo" src="{{letterhead.logo}}" alt="">{{/if}}
    <div class="lh-name">{{letterhead.nameFa}}</div>
  </div>
  <dl class="lh-meta">
    <div><dt>شماره:</dt><dd><bdi>{{#if document.number}}{{digits document.number}}{{else}}—{{/if}}</bdi></dd></div>
    <div><dt>تاریخ:</dt><dd><bdi>{{date document.date}}</bdi></dd></div>
    <div><dt>پیوست:</dt><dd>{{#if document.attachments}}{{document.attachments}}{{else}}ندارد{{/if}}</dd></div>
  </dl>
</header>
<main class="body"><!--body--></main>
<footer class="ft">
  {{#if letterhead.footerFa}}<div>{{letterhead.footerFa}}</div>{{/if}}
  <div>{{#if letterhead.addressFa}}{{letterhead.addressFa}}{{/if}}{{#if letterhead.phone}} · تلفن: <bdi>{{digits letterhead.phone}}</bdi>{{/if}}</div>
</footer>
</div>`;

const en = `<div class="frame" dir="ltr" lang="en">
<header class="lh">
  <div class="lh-brand">
    {{#if letterhead.logo}}<img class="lh-logo" src="{{letterhead.logo}}" alt="">{{/if}}
    <div class="lh-name">{{#if letterhead.nameEn}}{{letterhead.nameEn}}{{else}}{{letterhead.nameFa}}{{/if}}</div>
  </div>
  <dl class="lh-meta">
    <div><dt>No.:</dt><dd>{{#if document.number}}{{document.number}}{{else}}—{{/if}}</dd></div>
    <div><dt>Date:</dt><dd>{{date document.date}}</dd></div>
    <div><dt>Attachments:</dt><dd>{{#if document.attachments}}{{document.attachments}}{{else}}None{{/if}}</dd></div>
  </dl>
</header>
<main class="body"><!--body--></main>
<footer class="ft">
  {{#if letterhead.phone}}<div>Tel: {{letterhead.phone}}</div>{{/if}}
</footer>
</div>`;

const css = `
html, body { margin: 0; }
body { font-family: Vazirmatn, sans-serif; font-size: 11.5pt; line-height: 1.9; color: #111; }
.lh { display: flex; justify-content: space-between; align-items: flex-start;
  border-block-end: 2px solid #1c2b4a; padding-block-end: 4mm; margin-block-end: 8mm; }
.lh-brand { display: flex; align-items: center; gap: 4mm; }
.lh-logo { block-size: 18mm; inline-size: auto; }
.lh-name { font-size: 14pt; font-weight: 700; color: #1c2b4a; }
.lh-meta { margin: 0; font-size: 10pt; }
.lh-meta div { display: flex; gap: 2mm; }
.lh-meta dt { font-weight: 600; }
.lh-meta dd { margin: 0; }
.body { min-block-size: 150mm; }
[lang="fa"] ol { list-style-type: persian; }
.ft { position: fixed; inset-block-end: 0; inset-inline: 0; border-block-start: 1px solid #1c2b4a;
  padding-block-start: 2mm; font-size: 8.5pt; color: #444; text-align: center; }
`;

export const iranDocumentLayout: platformV1.DocumentLayout = {
  id: 'ir.letter',
  version: 1,
  page: { size: 'A4', marginsMm: { top: 18, inlineEnd: 20, bottom: 22, inlineStart: 20 } },
  frame: { fa, en },
  css,
};
