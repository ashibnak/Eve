import {
  Building2,
  FileInput,
  GitBranch,
  Inbox,
  ListTree,
  Settings,
  ShieldAlert,
  User,
  Workflow,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { t, type MessageKey } from '../i18n/t';
import { Button } from '../ui/Button';
import { DateInput, Select } from '../ui/kit';
import { ChangeRequestPage } from '../pages/ChangeRequestPage';
import { ChangesPage } from '../pages/ChangesPage';
import { ChartPage } from '../pages/ChartPage';
import { FindingsPage } from '../pages/FindingsPage';
import { ImportPage } from '../pages/ImportPage';
import { InboxPage } from '../pages/InboxPage';
import { MyPositionPage } from '../pages/MyPositionPage';
import { PositionCardPage } from '../pages/PositionCardPage';
import { PositionsPage } from '../pages/PositionsPage';
import { SetupPage } from '../pages/SetupPage';
import { Link, matchPath, useRouter } from './router';
import { useWorkspace } from './workspace';

interface NavItem {
  path: string;
  label: MessageKey;
  icon: typeof Inbox;
  show: boolean;
}

/** Signed-in shell: navy side menu on the inline-start edge, white content area. */
export function Shell({ onLogout }: { onLogout: () => void }) {
  const { me, company, companies, selectCompany, asOf, setAsOf, isSystemAdmin } = useWorkspace();
  const { location } = useRouter();
  const can = company?.can;
  const items: NavItem[] = [
    { path: '/', label: 'nav.inbox', icon: Inbox, show: true },
    { path: '/me', label: 'nav.me', icon: User, show: Boolean(company?.myPersonId) },
    { path: '/chart', label: 'nav.chart', icon: GitBranch, show: Boolean(can?.readStructure) },
    {
      path: '/positions',
      label: 'nav.positions',
      icon: ListTree,
      show: Boolean(can?.readStructure),
    },
    {
      path: '/findings',
      label: 'nav.findings',
      icon: ShieldAlert,
      show: Boolean(can?.readStructure),
    },
    {
      path: '/changes',
      label: 'nav.changes',
      icon: Workflow,
      show: Boolean(can?.requestChange || can?.approveChange),
    },
    { path: '/import', label: 'nav.import', icon: FileInput, show: Boolean(can?.importStructure) },
    { path: '/setup', label: 'nav.setup', icon: Settings, show: isSystemAdmin },
  ];
  const active = (path: string) =>
    path === '/'
      ? location.path === '/'
      : location.path === path || location.path.startsWith(`${path}/`);

  return (
    <div className="flex min-h-screen flex-col bg-surface text-navy md:flex-row">
      <nav
        aria-label={t('app.nav.label')}
        className="flex shrink-0 flex-col gap-5 bg-navy px-5 py-6 text-cream-on-navy print:hidden md:w-60"
      >
        <span
          data-testid="brand"
          className="inline-block self-start border-b-[6px] border-red pb-1 text-brand text-cream-on-navy"
        >
          {t('app.brand')}
        </span>
        <ul className="flex flex-col gap-1">
          {items
            .filter((i) => i.show)
            .map((item) => {
              const Icon = item.icon;
              const on = active(item.path);
              return (
                <li key={item.path}>
                  <Link
                    to={item.path}
                    aria-current={on ? 'page' : undefined}
                    className={`flex items-center gap-2 px-3 py-2 text-body-strong ${
                      on
                        ? 'bg-red text-on-red'
                        : 'text-cream-on-navy hover:bg-cream-on-navy hover:text-navy'
                    }`}
                  >
                    <Icon size={18} strokeWidth={2.5} aria-hidden="true" />
                    {t(item.label)}
                  </Link>
                </li>
              );
            })}
        </ul>
        <div className="mt-auto flex flex-col gap-2">
          <p className="text-meta text-steel-soft">
            {t('app.user.signed_in_as', { username: me.username })}
          </p>
          <Button variant="secondary" className="self-start" onClick={onLogout}>
            {t('app.user.logout')}
          </Button>
        </div>
      </nav>
      <main className="min-w-0 flex-1 px-7 py-6">
        <div className="mb-5 flex flex-wrap items-end gap-4 border-b-2 border-navy pb-4 print:hidden">
          {companies.length > 1 && company && (
            <div className="flex items-end gap-2">
              <Building2 size={18} strokeWidth={2.5} aria-hidden="true" className="mb-3" />
              <Select
                id="company"
                label={t('app.company')}
                value={company.companyId}
                onChange={selectCompany}
                options={companies.map((c) => ({ value: c.companyId, label: c.nameFa }))}
              />
            </div>
          )}
          {companies.length === 1 && company && (
            <p className="text-body-strong" data-testid="company-name">
              {company.nameFa}
            </p>
          )}
          <DateInput id="as-of" label={t('app.as_of')} value={asOf} onChange={setAsOf} />
        </div>
        <Routes />
      </main>
    </div>
  );
}

function Routes(): ReactNode {
  const { location } = useRouter();
  const path = location.path;
  const id = (pattern: string) => matchPath(pattern, path)?.id;
  if (path === '/') return <InboxPage />;
  if (path === '/me') return <MyPositionPage />;
  if (path === '/chart') return <ChartPage />;
  if (path === '/positions') return <PositionsPage />;
  if (id('/positions/:id')) return <PositionCardPage id={id('/positions/:id')!} />;
  if (path === '/findings') return <FindingsPage />;
  if (path === '/changes') return <ChangesPage />;
  if (path === '/changes/new') return <ChangeRequestPage id={null} />;
  if (id('/changes/:id')) return <ChangeRequestPage id={id('/changes/:id')!} />;
  if (path === '/import') return <ImportPage />;
  if (path === '/setup') return <SetupPage />;
  return <p className="text-body text-ink-muted">{t('app.not_found')}</p>;
}
