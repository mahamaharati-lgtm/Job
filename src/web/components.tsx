import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { REVIEW_REASON_LABELS, STATUS_LABELS, TRACK_LABELS, type JobStatus, type ReviewReason, type Track } from '../shared/types';

/** Small shared UI building blocks. */

const STATUS_CLASS: Record<JobStatus, string> = {
  found: 'b-gray',
  matched: 'b-blue',
  resume_ready: 'b-violet',
  needs_review: 'b-amber',
  needs_input: 'b-amber',
  submitted: 'b-green',
  failed: 'b-red',
  closed: 'b-gray',
};

export function StatusBadge({ status }: { status: JobStatus }) {
  return <span className={`badge badge-dot ${STATUS_CLASS[status]}`}>{STATUS_LABELS[status]}</span>;
}

export function reasonLabel(reason: string | null | undefined): string | null {
  if (!reason) return null;
  return REVIEW_REASON_LABELS[reason as ReviewReason] ?? reason;
}

export function ScoreBadge({ score, eligible = true }: { score: number | null; eligible?: boolean }) {
  if (score === null) return <span className="score score-lo">–</span>;
  const cls = !eligible ? 'score-lo' : score >= 75 ? 'score-hi' : score >= 60 ? 'score-mid' : 'score-lo';
  return (
    <span className={`score ${cls}`} title={eligible ? `Match score ${score}/100` : `Score ${score}/100 — not eligible as configured`}>
      {score}
      {!eligible && '!'}
    </span>
  );
}

export function TrackChips({ tracks }: { tracks: Track[] }) {
  return (
    <span className="row" style={{ gap: 4 }}>
      {tracks
        .filter((t) => t !== 'other')
        .map((t) => (
          <span key={t} className={`badge ${t === 'frontend' ? 'b-primary' : t === 'ai' ? 'b-violet' : 'b-gray'}`}>
            {TRACK_LABELS[t]}
          </span>
        ))}
    </span>
  );
}

export function Toggle({ checked, onChange, label, danger, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; danger?: boolean; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`toggle${danger ? ' danger' : ''}`}
      onClick={() => onChange(!checked)}
    />
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function Loading() {
  return (
    <div className="empty">
      <Spinner />
    </div>
  );
}

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="card-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="card-body">{children}</div>
      </div>
    </div>
  );
}

/** Editable list of short strings (keywords, cities, companies...). */
export function TagInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const parts = draft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((s) => !value.includes(s));
    if (parts.length) onChange([...value, ...parts]);
    setDraft('');
  };
  return (
    <div className="stack-sm">
      <div className="row" style={{ gap: 6 }}>
        {value.map((v) => (
          <span key={v} className="chip">
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        value={draft}
        placeholder={placeholder ?? 'Type and press Enter'}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            add();
          }
        }}
        onBlur={add}
      />
    </div>
  );
}

export function fmtDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return withTime ? d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}

export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
interface Toast {
  id: number;
  text: string;
  error?: boolean;
}
const ToastCtx = createContext<(text: string, error?: boolean) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast${t.error ? ' err' : ''}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function useToast() {
  return useContext(ToastCtx);
}
