import { useState, type FormEvent } from 'react';
import { api } from '../api';

export function LoginPage({ configured, onDone }: { configured: boolean; onDone: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', { password });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login">
      <form className="card card-pad stack" onSubmit={submit}>
        <div className="brand" style={{ padding: 0 }}>
          <span className="brand-mark">✓</span> Job Autopilot
        </div>
        {!configured ? (
          <div className="alert alert-warn">
            <div>
              <strong>Set a dashboard password</strong>Add <code>ADMIN_PASSWORD</code> (or <code>ADMIN_PASSWORD_HASH</code>) to the server environment and restart.
            </div>
          </div>
        ) : (
          <>
            <label className="field">
              Password
              <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
            </label>
            {error && <div className="alert alert-danger">{error}</div>}
            <button className="btn btn-primary" disabled={busy || !password}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
