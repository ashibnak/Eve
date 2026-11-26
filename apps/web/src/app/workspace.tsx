import type { orgV1 } from '@eve/contracts';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { api, type Me } from '../api';
import { type IsoDate, todayIso } from '../lib/format';

/**
 * Who is signed in, the companies they work in (with what they may do there), the company they
 * are looking at and the "as of" date every page answers for.
 */
interface WorkspaceValue {
  me: Me;
  companies: orgV1.CompanyWorkspace[];
  company: orgV1.CompanyWorkspace | null;
  selectCompany(companyId: string): void;
  asOf: IsoDate;
  setAsOf(asOf: IsoDate): void;
  today: IsoDate;
  isSystemAdmin: boolean;
  reloadCompanies(): Promise<void>;
}

const WorkspaceContext = createContext<WorkspaceValue | null>(null);
const COMPANY_KEY = 'eve.company';

function remembered(): string | null {
  try {
    return window.localStorage.getItem(COMPANY_KEY);
  } catch {
    return null;
  }
}

function remember(companyId: string): void {
  try {
    window.localStorage.setItem(COMPANY_KEY, companyId);
  } catch {
    // A private window: the choice simply is not kept.
  }
}

export function WorkspaceProvider({ me, children }: { me: Me; children: ReactNode }) {
  const today = useMemo(() => todayIso(), []);
  const [companies, setCompanies] = useState<orgV1.CompanyWorkspace[] | null>(null);
  const [companyId, setCompanyId] = useState<string | null>(remembered);
  const [asOf, setAsOf] = useState<IsoDate>(today);

  const reloadCompanies = useCallback(async () => {
    setCompanies(await api<orgV1.CompanyWorkspace[]>('GET', '/org/companies'));
  }, []);
  useEffect(() => {
    let live = true;
    api<orgV1.CompanyWorkspace[]>('GET', '/org/companies')
      .then((list) => live && setCompanies(list))
      .catch(() => live && setCompanies([]));
    return () => {
      live = false;
    };
  }, []);

  const value = useMemo<WorkspaceValue | null>(() => {
    if (!companies) return null;
    const company = companies.find((c) => c.companyId === companyId) ?? companies[0] ?? null;
    return {
      me,
      companies,
      company,
      selectCompany(id) {
        remember(id);
        setCompanyId(id);
      },
      asOf,
      setAsOf,
      today,
      isSystemAdmin: me.roles.some((r) => r.role === 'system_admin'),
      reloadCompanies,
    };
  }, [companies, companyId, asOf, me, today, reloadCompanies]);

  if (!value) return null;
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace(): WorkspaceValue {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error('useWorkspace outside WorkspaceProvider');
  return value;
}

export interface Loaded<T> {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload(): void;
}

/** Loads `path` (null = nothing to load) and reloads when it changes. */
export function useApi<T>(path: string | null): Loaded<T> {
  const [tick, setTick] = useState(0);
  const request = path === null ? null : `${path}#${tick}`;
  // The last answer and the request it answers; a different request means "loading".
  const [result, setResult] = useState<{ request: string; data: T | null; error: unknown } | null>(
    null,
  );
  useEffect(() => {
    if (path === null || request === null) return;
    let live = true;
    api<T>('GET', path)
      .then((data) => live && setResult({ request, data, error: null }))
      .catch((error: unknown) => live && setResult({ request, data: null, error }));
    return () => {
      live = false;
    };
  }, [path, request]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  if (request === null) return { data: null, error: null, loading: false, reload };
  const current = result?.request === request;
  return {
    // While reloading, the previous answer for the same path stays on screen.
    data: result && (current || result.request.startsWith(`${path}#`)) ? result.data : null,
    error: current ? result?.error : null,
    loading: !current,
    reload,
  };
}
