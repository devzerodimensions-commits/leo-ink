import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate, rate as fmtRate } from '../../lib/format';
import { STATE_OPTIONS, stateName } from '../../lib/states';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  Modal,
  NumberInput,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  cx,
} from '../../components/ui';

type Tab = 'wizard' | 'firm' | 'branches' | 'bank' | 'fy' | 'numbering' | 'tax' | 'hsn' | 'uom';

const TABS: Array<{ key: Tab; label: string }> = [
  { key: 'wizard', label: 'Go-live checklist' },
  { key: 'firm', label: 'Firm profile' },
  { key: 'branches', label: 'Branches' },
  { key: 'bank', label: 'Bank & UPI' },
  { key: 'fy', label: 'Financial year' },
  { key: 'numbering', label: 'Document numbering' },
  { key: 'tax', label: 'GST rates' },
  { key: 'hsn', label: 'HSN / SAC' },
  { key: 'uom', label: 'Units' },
];

export default function SetupPage() {
  const [tab, setTab] = useState<Tab>('wizard');

  return (
    <>
      <PageHeader title="Setup & masters" subtitle="Everything a compliant document needs, configured once" />

      <div className="mb-5 flex flex-wrap gap-1 border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={cx(
              '-mb-px border-b-2 px-3 py-2 text-[13px] font-medium transition-colors',
              tab === t.key
                ? 'border-ink-600 text-ink-700'
                : 'border-transparent text-slate-500 hover:border-slate-300 hover:text-slate-700',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'wizard' && <WizardTab onJump={setTab} />}
      {tab === 'firm' && <FirmTab />}
      {tab === 'branches' && <BranchesTab />}
      {tab === 'bank' && <BankTab />}
      {tab === 'fy' && <FyTab />}
      {tab === 'numbering' && <NumberingTab />}
      {tab === 'tax' && <TaxTab />}
      {tab === 'hsn' && <HsnTab />}
      {tab === 'uom' && <UomTab />}
    </>
  );
}

// ── Go-live checklist (FR-100) ───────────────────────────────────────────────

interface WizardStatus {
  goLiveReady: boolean;
  canGoLive?: boolean;
  currentStep?: string;
  steps: Array<{ key: string; label: string; complete: boolean; required?: boolean; blockers?: string[] }>;
  blockers?: string[];
}

const STEP_TAB: Record<string, Tab> = {
  firm: 'firm',
  branch: 'branches',
  branches: 'branches',
  bank: 'bank',
  fy: 'fy',
  financialYear: 'fy',
  numbering: 'numbering',
};

function WizardTab({ onJump }: { onJump: (t: Tab) => void }) {
  const { refresh } = useAuth();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const status = useQuery({ queryKey: ['wizard'], queryFn: () => api.get<WizardStatus>('/setup/wizard') });

  const finish = useMutation({
    mutationFn: () => api.put('/setup/wizard', { complete: true }),
    onSuccess: async () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ['wizard'] });
      await refresh();
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not finish setup'),
  });

  if (status.isLoading) return <Spinner />;
  const data = status.data;

  return (
    <Card>
      <CardHeader
        title="Go-live checklist"
        subtitle="A GST-compliant invoice needs a GSTIN, a branch and an open financial year"
        actions={
          data?.goLiveReady ? (
            <Badge tone="green">Ready to bill</Badge>
          ) : (
            <Button onClick={() => finish.mutate()} disabled={finish.isPending}>
              Mark setup complete
            </Button>
          )
        }
      />
      <div className="p-5">
        {error && (
          <div className="mb-4">
            <Alert tone="rose" title="Not ready yet">
              {error}
            </Alert>
          </div>
        )}
        <ol className="space-y-3">
          {(data?.steps ?? []).map((s) => (
            <li key={s.key} className="flex items-start gap-3">
              <span
                className={cx(
                  'mt-0.5 grid size-5 shrink-0 place-items-center rounded-full text-[11px] font-semibold',
                  s.complete ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-500',
                )}
              >
                {s.complete ? '✓' : '·'}
              </span>
              <div className="flex-1">
                <p className={cx('text-[14px]', s.complete ? 'text-slate-500 line-through' : 'font-medium text-slate-800')}>
                  {s.label}
                  {s.required === false && <span className="ml-2 text-[11px] font-normal text-slate-400">optional</span>}
                </p>
                {(s.blockers ?? []).map((b) => (
                  <p key={b} className="text-[12px] text-rose-600">
                    {b}
                  </p>
                ))}
              </div>
              {!s.complete && STEP_TAB[s.key] && (
                <Button variant="secondary" size="sm" onClick={() => onJump(STEP_TAB[s.key])}>
                  Fix
                </Button>
              )}
            </li>
          ))}
        </ol>
      </div>
    </Card>
  );
}

// ── Firm profile (FR-101) ────────────────────────────────────────────────────

function FirmTab() {
  const { refresh } = useAuth();
  const qc = useQueryClient();
  const [form, setForm] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  const firm = useQuery({
    queryKey: ['firm'],
    queryFn: async () => {
      const res = await api.get<Record<string, string | null>>('/setup/firm');
      setForm((f) => (Object.keys(f).length ? f : Object.fromEntries(Object.entries(res).map(([k, v]) => [k, v ?? '']))));
      return res;
    },
  });

  const save = useMutation({
    mutationFn: () =>
      api.put('/setup/firm', {
        legalName: form.legalName,
        tradeName: form.tradeName || null,
        constitution: form.constitution || null,
        gstin: form.gstin?.toUpperCase() || null,
        pan: form.pan?.toUpperCase() || null,
        addressLine1: form.addressLine1 || null,
        addressLine2: form.addressLine2 || null,
        city: form.city || null,
        pincode: form.pincode || null,
        email: form.email || null,
        phone: form.phone || null,
        website: form.website || null,
      }),
    onSuccess: async () => {
      setError(null);
      setSaved(true);
      void qc.invalidateQueries({ queryKey: ['firm'] });
      void qc.invalidateQueries({ queryKey: ['wizard'] });
      await refresh();
    },
    onError: (err) => {
      setSaved(false);
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else setError('Could not save the firm profile');
    },
  });

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  if (firm.isLoading) return <Spinner />;

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    save.mutate();
  }

  return (
    <Card>
      <CardHeader
        title="Firm profile"
        subtitle="Printed on every document. The GSTIN's first two digits set your home state for the tax split."
      />
      <form onSubmit={onSubmit} className="space-y-4 p-5">
        {error && <Alert tone="rose">{error}</Alert>}
        {saved && <Alert tone="green">Firm profile saved.</Alert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Legal name" required error={fieldErrors.legalName}>
            <Input value={form.legalName ?? ''} onChange={set('legalName')} required />
          </Field>
          <Field label="Trade name">
            <Input value={form.tradeName ?? ''} onChange={set('tradeName')} />
          </Field>

          <Field label="Constitution">
            <Select value={form.constitution ?? ''} onChange={set('constitution')}>
              <option value="">Select…</option>
              {['Proprietorship', 'Partnership', 'LLP', 'Private Limited', 'Public Limited', 'HUF', 'Other'].map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Home state" hint="Derived from the GSTIN, read-only">
            <Input value={stateName(form.homeStateCode)} disabled />
          </Field>

          <Field label="GSTIN" hint="15 characters, checksum validated" error={fieldErrors.gstin}>
            <Input
              value={form.gstin ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))}
              maxLength={15}
              className="font-mono"
              placeholder="27AABCS1429B1Z0"
            />
          </Field>
          <Field label="PAN" error={fieldErrors.pan}>
            <Input
              value={form.pan ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, pan: e.target.value.toUpperCase() }))}
              maxLength={10}
              className="font-mono"
            />
          </Field>

          <Field label="Address line 1" className="sm:col-span-2">
            <Input value={form.addressLine1 ?? ''} onChange={set('addressLine1')} />
          </Field>
          <Field label="Address line 2" className="sm:col-span-2">
            <Input value={form.addressLine2 ?? ''} onChange={set('addressLine2')} />
          </Field>

          <Field label="City">
            <Input value={form.city ?? ''} onChange={set('city')} />
          </Field>
          <Field label="PIN code">
            <Input value={form.pincode ?? ''} onChange={set('pincode')} maxLength={6} />
          </Field>

          <Field label="Email">
            <Input type="email" value={form.email ?? ''} onChange={set('email')} />
          </Field>
          <Field label="Phone">
            <Input value={form.phone ?? ''} onChange={set('phone')} />
          </Field>
        </div>

        <div className="flex justify-end">
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save firm profile'}
          </Button>
        </div>
      </form>
    </Card>
  );
}

// ── Generic simple master tab helper ─────────────────────────────────────────

function useMaster<T>(key: string, path: string) {
  return useQuery({ queryKey: [key], queryFn: () => api.get<{ data: T[] }>(path) });
}

function SimpleCard({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} subtitle={subtitle} actions={actions} />
      {children}
    </Card>
  );
}

// ── Branches (FR-103) ────────────────────────────────────────────────────────

interface Branch {
  id: string;
  branchCode: string;
  name: string;
  gstin: string | null;
  stateCode: string;
  city: string | null;
  isHeadOffice: boolean;
  active: boolean;
}

function BranchesTab() {
  const qc = useQueryClient();
  const list = useMaster<Branch>('branches', '/setup/branches');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ branchCode: '', name: '', gstin: '', stateCode: '27', city: '', isHeadOffice: false });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.post('/setup/branches', { ...form, gstin: form.gstin || null }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['branches'] });
      void qc.invalidateQueries({ queryKey: ['wizard'] });
      setOpen(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save the branch'),
  });

  return (
    <>
      <SimpleCard
        title="Branches"
        subtitle="Each branch has its own GSTIN and state — that state decides CGST/SGST vs IGST on its documents"
        actions={<Button size="sm" onClick={() => { setForm({ branchCode: '', name: '', gstin: '', stateCode: '27', city: '', isHeadOffice: false }); setError(null); setOpen(true); }}>Add branch</Button>}
      >
        {list.isLoading ? (
          <Spinner />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Name</Th>
                <Th>GSTIN</Th>
                <Th>State</Th>
                <Th>City</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {(list.data?.data ?? []).map((b) => (
                <tr key={b.id}>
                  <Td className="font-mono text-[12px]">{b.branchCode}</Td>
                  <Td className="font-medium text-slate-800">{b.name}</Td>
                  <Td className="font-mono text-[12px]">{b.gstin ?? '—'}</Td>
                  <Td>{stateName(b.stateCode)}</Td>
                  <Td>{b.city ?? '—'}</Td>
                  <Td align="right">
                    {b.isHeadOffice && <Badge tone="blue">Head office</Badge>}
                    {!b.active && <Badge tone="slate">Inactive</Badge>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </SimpleCard>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add branch"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              Save branch
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <Alert tone="rose">{error}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Branch code" required>
              <Input value={form.branchCode} onChange={(e) => setForm((f) => ({ ...f, branchCode: e.target.value.toUpperCase() }))} className="font-mono" placeholder="HO" />
            </Field>
            <Field label="Branch name" required>
              <Input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </Field>
            <Field label="GSTIN">
              <Input value={form.gstin} onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))} maxLength={15} className="font-mono" />
            </Field>
            <Field label="State" required>
              <Select value={form.stateCode} onChange={(e) => setForm((f) => ({ ...f, stateCode: e.target.value }))}>
                {STATE_OPTIONS.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="City">
              <Input value={form.city} onChange={(e) => setForm((f) => ({ ...f, city: e.target.value }))} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-[13px] text-slate-700">
            <input type="checkbox" checked={form.isHeadOffice} onChange={(e) => setForm((f) => ({ ...f, isHeadOffice: e.target.checked }))} />
            This is the head office
          </label>
        </div>
      </Modal>
    </>
  );
}

// ── Bank (FR-102) ────────────────────────────────────────────────────────────

interface Bank {
  id: string;
  accountName: string;
  accountNo: string;
  ifsc: string;
  bankName: string;
  branchName: string | null;
  upiVpa: string | null;
  isDefault: boolean;
}

function BankTab() {
  const qc = useQueryClient();
  const list = useMaster<Bank>('bank-accounts', '/setup/bank-accounts');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ accountName: '', accountNo: '', ifsc: '', bankName: '', branchName: '', upiVpa: '', isDefault: true });
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => api.post('/setup/bank-accounts', form),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bank-accounts'] });
      setOpen(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save the account'),
  });

  return (
    <>
      <SimpleCard
        title="Bank accounts & UPI"
        subtitle="The default account and UPI VPA print on invoices and drive the payment QR"
        actions={<Button size="sm" onClick={() => { setError(null); setOpen(true); }}>Add account</Button>}
      >
        {list.isLoading ? (
          <Spinner />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Account name</Th>
                <Th>Account no.</Th>
                <Th>IFSC</Th>
                <Th>Bank</Th>
                <Th>UPI</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {(list.data?.data ?? []).map((b) => (
                <tr key={b.id}>
                  <Td className="font-medium text-slate-800">{b.accountName}</Td>
                  <Td className="font-mono text-[12px]">{b.accountNo}</Td>
                  <Td className="font-mono text-[12px]">{b.ifsc}</Td>
                  <Td>
                    {b.bankName}
                    {b.branchName && <div className="text-[12px] text-slate-500">{b.branchName}</div>}
                  </Td>
                  <Td>{b.upiVpa ?? '—'}</Td>
                  <Td align="right">{b.isDefault && <Badge tone="blue">Default</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </SimpleCard>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Add bank account"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => save.mutate()} disabled={save.isPending}>
              Save account
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <Alert tone="rose">{error}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Account name" required>
              <Input value={form.accountName} onChange={(e) => setForm((f) => ({ ...f, accountName: e.target.value }))} />
            </Field>
            <Field label="Account number" required>
              <Input value={form.accountNo} onChange={(e) => setForm((f) => ({ ...f, accountNo: e.target.value }))} className="font-mono" />
            </Field>
            <Field label="IFSC" required hint="4 letters + 0 + 6 characters">
              <Input value={form.ifsc} onChange={(e) => setForm((f) => ({ ...f, ifsc: e.target.value.toUpperCase() }))} maxLength={11} className="font-mono" />
            </Field>
            <Field label="Bank name" required>
              <Input value={form.bankName} onChange={(e) => setForm((f) => ({ ...f, bankName: e.target.value }))} />
            </Field>
            <Field label="Bank branch">
              <Input value={form.branchName} onChange={(e) => setForm((f) => ({ ...f, branchName: e.target.value }))} />
            </Field>
            <Field label="UPI VPA">
              <Input value={form.upiVpa} onChange={(e) => setForm((f) => ({ ...f, upiVpa: e.target.value }))} placeholder="shop@bank" />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-[13px] text-slate-700">
            <input type="checkbox" checked={form.isDefault} onChange={(e) => setForm((f) => ({ ...f, isDefault: e.target.checked }))} />
            Make this the default account on documents
          </label>
        </div>
      </Modal>
    </>
  );
}

// ── Financial year (FR-104 / FR-105) ─────────────────────────────────────────

interface Fy {
  id: string;
  fyLabel: string;
  startDate: string;
  endDate: string;
  status: 'OPEN' | 'CLOSED';
  isCurrent: boolean;
}

function FyTab() {
  const qc = useQueryClient();
  const list = useMaster<Fy>('financial-years', '/setup/financial-years');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'set-current' | 'rollover' }) =>
      api.post<{ message?: string }>(`/setup/financial-years/${id}/${action}`, {}),
    onSuccess: (res) => {
      setError(null);
      setMessage(res?.message ?? 'Done.');
      void qc.invalidateQueries({ queryKey: ['financial-years'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Action failed'),
  });

  const create = useMutation({
    mutationFn: () => api.post('/setup/financial-years', {}),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['financial-years'] }),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not create the year'),
  });

  return (
    <SimpleCard
      title="Financial years"
      subtitle="India runs 1 April → 31 March. Year-end rollover carries balances forward and resets numbering."
      actions={<Button size="sm" onClick={() => create.mutate()}>Create next year</Button>}
    >
      <div className="p-5 pb-0">
        {error && <Alert tone="rose">{error}</Alert>}
        {message && !error && <Alert tone="green">{message}</Alert>}
      </div>
      {list.isLoading ? (
        <Spinner />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Year</Th>
              <Th>From</Th>
              <Th>To</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {(list.data?.data ?? []).map((fy) => (
              <tr key={fy.id}>
                <Td className="font-medium text-slate-800">{fy.fyLabel}</Td>
                <Td>{formatDate(fy.startDate)}</Td>
                <Td>{formatDate(fy.endDate)}</Td>
                <Td>
                  <Badge tone={fy.status === 'OPEN' ? 'green' : 'slate'}>{fy.status}</Badge>
                  {fy.isCurrent && (
                    <Badge tone="blue" className="ml-2">
                      Current
                    </Badge>
                  )}
                </Td>
                <Td align="right">
                  <div className="flex justify-end gap-1">
                    {!fy.isCurrent && (
                      <Button variant="ghost" size="sm" onClick={() => act.mutate({ id: fy.id, action: 'set-current' })}>
                        Make current
                      </Button>
                    )}
                    <Button variant="ghost" size="sm" onClick={() => act.mutate({ id: fy.id, action: 'rollover' })}>
                      Run rollover
                    </Button>
                  </div>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </SimpleCard>
  );
}

// ── Numbering (FR-106 / FR-107) ──────────────────────────────────────────────

interface Series {
  id: string;
  docType: string;
  prefix: string;
  suffix: string;
  padding: number;
  startNumber: number;
  nextNumber: number;
  resetPolicy: string;
  active: boolean;
  preview?: string;
  branch?: { branchCode: string } | null;
  fy?: { fyLabel: string } | null;
}

function NumberingTab() {
  const list = useMaster<Series>('numbering-series', '/setup/numbering-series');

  return (
    <SimpleCard
      title="Document numbering"
      subtitle="Gap-free, sequential, per document type and branch, resetting each financial year"
    >
      {list.isLoading ? (
        <Spinner />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Document</Th>
              <Th>Format</Th>
              <Th>Preview</Th>
              <Th align="right">Next</Th>
              <Th>Reset</Th>
              <Th>Scope</Th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.data ?? []).map((s) => (
              <tr key={s.id}>
                <Td className="font-medium text-slate-800">{s.docType.replace(/_/g, ' ')}</Td>
                <Td className="font-mono text-[12px]">
                  {s.prefix}
                  {'0'.repeat(s.padding)}
                  {s.suffix}
                </Td>
                <Td className="font-mono text-[12px] text-ink-700">{s.preview ?? '—'}</Td>
                <Td align="right">{s.nextNumber}</Td>
                <Td>
                  <Badge tone={s.resetPolicy === 'YEARLY' ? 'blue' : 'slate'}>{s.resetPolicy}</Badge>
                </Td>
                <Td className="text-[12px] text-slate-500">
                  {s.branch?.branchCode ?? 'all branches'} · {s.fy?.fyLabel ?? 'all years'}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </SimpleCard>
  );
}

// ── Tax rates / HSN / UOM ────────────────────────────────────────────────────

interface TaxRate {
  id: string;
  name: string;
  gstPct: string;
  cessPct: string;
  effectiveFrom: string;
  active: boolean;
}

function TaxTab() {
  const list = useMaster<TaxRate>('tax-rates', '/setup/tax-rates');
  return (
    <SimpleCard title="GST rate slabs" subtitle="Intra-state supply splits each rate into CGST + SGST; inter-state charges the full rate as IGST">
      {list.isLoading ? (
        <Spinner />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th align="right">GST %</Th>
              <Th align="right">CGST</Th>
              <Th align="right">SGST</Th>
              <Th align="right">IGST</Th>
              <Th>Effective from</Th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.data ?? []).map((t) => (
              <tr key={t.id} className={t.active ? undefined : 'text-slate-400'}>
                <Td className="font-medium text-slate-800">{t.name}</Td>
                <Td align="right">{fmtRate(t.gstPct)}%</Td>
                <Td align="right">{fmtRate(Number(t.gstPct) / 2)}%</Td>
                <Td align="right">{fmtRate(Number(t.gstPct) / 2)}%</Td>
                <Td align="right">{fmtRate(t.gstPct)}%</Td>
                <Td>{formatDate(t.effectiveFrom)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </SimpleCard>
  );
}

interface Hsn {
  id: string;
  code: string;
  type: string;
  description: string | null;
  active: boolean;
  defaultTaxRate?: { name: string; gstPct: string } | null;
}

function HsnTab() {
  const list = useMaster<Hsn>('hsn-codes', '/setup/hsn-codes');
  return (
    <SimpleCard
      title="HSN / SAC codes"
      subtitle="Printing services sit at SAC 998912 (18%); printed matter at HSN 4911 (12%) — a mixed invoice is normal"
    >
      {list.isLoading ? (
        <Spinner />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Type</Th>
              <Th>Description</Th>
              <Th align="right">Default GST</Th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.data ?? []).map((h) => (
              <tr key={h.id} className={h.active ? undefined : 'text-slate-400'}>
                <Td className="font-mono text-[13px] font-medium text-slate-800">{h.code}</Td>
                <Td>
                  <Badge tone={h.type === 'SAC' ? 'violet' : 'blue'}>{h.type}</Badge>
                </Td>
                <Td>{h.description ?? '—'}</Td>
                <Td align="right">{h.defaultTaxRate ? `${fmtRate(h.defaultTaxRate.gstPct)}%` : '—'}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </SimpleCard>
  );
}

interface Uom {
  id: string;
  uomCode: string;
  name: string;
  symbol: string | null;
  factorToBase: string;
  active: boolean;
  baseUom?: { uomCode: string } | null;
}

function UomTab() {
  const list = useMaster<Uom>('uoms', '/setup/uoms');
  return (
    <SimpleCard title="Units of measure" subtitle="sq.ft drives flex area pricing; a single conversion factor links derived units to their base">
      {list.isLoading ? (
        <Spinner />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Code</Th>
              <Th>Name</Th>
              <Th>Symbol</Th>
              <Th>Conversion</Th>
            </tr>
          </thead>
          <tbody>
            {(list.data?.data ?? []).map((u) => (
              <tr key={u.id} className={u.active ? undefined : 'text-slate-400'}>
                <Td className="font-mono text-[13px] font-medium text-slate-800">{u.uomCode}</Td>
                <Td>{u.name}</Td>
                <Td>{u.symbol ?? '—'}</Td>
                <Td>{u.baseUom ? `1 ${u.uomCode} = ${fmtRate(u.factorToBase)} ${u.baseUom.uomCode}` : 'base unit'}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </SimpleCard>
  );
}
