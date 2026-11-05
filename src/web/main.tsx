import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, type Me, type Overview } from './api';
import { Toggle, ToastProvider, useToast } from './components';
import { OverviewPage } from './pages/Overview';
import { JobsPage } from './pages/Jobs';
import { JobDetailPage } from './pages/JobDetail';
import { ApplicationsPage } from './pages/Applications';
import { ResumesPage } from './pages/Resumes';
import { ProfilePage } from './pages/Profile';
import { SettingsPage } from './pages/Settings';
import { ActivityPage } from './pages/Activity';
import { LoginPage } from './pages/Login';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: true, retry: (n, err) => n < 1 && (err as { status?: number }).status !== 401, staleTime: 5_000 } },
});

const NAV = [
  { to: '/', label: 'Overview', end: true },
  { to: '/jobs', label: 'Jobs' },
  { to: '/applications', label: 'Applications' },
  { to: '/resumes', label: 'Resumes' },
  { to: '/profile', label: 'Profile & answers' },
  { to: '/settings', label: 'Settings' },
  { to: '/activity', label: 'Activity' },
];

function TopBar({ overview }: { overview?: Overview }) {
  const qc = useQueryClient();
  const toast = useToast();
  const pause = useMutation({
    mutationFn: (paused: boolean) => api.post('/api/automation/pause', { paused }),
    onSuccess: (_d, paused) => {
      toast(paused ? 'Automation paused — nothing will be filled or submitted.' : 'Automation resumed.');
      void qc.invalidateQueries();
    },
    onError: (e: Error) => toast(e.message, true),
  });
  const run = useMutation({
    mutationFn: () => api.post('/api/pipeline/run', { force: true }),
    onSuccess: () => {
      toast('Run started: discovering, scoring and preparing jobs…');
      setTimeout(() => void qc.invalidateQueries(), 4000);
    },
    onError: (e: Error) => toast(e.message, true),
  });
  const logout = useMutation({ mutationFn: () => api.post('/api/auth/logout'), onSuccess: () => window.location.reload() });
  const a = overview?.automation;
  return (
    <>
      {a?.paused && (
        <div className="banner banner-paused" role="alert">
          <span>⏸ Automation is paused. No forms will be filled or submitted.</span>
          <button className="btn btn-sm" onClick={() => pause.mutate(false)}>
            Resume
          </button>
        </div>
      )}
      {a && !a.paused && a.dryRun && (
        <div className="banner banner-dry">
          <span>Dry-run mode: forms are filled and screenshotted but never submitted. Turn it off in Settings → Automation when you are ready.</span>
        </div>
      )}
      <header className="topbar">
        <div className="topbar-left">
          {a && (
            <span className={`badge ${a.mode === 'auto' ? 'b-green' : 'b-blue'}`}>{a.mode === 'auto' ? 'Automatic mode' : 'Review-before-submit'}</span>
          )}
          {overview && (
            <span className="small muted">
              {overview.stats.submittedToday}/{overview.stats.dailyLimit} submitted today · schedule: {overview.nextRunHint}
            </span>
          )}
        </div>
        <div className="topbar-right">
          <label className="check small" title="Global pause switch">
            <Toggle danger checked={Boolean(a?.paused)} label="Pause automation" onChange={(v) => pause.mutate(v)} disabled={!a} />
            Pause
          </label>
          <button className="btn btn-primary btn-sm" onClick={() => run.mutate()} disabled={run.isPending || overview?.pipelineRunning}>
            {overview?.pipelineRunning ? 'Running…' : 'Run now'}
          </button>
          <button className="btn btn-ghost btn-sm" onClick={() => logout.mutate()}>
            Sign out
          </button>
        </div>
      </header>
    </>
  );
}

function Shell() {
  const overview = useQuery({ queryKey: ['overview'], queryFn: () => api.get<Overview>('/api/overview'), refetchInterval: 15_000 });
  const attention = (overview.data?.stats.totals.needs_input ?? 0) + (overview.data?.stats.totals.needs_review ?? 0);
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">✓</span> Job Autopilot
        </div>
        <nav className="nav stack-sm" aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              {n.label}
              {n.to === '/applications' && attention > 0 && <span className="nav-count">{attention}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-foot">Your data is encrypted at rest on your own server.</div>
      </aside>
      <div className="main">
        <nav className="mobile-nav" aria-label="Main">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end}>
              {n.label}
            </NavLink>
          ))}
        </nav>
        <TopBar overview={overview.data} />
        <main className="content">
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/jobs" element={<JobsPage />} />
            <Route path="/jobs/:id" element={<JobDetailPage />} />
            <Route path="/applications" element={<ApplicationsPage />} />
            <Route path="/resumes" element={<ResumesPage />} />
            <Route path="/profile" element={<ProfilePage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/activity" element={<ActivityPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

function App() {
  const me = useQuery({ queryKey: ['me'], queryFn: () => api.get<Me>('/api/auth/me') });
  const [, force] = useState(0);
  useEffect(() => {
    const onAuth = () => {
      void queryClient.invalidateQueries({ queryKey: ['me'] });
      force((n) => n + 1);
    };
    window.addEventListener('auth:required', onAuth);
    return () => window.removeEventListener('auth:required', onAuth);
  }, []);
  if (me.isLoading) return null;
  if (!me.data?.authenticated) return <LoginPage configured={me.data?.authConfigured ?? true} onDone={() => void me.refetch()} />;
  return <Shell />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
