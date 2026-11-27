import { z } from 'zod';
import { defineDocumentTemplate } from '../template';

/**
 * Test-only sample that proves the document mechanism (golden file, rendering, determinism); not
 * registered in the running application. The platform itself issues no documents; packs do.
 */
export const SampleNoticeV1 = defineDocumentTemplate({
  id: 'platform.sample_notice',
  version: 1,
  schema: z.object({
    recipient: z.string().min(1),
    subject: z.string().min(1),
    effectiveDate: z.iso.date(),
    items: z.array(z.object({ title: z.string(), note: z.string().nullable() })),
  }),
  body: {
    fa: `<h1 class="title">{{subject}}</h1>
<p>{{recipient}} گرامی،</p>
<p>بدین‌وسیله به اطلاع می‌رساند موارد زیر از تاریخ <bdi>{{date effectiveDate}}</bdi> اجرا می‌شود:</p>
<ol>{{#each items as item}}<li>{{item.title}}{{#if item.note}} ({{item.note}}){{/if}}</li>{{/each}}</ol>`,
    en: `<h1 class="title">{{subject}}</h1>
<p>Dear {{recipient}},</p>
<p>The following items take effect on {{date effectiveDate}}:</p>
<ol>{{#each items as item}}<li>{{item.title}}{{#if item.note}} ({{item.note}}){{/if}}</li>{{/each}}</ol>`,
  },
  css: '.title { font-size: 13pt; text-align: center; margin-block: 0 6mm; }',
});
