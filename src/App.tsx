import { lazy, Suspense, useEffect, useState } from 'react';
import { HashRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { BrandMark, Icon, Modal, Spinner, Toasts } from './components/ui';
import { can, ROLE_LABEL, type Role } from './lib/model';
import { applyTheme, errText, loadAll, setState, supabase, toast, useStore } from './lib/store';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const Keyplan = lazy(() => import('./pages/Keyplan'));
const QaQc = lazy(() => import('./pages/QaQc'));
const Subcontractors = lazy(() => import('./pages/Subcontractors'));
const Admin = lazy(() => import('./pages/Admin'));
const Mechanical = lazy(() => import('./pages/Works').then((m) => ({ default: m.Mechanical })));
const Electrical = lazy(() => import('./pages/Works').then((m) => ({ default: m.Electrical })));

export default function App() {
  const authChecked = useStore((s) => s.authChecked); const session = useStore((s) => s.session);
  const profile = useStore((s) => s.profile); const loading = useStore((s) => s.loading); const error = useStore((s) => s.error);
  const loadedAt = useStore((s) => s.loadedAt); const theme = useStore((s) => s.theme); const recovery = useStore((s) => s.recovery);
  useEffect(() => { applyTheme(theme); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { // keep figures fresh while the tab is visible
    const t = setInterval(() => { if (document.visibilityState === 'visible' && useStore.length >= 0 && profile?.role) loadAll(); }, 180000);
    return () => clearInterval(t);
  }, [profile?.role]);
  if (!authChecked) return <Spinner label="Starting…" />;
  if (!session) return <><Login /><Toasts /></>;
  if (recovery) return <><NewPassword /><Toasts /></>;
  if (error && !loadedAt) return <div className="page"><div className="flag error" style={{ marginTop: 40 }}><div><b>The project data didn’t load.</b> {error} <button className="btn sm" onClick={loadAll}>Try again</button></div></div></div>;
  if (!profile || (loading && !loadedAt)) return <Spinner label="Loading the project database…" />;
  if (!profile.role || !profile.active) return <><Pending /><Toasts /></>;
  return (
    <HashRouter>
      <Shell role={profile.role}>
        <Suspense fallback={<Spinner />}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/keyplan" element={<Keyplan />} />
            <Route path="/mechanical" element={<Mechanical />} />
            <Route path="/electrical" element={<Electrical />} />
            <Route path="/qaqc" element={<QaQc />} />
            {can(profile.role, 'view.comparison') && <Route path="/subcontractors" element={<Subcontractors />} />}
            {can(profile.role, 'view.comparison') && <Route path="/subcontractors/:code" element={<Subcontractors />} />}
            {can(profile.role, 'admin') && <Route path="/admin" element={<Admin />} />}
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </Shell>
      <Toasts />
    </HashRouter>
  );
}

function Shell({ role, children }: { role: Role; children: React.ReactNode }) {
  const profile = useStore((s) => s.profile); const projectName = useStore((s) => s.projectName);
  const [menu, setMenu] = useState(false); const [more, setMore] = useState(false);
  const loc = useLocation();
  useEffect(() => { setMore(false); setMenu(false); }, [loc.pathname]);
  const links: [string, string][] = [['/', 'Dashboard'], ['/keyplan', 'Digital keyplan'], ['/mechanical', 'Mechanical works'], ['/electrical', 'Electrical works'], ['/qaqc', 'QA/QC']];
  if (can(role, 'view.comparison')) links.push(['/subcontractors', 'Subcontractors']);
  if (can(role, 'admin')) links.push(['/admin', 'Administration']);
  const initials = (profile?.full_name || profile?.email || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const isKeyplan = loc.pathname === '/keyplan';
  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/keyplan" className="brand" aria-label="Open the digital keyplan"><BrandMark /><span><span className="brand-name">{projectName}</span><br /><span className="brand-sub">One-stop project monitoring</span></span></NavLink>
        <nav className="nav" aria-label="Main">{links.map(([to, l]) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => (isActive ? 'active' : '')}>{l}</NavLink>)}</nav>
        <button className="userbtn" onClick={() => setMenu(true)} aria-label="Account and settings"><span className="avatar">{initials}</span><span className="small" style={{ fontWeight: 600 }}>{ROLE_LABEL[role]}</span></button>
      </header>
      <main className="main" style={isKeyplan ? { overflow: 'hidden' } : undefined}>{children}</main>
      <nav className="tabbar" aria-label="Main">
        <NavLink to="/" end className={({ isActive }) => (isActive ? 'active' : '')}>{Icon.home}Dashboard</NavLink>
        <NavLink to="/keyplan" className={({ isActive }) => (isActive ? 'active' : '')}>{Icon.map}Keyplan</NavLink>
        <NavLink to="/qaqc" className={({ isActive }) => (isActive ? 'active' : '')}>{Icon.check}QA/QC</NavLink>
        <NavLink to="/mechanical" className={({ isActive }) => (isActive ? 'active' : '')}>{Icon.list}Works</NavLink>
        <button onClick={() => setMore(true)}>{Icon.more}More</button>
      </nav>
      {more && <Modal title="More" onClose={() => setMore(false)}><div className="stack tight">{links.filter(([to]) => !['/', '/keyplan', '/qaqc', '/mechanical'].includes(to)).map(([to, l]) => <NavLink key={to} to={to} className="btn block">{l}</NavLink>)}<button className="btn block" onClick={() => { setMore(false); setMenu(true); }}>Account and display</button></div></Modal>}
      {menu && <AccountMenu onClose={() => setMenu(false)} />}
    </div>
  );
}

function AccountMenu({ onClose }: { onClose: () => void }) {
  const profile = useStore((s) => s.profile); const theme = useStore((s) => s.theme); const subcons = useStore((s) => s.subcons);
  const [pw, setPw] = useState('');
  const sub = subcons.find((s) => s.id === profile?.subcontractor_id);
  return (
    <Modal title={profile?.full_name || 'Account'} onClose={onClose} footer={<button className="btn danger" onClick={async () => { await supabase.auth.signOut(); onClose(); }}>Sign out</button>}>
      <div className="stack">
        <p className="small muted">{profile?.email} · {profile?.role ? ROLE_LABEL[profile.role] : ''}{sub ? ` · ${sub.code}` : ''}</p>
        <div className="field"><span>Display</span><div className="seg">{(['system', 'light', 'dark'] as const).map((t) => <button key={t} className={theme === t ? 'on' : ''} onClick={() => applyTheme(t)}>{t === 'system' ? 'Match device' : t === 'light' ? 'Light' : 'Dark'}</button>)}</div></div>
        <div className="row" style={{ alignItems: 'end' }}>
          <label className="field grow"><span>New password</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></label>
          <button className="btn" disabled={pw.length < 8} onClick={async () => { const { error } = await supabase.auth.updateUser({ password: pw }); if (error) toast(errText(error), 'error'); else { toast('Password changed'); setPw(''); } }}>Change password</button>
        </div>
      </div>
    </Modal>
  );
}

function Login() {
  const [email, setEmail] = useState(''); const [pw, setPw] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const notice = useStore((s) => s.authNotice);
  const [mode, setMode] = useState<'signin' | 'reset'>(notice ? 'reset' : 'signin');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr('');
    if (mode === 'reset') {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: location.href.split('#')[0] });
      setBusy(false); if (error) setErr(errText(error)); else toast('If the address has an account, a reset link is on its way.');
      return;
    }
    const { error } = await supabase.auth.signInWithPassword({ email, password: pw });
    setBusy(false);
    if (error) setErr(error.message === 'Invalid login credentials' ? 'That email and password don’t match an account.' : errText(error));
  };
  return (
    <div className="login">
      <div className="login-art">
        <div className="row" style={{ gap: 12 }}><BrandMark size={40} light /><span style={{ fontWeight: 700 }}>One-stop project monitoring</span></div>
        <div>
          <h1>Expansion PV Farm</h1>
          <p>Every table on the keyplan is linked to its installation progress, subcontractor, inspections and approvals. Search a Table ID, open it on the drone image, update it from the field.</p>
        </div>
        <LoginGrid />
      </div>
      <div className="login-form">
        <form onSubmit={submit}>
          <h2>{mode === 'signin' ? 'Sign in' : 'Reset your password'}</h2>
          {notice && mode === 'reset' && <div className="flag warn" role="status">{notice}</div>}
          <label className="field"><span>Email</span><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required /></label>
          {mode === 'signin' && <label className="field"><span>Password</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" required /></label>}
          {err && <div className="flag error" role="alert">{err}</div>}
          <button className="btn primary lg" disabled={busy}>{busy ? 'Please wait…' : mode === 'signin' ? 'Sign in' : 'Send reset link'}</button>
          <button type="button" className="linkbtn small" onClick={() => { setMode(mode === 'signin' ? 'reset' : 'signin'); setErr(''); }}>{mode === 'signin' ? 'Forgot your password?' : 'Back to sign in'}</button>
          <p className="xs faint">Accounts are created by the project administrator. Access depends on your role.</p>
        </form>
      </div>
    </div>
  );
}
function LoginGrid() {
  // a stylised strip of tables: approved, for inspection, not installed (status colours from the brief)
  const cols = ['#34C25A', '#34C25A', '#34C25A', '#E0AE00', '#34C25A', '#8B5CF6', 'none', '#2F6FDB', '#34C25A', 'none', '#34C25A', '#E23C3C', 'none', 'none'];
  return (
    <svg viewBox="0 0 470 70" style={{ width: '100%', maxWidth: 520, opacity: 0.95 }} aria-hidden="true">
      {cols.map((c, i) => { const x = (i % 7) * 66 + 2; const y = Math.floor(i / 7) * 34 + 2; return <g key={i}>
        <rect x={x} y={y} width={62} height={28} rx={2} fill={c === 'none' ? 'transparent' : c} fillOpacity={0.45} stroke="#E6ECF1" strokeOpacity={0.8} strokeWidth={1} />
        {[1, 2, 3, 4, 5, 6].map((k) => <line key={k} x1={x + k * 62 / 7} x2={x + k * 62 / 7} y1={y} y2={y + 28} stroke="#E6ECF1" strokeOpacity={0.25} />)}
        {[1, 2, 3].map((k) => <line key={k} x1={x} x2={x + 62} y1={y + k * 7} y2={y + k * 7} stroke="#E6ECF1" strokeOpacity={0.25} />)}</g>; })}
    </svg>
  );
}

/** After opening a password-reset link the user is signed in; they choose a new password first. */
function NewPassword() {
  const profile = useStore((s) => s.profile); const session = useStore((s) => s.session);
  const [pw, setPw] = useState(''); const [pw2, setPw2] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setErr('');
    if (pw !== pw2) { setErr('The two passwords are different.'); return; }
    setBusy(true);
    const { error } = await supabase.auth.updateUser({ password: pw });
    setBusy(false);
    if (error) { setErr(errText(error)); return; }
    setState({ recovery: false }); toast('Password changed. You’re signed in.');
  };
  return (
    <div className="login" style={{ gridTemplateColumns: '1fr' }}>
      <div className="login-form">
        <form onSubmit={submit}>
          <BrandMark size={40} />
          <h2>Choose a new password</h2>
          <p className="small muted">For {profile?.email || session?.user.email}. Use at least 8 characters.</p>
          <label className="field"><span>New password</span><input type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" minLength={8} required /></label>
          <label className="field"><span>Repeat the new password</span><input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" minLength={8} required /></label>
          {err && <div className="flag error" role="alert">{err}</div>}
          <button className="btn primary lg" disabled={busy || pw.length < 8}>{busy ? 'Please wait…' : 'Save the new password'}</button>
          <button type="button" className="linkbtn small" onClick={() => supabase.auth.signOut()}>Cancel and sign out</button>
        </form>
      </div>
    </div>
  );
}

function Pending() {
  const profile = useStore((s) => s.profile);
  return (
    <div className="login" style={{ gridTemplateColumns: '1fr' }}>
      <div className="login-form"><div style={{ width: 'min(460px, 100%)', margin: '0 auto' }} className="stack">
        <BrandMark size={40} />
        <h2>{profile?.active === false ? 'Your account is disabled' : 'Waiting for access'}</h2>
        <p className="muted">{profile?.active === false ? 'Ask the project administrator to re-enable it.' : `You're signed in as ${profile?.email}, but no role has been assigned yet. The project administrator gives access by assigning your role (and your company, for subcontractors).`}</p>
        <div className="row"><button className="btn" onClick={loadAll}>Check again</button><button className="btn quiet" onClick={() => supabase.auth.signOut()}>Sign out</button></div>
      </div></div>
    </div>
  );
}
