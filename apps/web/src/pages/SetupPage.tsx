import { ArrowDown, ArrowUp, Plus } from 'lucide-react';
import { useState } from 'react';
import { api, ApiError } from '../api';
import { useApi, useWorkspace } from '../app/workspace';
import { t } from '../i18n/t';
import { Button } from '../ui/Button';
import { Field } from '../ui/Field';
import { ErrorNote, Loading, PageHeader, Select } from '../ui/kit';

interface Company {
  id: string;
  code: string;
  jurisdictionCode: string;
}

interface Profile {
  nameFa: string;
  nameEn: string | null;
  codePrefix: string;
  legalFields: Record<string, unknown>;
  levels: { id: string; nameFa: string; nameEn: string | null; rank: number }[];
}

type FormKey = 'nameFa' | 'nameEn' | 'codePrefix' | 'nationalId' | 'ssoWorkshopCode';
const FIELDS: { key: FormKey; label: Parameters<typeof t>[0]; hint?: Parameters<typeof t>[0] }[] = [
  { key: 'nameFa', label: 'setup.name_fa' },
  { key: 'nameEn', label: 'setup.name_en' },
  { key: 'codePrefix', label: 'setup.prefix', hint: 'setup.prefix.help' },
  { key: 'nationalId', label: 'setup.national_id' },
  { key: 'ssoWorkshopCode', label: 'setup.workshop_code' },
];

/** Company setup for the system administrator: org profile and unit levels (decision 2026-11-25). */
export function SetupPage() {
  const { isSystemAdmin } = useWorkspace();
  const companies = useApi<Company[]>(isSystemAdmin ? '/platform/companies' : null);
  const [picked, setPicked] = useState('');
  const companyId = picked || companies.data?.[0]?.id || '';
  const profile = useApi<Profile>(companyId ? `/org/companies/${companyId}/profile` : null);

  if (!isSystemAdmin) return <ErrorNote error={new ApiError(403, undefined)} />;
  // A company without a profile yet answers 404: the form starts empty.
  const missing = profile.error instanceof ApiError && profile.error.status === 404;
  return (
    <section>
      {companies.data && (
        <div className="mb-5">
          <Select
            id="setup-company"
            label={t('setup.company')}
            value={companyId}
            onChange={setPicked}
            options={companies.data.map((c) => ({ value: c.id, label: c.code }))}
          />
        </div>
      )}
      {(companies.loading || (profile.loading && !profile.data)) && <Loading />}
      {/* Stays mounted while the profile reloads after saving, so its "saved" note stays. */}
      {companyId && (profile.data || missing) && (
        <SetupForm
          key={companyId}
          companyId={companyId}
          profile={profile.data}
          onSaved={profile.reload}
        />
      )}
    </section>
  );
}

function SetupForm({
  companyId,
  profile,
  onSaved,
}: {
  companyId: string;
  profile: Profile | null;
  onSaved: () => void;
}) {
  const { reloadCompanies } = useWorkspace();
  const [form, setForm] = useState<Record<FormKey, string>>({
    nameFa: profile?.nameFa ?? '',
    nameEn: profile?.nameEn ?? '',
    codePrefix: profile?.codePrefix ?? '',
    nationalId: String(profile?.legalFields.nationalId ?? ''),
    ssoWorkshopCode: String(profile?.legalFields.ssoWorkshopCode ?? ''),
  });
  const [levels, setLevels] = useState<{ id?: string; nameFa: string }[]>(
    profile?.levels.map((l) => ({ id: l.id, nameFa: l.nameFa })) ?? [],
  );
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const move = (i: number, by: -1 | 1) =>
    setLevels((all) => {
      const next = [...all];
      const j = i + by;
      if (j < 0 || j >= next.length) return all;
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  const save = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api('POST', `/org/companies/${companyId}/profile`, {
        nameFa: form.nameFa.trim(),
        nameEn: form.nameEn.trim() || null,
        codePrefix: form.codePrefix.trim().toUpperCase(),
        legalFields: {
          nationalId: form.nationalId.trim(),
          ssoWorkshopCode: form.ssoWorkshopCode.trim(),
        },
        reason: t('setup.reason'),
      });
      const named = levels.filter((l) => l.nameFa.trim());
      if (named.length > 0) {
        await api('PUT', `/org/companies/${companyId}/unit-levels`, {
          levels: named.map((l) => ({ ...(l.id ? { id: l.id } : {}), nameFa: l.nameFa.trim() })),
          reason: t('setup.reason'),
        });
      }
      setSaved(true);
      await reloadCompanies();
      onSaved();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={t('setup.eyebrow')}
        title={t('setup.title')}
        status={t('setup.status')}
        tools={
          <Button
            variant="primary"
            disabled={busy || !form.nameFa.trim() || !form.codePrefix.trim()}
            onClick={save}
          >
            {t('setup.save')}
          </Button>
        }
      />
      {error !== null && (
        <p
          role="alert"
          className="mb-4 border-2 border-red-dark px-4 py-3 text-body-strong text-red-dark"
        >
          {error instanceof ApiError && (error.status === 400 || error.status === 409)
            ? t('setup.refused')
            : t('ui.error.generic')}
        </p>
      )}
      {saved && (
        <p
          role="status"
          className="mb-4 border-2 border-success px-4 py-3 text-body-strong text-success"
        >
          {t('setup.saved')}
        </p>
      )}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <section className="flex flex-col gap-3 border-2 border-navy p-5">
          <h2 className="text-heading">{t('setup.profile')}</h2>
          {FIELDS.map((f) => (
            <Field
              key={f.key}
              id={`setup-${f.key}`}
              label={t(f.label)}
              hint={f.hint ? t(f.hint) : undefined}
              value={form[f.key]}
              onChange={(e) => setForm({ ...form, [f.key]: e.target.value })}
            />
          ))}
        </section>
        <section className="flex flex-col gap-3 border-2 border-navy p-5">
          <h2 className="text-heading">{t('setup.levels')}</h2>
          <p className="text-meta text-ink-muted">{t('setup.levels.help')}</p>
          <ol className="flex flex-col gap-2">
            {levels.map((l, i) => (
              <li key={l.id ?? `new-${i}`} className="flex items-end gap-2">
                <Field
                  id={`level-${i}`}
                  label={t('setup.level', { rank: String(i + 1) })}
                  value={l.nameFa}
                  onChange={(e) =>
                    setLevels((all) =>
                      all.map((x, j) => (j === i ? { ...x, nameFa: e.target.value } : x)),
                    )
                  }
                />
                <Button
                  variant="ghost"
                  onClick={() => move(i, -1)}
                  aria-label={t('setup.level.up')}
                >
                  <ArrowUp size={16} strokeWidth={2.5} aria-hidden="true" />
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => move(i, 1)}
                  aria-label={t('setup.level.down')}
                >
                  <ArrowDown size={16} strokeWidth={2.5} aria-hidden="true" />
                </Button>
              </li>
            ))}
          </ol>
          <Button
            className="self-start"
            onClick={() => setLevels((all) => [...all, { nameFa: '' }])}
          >
            <Plus size={16} strokeWidth={2.5} aria-hidden="true" />
            {t('setup.level.add')}
          </Button>
        </section>
      </div>
    </>
  );
}
