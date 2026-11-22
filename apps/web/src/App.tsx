import { t } from './i18n/t';

/** Empty application shell: navy side menu on the inline-start edge, white content area. */
export function App() {
  return (
    <div className="flex min-h-screen flex-col bg-surface text-navy md:flex-row">
      <nav
        aria-label={t('app.nav.label')}
        className="shrink-0 bg-navy px-5 py-6 text-cream-on-navy md:w-60"
      >
        <span
          data-testid="brand"
          className="inline-block border-b-[6px] border-red pb-1 text-brand text-cream-on-navy"
        >
          {t('app.brand')}
        </span>
      </nav>
      <main className="flex-1 px-7 py-6">
        <p className="text-label text-red-dark">{t('app.shell.eyebrow')}</p>
        <h1 className="text-page-title">{t('app.shell.title')}</h1>
        <p className="text-body text-ink-muted">{t('app.shell.status')}</p>
      </main>
    </div>
  );
}
