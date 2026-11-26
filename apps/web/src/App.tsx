import { useEffect, useState } from 'react';
import { api, type Me } from './api';
import { RouterProvider } from './app/router';
import { Shell } from './app/Shell';
import { WorkspaceProvider } from './app/workspace';
import { t } from './i18n/t';
import { LoginPage } from './LoginPage';

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

  return (
    <RouterProvider>
      <WorkspaceProvider me={session.me}>
        <Shell onLogout={logout} />
      </WorkspaceProvider>
    </RouterProvider>
  );
}
