import { Navigate, NavLink, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import { useSession } from './auth';
import { Spinner } from './ui';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { Owners, OwnerDetail } from './pages/Owners';
import { Properties, PropertyDetail, CommissionPage } from './pages/Properties';
import { Revenue } from './pages/Revenue';
import { ImportPage } from './pages/Import';
import { Expenses, ExpenseDetail } from './pages/Expenses';
import { Close } from './pages/Close';
import { StatementPreview, StatementHistory } from './pages/Statements';
import { Annual } from './pages/Annual';
import { Communications, Integrations } from './pages/Communications';
import { SettingsPage, AuditLog } from './pages/Settings';
import { SecurityPage } from './pages/Security';
import { OwnerView } from './pages/OwnerView';

function Shell() {
  const { user, can, logout, mfa } = useSession();
  const loc = useLocation();
  if (!user) return <Navigate to="/login" replace state={{ from: loc.pathname + loc.search }} />;
  if (mfa.enrollmentRequired && loc.pathname !== '/security') return <Navigate to="/security" replace />;
  const link = (to: string, label: string) => <NavLink to={to} end={to === '/'}>{label}</NavLink>;
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark"><svg width="18" height="18" viewBox="0 0 32 32"><path d="M7 22l6-6 4 4 8-9" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg></span>Owner Accounting</div>
        <nav className="nav">
          {mfa.enrollmentRequired ? link('/security', 'Security') : <>
          {link('/', 'Dashboard')}
          <div className="nav-group">Accounting</div>{link('/close', 'Monthly close')}{link('/statements', 'Statements')}{link('/annual', 'Annual reports')}
          <div className="nav-group">Data</div>{link('/revenue', 'Revenue')}{link('/import', 'Airbnb import')}{link('/expenses', 'Expenses')}
          <div className="nav-group">Portfolio</div>{link('/owners', 'Owners')}{link('/properties', 'Properties')}{link('/commission', 'Commission settings')}
          <div className="nav-group">System</div>{link('/communications', 'Communications')}{link('/integrations', 'Integrations')}
          {can('audit:read') && link('/audit', 'Audit log')}{link('/security', 'Security')}{link('/settings', 'Settings')}</>}
        </nav>
        <div className="me"><div className="who">{user.name}</div><div className="muted small">{user.role.charAt(0) + user.role.slice(1).toLowerCase()}</div><button className="btn sm" onClick={logout}>Sign out</button></div>
      </aside>
      <main className="main"><Outlet /></main>
    </div>
  );
}

export function App() {
  const { loading } = useSession();
  if (loading) return <Spinner />;
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/view/:token" element={<OwnerView />} />
      <Route element={<Shell />}>
        <Route index element={<Dashboard />} />
        <Route path="owners" element={<Owners />} /><Route path="owners/:id" element={<OwnerDetail />} />
        <Route path="properties" element={<Properties />} /><Route path="properties/:id" element={<PropertyDetail />} />
        <Route path="commission" element={<CommissionPage />} />
        <Route path="revenue" element={<Revenue />} /><Route path="import" element={<ImportPage />} />
        <Route path="expenses" element={<Expenses />} /><Route path="expenses/:id" element={<ExpenseDetail />} />
        <Route path="close" element={<Close />} />
        <Route path="statements" element={<StatementHistory />} /><Route path="statements/:id" element={<StatementPreview />} />
        <Route path="annual" element={<Annual />} />
        <Route path="communications" element={<Communications />} /><Route path="integrations" element={<Integrations />} />
        <Route path="audit" element={<AuditLog />} /><Route path="settings" element={<SettingsPage />} /><Route path="security" element={<SecurityPage />} />
        <Route path="*" element={<div className="page"><h1>Page not found</h1></div>} />
      </Route>
    </Routes>
  );
}
