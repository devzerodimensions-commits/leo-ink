import { useState, type ReactNode } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuth, type Action } from '../lib/auth';
import { ROLE_LABELS } from '../lib/format';
import { Badge, Button, cx } from './ui';

interface NavItem {
  to: string;
  label: string;
  module: string;
  action?: Action;
  end?: boolean;
}

interface NavGroup {
  heading: string;
  items: NavItem[];
}

/** Nav mirrors the §2.3 permission matrix — FR-716: unpermitted modules are hidden *and* blocked. */
const NAV: NavGroup[] = [
  {
    heading: 'Sell',
    items: [
      { to: '/', label: 'Dashboard', module: 'reports', end: true },
      { to: '/enquiries', label: 'Enquiries', module: 'crm' },
      { to: '/quotes', label: 'Quotations', module: 'quotation' },
      { to: '/follow-ups', label: 'My follow-ups', module: 'crm' },
    ],
  },
  {
    heading: 'Produce',
    items: [
      { to: '/board', label: 'Job board', module: 'production' },
      { to: '/jobcards', label: 'Jobcards', module: 'jobcard' },
      { to: '/my-jobs', label: 'My jobs', module: 'production' },
      { to: '/scan', label: 'Scan job QR', module: 'production' },
    ],
  },
  {
    heading: 'Masters',
    items: [
      { to: '/customers', label: 'Customers', module: 'crm' },
      { to: '/materials', label: 'Materials & media', module: 'inventory' },
      { to: '/rate-cards', label: 'Rate cards', module: 'inventory' },
    ],
  },
  {
    heading: 'Configure',
    items: [
      { to: '/setup', label: 'Setup & masters', module: 'setup' },
      { to: '/setup/users', label: 'Users & roles', module: 'users' },
    ],
  },
];

export function Layout({ children }: { children: ReactNode }) {
  const { session, can, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);

  const groups = NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) => can(i.module, i.action ?? 'R')),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="flex min-h-screen">
      {/* Sidebar */}
      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-40 w-64 shrink-0 overflow-y-auto bg-ink-950 text-slate-300 transition-transform lg:static lg:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex h-14 items-center gap-2 px-5">
          <span className="grid size-7 place-items-center rounded-md bg-ink-500 text-sm font-bold text-white">L</span>
          <div className="leading-tight">
            <p className="text-sm font-semibold text-white">Leo Ink</p>
            <p className="text-[10px] uppercase tracking-wider text-ink-300">Simplifying print business</p>
          </div>
        </div>

        <nav className="px-3 pb-8">
          {groups.map((group) => (
            <div key={group.heading} className="mt-5">
              <p className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-ink-400">
                {group.heading}
              </p>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    cx(
                      'block rounded-lg px-3 py-2 text-[13px] transition-colors',
                      isActive ? 'bg-ink-700 font-medium text-white' : 'hover:bg-ink-900 hover:text-white',
                    )
                  }
                >
                  {item.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {open && <div className="fixed inset-0 z-30 bg-slate-900/40 lg:hidden" onClick={() => setOpen(false)} />}

      {/* Main */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-14 items-center justify-between gap-3 border-b border-slate-200 bg-white/90 px-4 backdrop-blur lg:px-6">
          <Button variant="ghost" size="sm" className="lg:hidden" onClick={() => setOpen((v) => !v)}>
            ☰
          </Button>

          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-slate-800">
              {session?.tenant.tradeName || session?.tenant.legalName}
            </p>
            <p className="truncate text-[11px] text-slate-500">
              {session?.tenant.gstin ? `GSTIN ${session.tenant.gstin}` : 'GSTIN not set'}
              {session?.subscription?.status === 'TRIAL' && ' · Free trial'}
            </p>
          </div>

          {!session?.tenant.goLiveReady && (
            <Badge tone="amber">
              <button onClick={() => navigate('/setup')}>Finish setup</button>
            </Badge>
          )}

          <div className="flex items-center gap-3">
            <div className="hidden text-right sm:block">
              <p className="text-[13px] font-medium text-slate-800">{session?.user.name}</p>
              <p className="text-[11px] text-slate-500">{ROLE_LABELS[session?.user.role ?? ''] ?? session?.user.role}</p>
            </div>
            <Button variant="secondary" size="sm" onClick={logout}>
              Sign out
            </Button>
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
