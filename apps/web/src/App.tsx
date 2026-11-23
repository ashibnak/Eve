import { useEffect, useState } from 'react';
import { api, type Me } from './api';
import { t } from './i18n/t';
import { LoginPage } from './LoginPage';
import { Button } from './ui/Button';

type Session = { kind: 'loading' } | { kind: 'signed-out' } | { kind: 'signed-in'; me: Me };

export function App() {
  const [session, setSession] = useState<Session>({ kind: 'loading' });

  useEffect(() => {
    api<Me>('GET', '/auth/me')
      .then((me) => setSession({ kind: 'signed-in', me }))
      .catch(() => setSession({ kind: 'signed-out' }));
  }, []);

  if (session.kind === 'loading') {
    return <p className="p-7 text-body text-ink-muted">{t('app.loading')}</p>;
  }
  if (session.kind === 'signed-out') {
    const signIn = (me: Me) => setSession({ kind: 'signed-in', me });
    return <LoginPage onSignedIn={signIn} />;
  }

  async function logout() {
    await api('POST', '/auth/logout').catch(() => undefined);
    setSession({ kind: 'signed-out' });
  }

  return <Shell me={session.me} onLogout={logout} />;
}

/** Signed-in shell: navy side menu on the inline-start edge, white content area. */
function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  return (
    <div className="flex min-h-screen flex-col bg-surface text-navy md:flex-row">
      <nav
        aria-label={t('app.nav.label')}
        className="flex shrink-0 flex-col gap-6 bg-navy px-5 py-6 text-cream-on-navy md:w-60"
      >
        <span
          data-testid="brand"
          className="inline-block self-start border-b-[6px] border-red pb-1 text-brand text-cream-on-navy"
        >
          {t('app.brand')}
        </span>
        <div className="mt-auto flex flex-col gap-2">
          <p className="text-meta text-steel-soft">
            {t('app.user.signed_in_as', { username: me.username })}
          </p>
          <Button variant="secondary" className="self-start" onClick={onLogout}>
            {t('app.user.logout')}
          </Button>
        </div>
      </nav>
      <main className="flex-1 px-7 py-6">
        <p className="text-label text-red-dark">{t('app.shell.eyebrow')}</p>
        <h1 className="text-page-title">{t('app.shell.title')}</h1>
        <p className="text-body text-ink-muted">{t('app.shell.status')}</p>
      </main>
    </div>
  );
}
