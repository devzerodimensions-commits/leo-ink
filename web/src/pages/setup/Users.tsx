import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDateTime, ROLE_LABELS } from '../../lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
} from '../../components/ui';

interface User {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  role: string;
  status: 'INVITED' | 'ACTIVE' | 'DISABLED';
  allBranches: boolean;
  lastLoginAt: string | null;
}

/** GET /setup/subscription — usage against the plan, plus the plan catalogue (FR-722). */
interface SubscriptionView {
  usage: {
    users: { used: number; max: number };
    branches: { used: number; max: number };
  };
  plans: Array<{ code: string; name: string; maxUsers: number; maxBranches: number; current: boolean }>;
  data?: { status: string; trialEndsAt: string | null };
}

const ROLES = ['OWNER_ADMIN', 'ACCOUNTS', 'SALES_COUNTER', 'PRODUCTION_MANAGER', 'OPERATOR', 'DELIVERY'];

const STATUS_TONE = { ACTIVE: 'green', INVITED: 'amber', DISABLED: 'slate' } as const;

export default function UsersPage() {
  const { session } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', phone: '', role: 'SALES_COUNTER', password: '' });
  const [error, setError] = useState<string | null>(null);
  const [limitHit, setLimitHit] = useState(false);

  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ data: User[] }>('/setup/users') });
  const sub = useQuery({ queryKey: ['subscription'], queryFn: () => api.get<SubscriptionView>('/setup/subscription') });

  const invite = useMutation({
    mutationFn: () => api.post('/setup/users', { ...form, phone: form.phone || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['subscription'] });
      setOpen(false);
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setError(err.message);
        setLimitHit(err.payload.code === 'PLAN_LIMIT');
      } else setError('Could not add the user');
    },
  });

  const toggle = useMutation({
    mutationFn: (u: User) => api.put(`/setup/users/${u.id}`, { status: u.status === 'DISABLED' ? 'ACTIVE' : 'DISABLED' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['users'] });
      void qc.invalidateQueries({ queryKey: ['subscription'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not update the user'),
  });

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLimitHit(false);
    invite.mutate();
  }

  const s = sub.data;
  const currentPlan = s?.plans?.find((p) => p.current);
  const seatPct = s ? Math.min(100, (s.usage.users.used / Math.max(1, s.usage.users.max)) * 100) : 0;

  return (
    <>
      <PageHeader
        title="Users & roles"
        subtitle="Permissions are enforced on the server for every request, not just hidden in the menu"
        actions={
          <Button
            onClick={() => {
              setForm({ name: '', email: '', phone: '', role: 'SALES_COUNTER', password: '' });
              setError(null);
              setLimitHit(false);
              setOpen(true);
            }}
          >
            Add user
          </Button>
        }
      />

      {error && !open && (
        <div className="mb-4">
          <Alert tone="rose">{error}</Alert>
        </div>
      )}

      {s && (
        <div className="mb-5">
          <Card className="flex flex-wrap items-center justify-between gap-4 p-4">
            <div>
              <p className="text-[13px] font-medium text-slate-800">
                {currentPlan?.name ?? 'Plan'}{' '}
                {s.data?.status && (
                  <Badge tone={s.data.status === 'TRIAL' ? 'amber' : 'green'}>{s.data.status}</Badge>
                )}
              </p>
              <p className="mt-0.5 text-[12px] text-slate-500">
                {s.usage.users.used}/{s.usage.users.max} seats used · {s.usage.branches.used}/{s.usage.branches.max}{' '}
                branches
                {s.data?.trialEndsAt ? ` · trial ends ${formatDateTime(s.data.trialEndsAt)}` : ''}
              </p>
            </div>
            <div className="h-2 w-40 overflow-hidden rounded-full bg-slate-200">
              <div
                className={seatPct >= 100 ? 'h-full rounded-full bg-rose-500' : 'h-full rounded-full bg-ink-600'}
                style={{ width: `${seatPct}%` }}
              />
            </div>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader title="Team" subtitle="A disabled user loses access immediately but keeps their history" />
        {users.isLoading ? (
          <Spinner />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Role</Th>
                <Th>Status</Th>
                <Th>Last sign-in</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {(users.data?.data ?? []).map((u) => (
                <tr key={u.id} className={u.status === 'DISABLED' ? 'text-slate-400' : 'hover:bg-slate-50'}>
                  <Td>
                    <span className="font-medium text-slate-800">{u.name}</span>
                    {u.id === session?.user.id && (
                      <Badge tone="blue" className="ml-2">
                        You
                      </Badge>
                    )}
                    {u.allBranches && (
                      <Badge tone="slate" className="ml-2">
                        All branches
                      </Badge>
                    )}
                  </Td>
                  <Td>{u.email}</Td>
                  <Td>{ROLE_LABELS[u.role] ?? u.role}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[u.status]}>{u.status}</Badge>
                  </Td>
                  <Td className="text-[12px]">{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Never'}</Td>
                  <Td align="right">
                    {u.id !== session?.user.id && (
                      <Button variant="ghost" size="sm" onClick={() => toggle.mutate(u)}>
                        {u.status === 'DISABLED' ? 'Enable' : 'Disable'}
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add a user"
        subtitle="Each active user consumes a seat on your plan"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button form="user-form" type="submit" disabled={invite.isPending}>
              {invite.isPending ? 'Adding…' : 'Add user'}
            </Button>
          </>
        }
      >
        <form id="user-form" onSubmit={onSubmit} className="space-y-4">
          {error && (
            <Alert tone={limitHit ? 'amber' : 'rose'} title={limitHit ? 'Seat limit reached' : undefined}>
              {error}
              {limitHit && <div className="mt-1">Upgrade your plan to add more users.</div>}
            </Alert>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" required>
              <Input value={form.name} onChange={set('name')} required autoFocus />
            </Field>
            <Field label="Email" required hint="This is their sign-in">
              <Input type="email" value={form.email} onChange={set('email')} required />
            </Field>
            <Field label="Phone">
              <Input value={form.phone} onChange={set('phone')} inputMode="tel" />
            </Field>
            <Field label="Role" required>
              <Select value={form.role} onChange={set('role')}>
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r] ?? r}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Temporary password" required hint="At least 8 characters" className="sm:col-span-2">
              <Input type="text" value={form.password} onChange={set('password')} minLength={8} required />
            </Field>
          </div>
        </form>
      </Modal>
    </>
  );
}
