import { SampleNoticeV1 } from './platform/documents/sample/sample-notice.template';
import type { DefinedDocumentTemplate } from './platform/documents/template';

/**
 * Every document template version ever published, old versions included. Each has a committed
 * golden file in `documents-golden/` with its fingerprint, so a published version can never
 * change unnoticed: changing a template means publishing its next version. Packs add theirs here.
 */
export const PUBLISHED_DOCUMENT_TEMPLATES: readonly DefinedDocumentTemplate[] = [
  // Test-only sample that proves the mechanism; not registered in the running application.
  SampleNoticeV1,
];
