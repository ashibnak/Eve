import { type FormEvent, useState } from 'react';
import { api, ApiError, type Me, toAsciiDigits } from './api';
import { type MessageKey, t } from './i18n/t';
import { Button } from './ui/Button';
import { Field } from './ui/Field';

type Step = { kind: 'password' } | { kind: 'code'; sentTo: string };

/** Errors that mean "start the login again". */
const RESTART = new Set(['code_expired', 'code_attempts_exhausted', 'login_expired']);

function errorKey(error: unknown): MessageKey {
  if (error instanceof ApiError && error.code) {
    const key = `auth.error.${error.code}` as MessageKey;
    if (t(key) !== key) return key;
  }
  return 'auth.error.generic';
}

/** Two-step sign-in: password, then the one-time code sent to the user's channel. */
export function LoginPage({ onSignedIn }: { onSignedIn: (me: Me) => void }) {
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitPassword(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { sentTo } = await api<{ sentTo: string }>('POST', '/auth/login', {
        username,
        password,
      });
      setPassword('');
      setStep({ kind: 'code', sentTo });
    } catch (e) {
      setError(errorKey(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('POST', '/auth/code', { code: toAsciiDigits(code).trim() });
      onSignedIn(await api<Me>('GET', '/auth/me'));
    } catch (e) {
      const key = errorKey(e);
      setError(key);
      if (e instanceof ApiError && e.code && RESTART.has(e.code)) restart(key);
    } finally {
      setBusy(false);
    }
  }

  function restart(keepError: MessageKey | null = null) {
    setStep({ kind: 'password' });
    setCode('');
    setError(keepError);
  }

  const errorLine = error && (
    <p role="alert" className="text-body-strong text-red-dark">
      ! {t(error)}
    </p>
  );

  return (
    <main className="flex min-h-screen items-start justify-center bg-surface px-4 py-7">
      <section className="flex w-full max-w-md flex-col gap-5 border-2 border-navy bg-surface p-6 shadow-hard">
        <header className="flex flex-col gap-1">
          <span className="inline-block self-start border-b-[6px] border-red pb-1 text-brand text-navy">
            {t('app.brand')}
          </span>
          <p className="text-label text-red-dark">{t('auth.login.eyebrow')}</p>
          <h1 className="text-title">
            {step.kind === 'password' ? t('auth.login.title') : t('auth.code.title')}
          </h1>
          <p className="text-body text-ink-muted">
            {step.kind === 'password'
              ? t('auth.login.status')
              : t('auth.code.help', { sentTo: step.sentTo })}
          </p>
        </header>

        {step.kind === 'password' ? (
          <form className="flex flex-col gap-4" onSubmit={submitPassword}>
            <Field
              id="username"
              label={t('auth.login.username')}
              autoComplete="username"
              dir="ltr"
              required
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
            <Field
              id="password"
              label={t('auth.login.password')}
              type="password"
              autoComplete="current-password"
              dir="ltr"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {errorLine}
            <Button variant="primary" type="submit" disabled={busy} className="self-start">
              {t('auth.login.submit')}
            </Button>
          </form>
        ) : (
          <form className="flex flex-col gap-4" onSubmit={submitCode}>
            <Field
              id="code"
              label={t('auth.code.label')}
              inputMode="numeric"
              autoComplete="one-time-code"
              dir="ltr"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            {errorLine}
            <div className="flex items-center gap-2">
              <Button variant="primary" type="submit" disabled={busy}>
                {t('auth.code.submit')}
              </Button>
              <Button variant="ghost" onClick={() => restart()}>
                {t('auth.code.restart')}
              </Button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
