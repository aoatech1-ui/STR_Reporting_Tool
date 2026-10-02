import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { fmtMoney } from './format';
import { ApiError } from './api';

export function Money({ cents, strong, className = '' }: { cents: number | null | undefined; strong?: boolean; className?: string }) {
  if (cents === null || cents === undefined) return <span className="num muted">—</span>;
  return <span className={`num ${cents < 0 ? 'neg' : ''} ${strong ? 'strong' : ''} ${className}`}>{fmtMoney(cents)}</span>;
}

export type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'info' | 'accent';
export const Badge = ({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) => <span className={`badge ${tone}`}>{children}</span>;

const STATUS_TONE: Record<string, Tone> = {
  DRAFT: 'neutral', REVIEW: 'warn', FINALIZED: 'good', LOCKED: 'info', QUEUED: 'warn', SENT: 'info', DELIVERED: 'good', BOUNCED: 'bad', FAILED: 'bad',
  READY: 'good', DUPLICATE_EXISTING: 'neutral', DUPLICATE_IN_FILE: 'neutral', UNMATCHED_PROPERTY: 'bad', PERIOD_LOCKED: 'warn',
  CRITICAL: 'bad', WARNING: 'warn', INFO: 'neutral', ACTIVE: 'good', INACTIVE: 'neutral',
};
const STATUS_LABEL: Record<string, string> = { DUPLICATE_EXISTING: 'Already imported', DUPLICATE_IN_FILE: 'Duplicate in file', UNMATCHED_PROPERTY: 'No matching property', PERIOD_LOCKED: 'Month is closed', READY: 'Ready to import' };
export const StatusBadge = ({ status }: { status: string }) => <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_LABEL[status] ?? status.charAt(0) + status.slice(1).toLowerCase().replace(/_/g, ' ')}</Badge>;

export function Page({ title, sub, actions, children }: { title: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <header className="page-head">
        <div><h1>{title}</h1>{sub && <p className="sub">{sub}</p>}</div>
        {actions && <div className="actions">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export const Card = ({ title, actions, children, flush, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string }) => (
  <section className={`card ${className}`}>
    {(title || actions) && <div className="card-head"><h2>{title}</h2><div className="actions">{actions}</div></div>}
    <div className={flush ? 'card-body flush' : 'card-body'}>{children}</div>
  </section>
);

export const Kpi = ({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: Tone }) => (
  <div className={`kpi ${tone ?? ''}`}><div className="kpi-label">{label}</div><div className="kpi-value">{value}</div>{sub && <div className="kpi-sub">{sub}</div>}</div>
);

export const Empty = ({ children }: { children: ReactNode }) => <div className="empty">{children}</div>;
export const Spinner = () => <div className="spinner" role="status" aria-label="Loading" />;
export const ErrorBox = ({ error }: { error: unknown }) => <div className="alert bad" role="alert">{error instanceof Error ? error.message : String(error)}</div>;
export const Note = ({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) => <div className={`alert ${tone}`}>{children}</div>;

export function Field({ label, hint, children, wide }: { label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return <label className={`field ${wide ? 'wide' : ''}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', key);
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="modal-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="Close">×</button></div>
        {children}
      </div>
    </div>
  );
}

/** Loads data and exposes reload. Ignores stale responses when inputs change. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data?: T; error?: unknown; loading: boolean }>({ loading: true });
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true }));
    fn().then((data) => { if (n === seq.current) setState({ data, loading: false }); }).catch((error) => { if (n === seq.current) setState({ error, loading: false }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(load, [load]);
  return { ...state, reload: load };
}

export function Loaded<T>({ q, children }: { q: { data?: T; error?: unknown; loading: boolean }; children: (d: T) => ReactNode }) {
  if (q.error && !q.data) return <ErrorBox error={q.error} />;
  if (!q.data) return <Spinner />;
  return <>{children(q.data)}</>;
}

const ToastCtx = createContext<(msg: string, tone?: Tone) => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string; tone: Tone }[]>([]);
  const push = useCallback((msg: string, tone: Tone = 'good') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, msg, tone }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4500);
  }, []);
  return <ToastCtx.Provider value={push}>{children}<div className="toasts" aria-live="polite">{items.map((i) => <div key={i.id} className={`toast ${i.tone}`}>{i.msg}</div>)}</div></ToastCtx.Provider>;
}

/** Runs an async action with busy/error state. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true); setError(null);
    try { return await fn(); } catch (e) { setError(e instanceof ApiError || e instanceof Error ? e.message : String(e)); return undefined; } finally { setBusy(false); }
  }, []);
  return { busy, error, run, setError };
}

export const MonthPicker = ({ value, onChange, label = 'Month' }: { value: string; onChange: (ym: string) => void; label?: string }) => (
  <label className="inline-field"><span>{label}</span><input type="month" value={value} onChange={(e) => e.target.value && onChange(e.target.value)} /></label>
);

export const ConfirmButton = ({ label, confirm, onConfirm, className = 'btn danger', disabled }: { label: string; confirm: string; onConfirm: () => void; className?: string; disabled?: boolean }) => (
  <button className={className} disabled={disabled} onClick={() => { if (window.confirm(confirm)) onConfirm(); }}>{label}</button>
);
