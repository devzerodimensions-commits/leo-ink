import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { money } from '../../lib/format';
import { STATE_OPTIONS } from '../../lib/states';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
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
} from '../../components/ui';

interface Customer {
  id: string;
  name: string;
  customerType: 'REGISTERED' | 'UNREGISTERED' | 'COMPOSITION' | 'SEZ' | 'EXPORT';
  gstin: string | null;
  placeOfSupplyState: string;
  billingCity: string | null;
  phone: string;
  email: string | null;
  creditDays: number;
  creditLimit: string;
  openingBalance: string;
  active: boolean;
}

interface ListResponse {
  data: Customer[];
  total: number;
  page: number;
  pageSize: number;
}

const TYPES: Array<Customer['customerType']> = ['REGISTERED', 'UNREGISTERED', 'COMPOSITION', 'SEZ', 'EXPORT'];

const emptyForm = {
  name: '',
  customerType: 'REGISTERED' as Customer['customerType'],
  gstin: '',
  pan: '',
  placeOfSupplyState: '27',
  billingAddress: '',
  billingCity: '',
  billingPincode: '',
  phone: '',
  email: '',
  creditDays: 0,
  creditLimit: '0',
  openingBalance: '0',
};

export default function CustomersPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [showInactive, setShowInactive] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [warnings, setWarnings] = useState<string[]>([]);
  const [confirmDuplicateName, setConfirmDuplicateName] = useState(false);

  const list = useQuery({
    queryKey: ['customers', search, showInactive],
    queryFn: () => api.get<ListResponse>(`/customers${qs({ q: search, active: showInactive ? 'all' : 'true', pageSize: 100 })}`),
  });

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        ...form,
        gstin: form.gstin.trim().toUpperCase() || null,
        pan: form.pan.trim().toUpperCase() || null,
        email: form.email.trim() || null,
        creditDays: Number(form.creditDays) || 0,
        creditLimit: String(form.creditLimit || '0'),
        openingBalance: String(form.openingBalance || '0'),
        confirmDuplicateName,
      };
      type Saved = Customer & { warnings?: Array<{ message: string }> };
      return editing ? api.put<Saved>(`/customers/${editing.id}`, payload) : api.post<Saved>('/customers', payload);
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
      const messages = (saved.warnings ?? []).map((w) => w.message);
      setWarnings(messages);
      // FR-113/FR-201 warnings are non-blocking — keep the form open so the user sees them.
      if (messages.length === 0) closeModal();
      else setEditing(saved);
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
        if (err.payload.code === 'DUPLICATE_NAME') setConfirmDuplicateName(true);
      } else setError('Could not save the customer');
    },
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => api.post(`/customers/${id}/deactivate`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['customers'] }),
  });

  function openCreate() {
    setEditing(null);
    setForm(emptyForm);
    setError(null);
    setFieldErrors({});
    setWarnings([]);
    setConfirmDuplicateName(false);
    setOpen(true);
  }

  function openEdit(c: Customer) {
    setEditing(c);
    setForm({
      ...emptyForm,
      name: c.name,
      customerType: c.customerType,
      gstin: c.gstin ?? '',
      placeOfSupplyState: c.placeOfSupplyState,
      billingCity: c.billingCity ?? '',
      phone: c.phone,
      email: c.email ?? '',
      creditDays: c.creditDays,
      creditLimit: c.creditLimit,
      openingBalance: c.openingBalance,
    });
    setError(null);
    setFieldErrors({});
    setWarnings([]);
    setConfirmDuplicateName(false);
    setOpen(true);
  }

  function closeModal() {
    setOpen(false);
    setEditing(null);
    setWarnings([]);
  }

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const gstinRequired = useMemo(
    () => ['REGISTERED', 'COMPOSITION', 'SEZ'].includes(form.customerType),
    [form.customerType],
  );

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    save.mutate();
  }

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle="Place of supply drives CGST/SGST vs IGST on every quote and invoice"
        actions={can('crm', 'C') && <Button onClick={openCreate}>Add customer</Button>}
      />

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3">
          <Input
            placeholder="Search name, GSTIN or phone…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
          />
          <label className="flex items-center gap-2 text-[13px] text-slate-600">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
          <span className="ml-auto text-[13px] text-slate-500">{list.data?.total ?? 0} customers</span>
        </div>

        {list.isLoading ? (
          <Spinner />
        ) : (list.data?.data ?? []).length === 0 ? (
          <EmptyState
            title="No customers yet"
            hint="Add the shops and companies you bill. GSTIN and place of supply decide the tax split automatically."
            action={can('crm', 'C') ? <Button size="sm" onClick={openCreate}>Add customer</Button> : undefined}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Type</Th>
                <Th>GSTIN</Th>
                <Th>Place of supply</Th>
                <Th>Phone</Th>
                <Th align="right">Credit limit</Th>
                <Th align="right">Opening</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {(list.data?.data ?? []).map((c) => (
                <tr key={c.id} className={c.active ? 'hover:bg-slate-50' : 'bg-slate-50/60 text-slate-400'}>
                  <Td>
                    <span className="font-medium text-slate-800">{c.name}</span>
                    {!c.active && (
                      <Badge tone="slate" className="ml-2">
                        Inactive
                      </Badge>
                    )}
                    {c.billingCity && <div className="text-[12px] text-slate-500">{c.billingCity}</div>}
                  </Td>
                  <Td>
                    <Badge tone={c.customerType === 'REGISTERED' ? 'blue' : 'slate'}>{c.customerType}</Badge>
                  </Td>
                  <Td className="font-mono text-[12px]">{c.gstin ?? '—'}</Td>
                  <Td>
                    {STATE_OPTIONS.find((s) => s.code === c.placeOfSupplyState)?.name ?? c.placeOfSupplyState}
                    <span className="ml-1 text-[11px] text-slate-400">({c.placeOfSupplyState})</span>
                  </Td>
                  <Td>{c.phone}</Td>
                  <Td align="right">{money(c.creditLimit)}</Td>
                  <Td align="right">{money(c.openingBalance)}</Td>
                  <Td align="right">
                    {can('crm', 'U') && (
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(c)}>
                          Edit
                        </Button>
                        {c.active && (
                          <Button variant="ghost" size="sm" onClick={() => deactivate.mutate(c.id)}>
                            Deactivate
                          </Button>
                        )}
                      </div>
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
        onClose={closeModal}
        wide
        title={editing ? `Edit ${editing.name}` : 'Add customer'}
        subtitle="GSTIN is checksum-validated; place of supply is mandatory for the tax split"
        footer={
          <>
            <Button variant="secondary" onClick={closeModal}>
              Cancel
            </Button>
            <Button form="customer-form" type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save customer'}
            </Button>
          </>
        }
      >
        <form id="customer-form" onSubmit={onSubmit} className="space-y-4">
          {error && <Alert tone="rose">{error}</Alert>}
          {warnings.length > 0 && (
            <Alert tone="amber" title="Saved with warnings">
              <ul className="list-inside list-disc">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Alert>
          )}
          {confirmDuplicateName && (
            <Alert tone="amber" title="A customer with this name already exists">
              Submit again to save it anyway.
            </Alert>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Customer name" required error={fieldErrors.name}>
              <Input value={form.name} onChange={set('name')} required autoFocus />
            </Field>
            <Field label="Registration type" required>
              <Select value={form.customerType} onChange={set('customerType')}>
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="GSTIN"
              required={gstinRequired}
              hint={gstinRequired ? '15 characters, checksum validated' : 'Optional for unregistered customers'}
              error={fieldErrors.gstin}
            >
              <Input
                value={form.gstin}
                onChange={(e) => setForm((f) => ({ ...f, gstin: e.target.value.toUpperCase() }))}
                maxLength={15}
                className="font-mono"
                placeholder="27AABCS1429B1Z0"
              />
            </Field>
            <Field label="Place of supply (state)" required error={fieldErrors.placeOfSupplyState}>
              <Select value={form.placeOfSupplyState} onChange={set('placeOfSupplyState')}>
                {STATE_OPTIONS.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.code} — {s.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Phone" required error={fieldErrors.phone}>
              <Input value={form.phone} onChange={set('phone')} required inputMode="tel" />
            </Field>
            <Field label="Email" error={fieldErrors.email}>
              <Input type="email" value={form.email} onChange={set('email')} />
            </Field>

            <Field label="Billing address" className="sm:col-span-2">
              <Input value={form.billingAddress} onChange={set('billingAddress')} />
            </Field>

            <Field label="City">
              <Input value={form.billingCity} onChange={set('billingCity')} />
            </Field>
            <Field label="PIN code">
              <Input value={form.billingPincode} onChange={set('billingPincode')} maxLength={6} />
            </Field>

            <Field label="Credit days">
              <NumberInput value={form.creditDays} onChange={set('creditDays')} min={0} />
            </Field>
            <Field label="Credit limit (₹)">
              <NumberInput value={form.creditLimit} onChange={set('creditLimit')} min={0} step="0.01" />
            </Field>

            <Field label="Opening balance (₹)" hint="Receivable carried over at go-live">
              <NumberInput value={form.openingBalance} onChange={set('openingBalance')} step="0.01" />
            </Field>
          </div>
        </form>
      </Modal>
    </>
  );
}
