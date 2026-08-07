import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDateTime, VERTICAL_LABELS } from '../../lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Input,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from '../../components/ui';

type Status = 'NEW' | 'CONTACTED' | 'QUOTED' | 'WON' | 'LOST';

interface Enquiry {
  id: string;
  source: string;
  contactName: string;
  phone: string;
  email: string | null;
  vertical: string;
  description: string | null;
  status: Status;
  lostReason: string | null;
  receivedAt: string;
  customer?: { id: string; name: string } | null;
  assignee?: { id: string; name: string } | null;
}

const SOURCES = ['WALK_IN', 'PHONE', 'WHATSAPP', 'EMAIL', 'WEB_FORM'];
const STATUS_TONE: Record<Status, 'slate' | 'blue' | 'violet' | 'green' | 'rose'> = {
  NEW: 'slate',
  CONTACTED: 'blue',
  QUOTED: 'violet',
  WON: 'green',
  LOST: 'rose',
};

const empty = {
  source: 'WALK_IN',
  contactName: '',
  phone: '',
  email: '',
  vertical: 'FLEX_LARGE_FORMAT',
  description: '',
  customerId: '',
};

export default function EnquiriesPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [lostFor, setLostFor] = useState<Enquiry | null>(null);
  const [lostReason, setLostReason] = useState('');

  const list = useQuery({
    queryKey: ['enquiries', status, search],
    queryFn: () => api.get<{ data: Enquiry[]; total: number }>(`/enquiries${qs({ status, q: search, pageSize: 100 })}`),
  });
  const customers = useQuery({
    queryKey: ['customers', 'picker'],
    queryFn: () => api.get<{ data: Array<{ id: string; name: string }> }>('/customers?pageSize=200&active=true'),
  });

  const create = useMutation({
    mutationFn: () =>
      api.post<Enquiry & { warnings?: Array<{ message: string }> }>('/enquiries', {
        ...form,
        email: form.email || null,
        customerId: form.customerId || null,
        description: form.description || null,
      }),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['enquiries'] });
      const w = (created.warnings ?? []).map((x) => x.message);
      setWarnings(w);
      if (!w.length) setOpen(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save the enquiry'),
  });

  const setEnquiryStatus = useMutation({
    mutationFn: ({ id, status, lostReason }: { id: string; status: Status; lostReason?: string }) =>
      api.put(`/enquiries/${id}`, { status, lostReason }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['enquiries'] });
      setLostFor(null);
      setLostReason('');
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not update the enquiry'),
  });

  /** FR-220 — the conversion returns the new draft alongside the updated enquiry. */
  const convert = useMutation({
    mutationFn: (id: string) => api.post<{ quote: { id: string } }>(`/enquiries/${id}/convert-to-quote`, {}),
    onSuccess: (res) => navigate(`/quotes/${res.quote.id}/edit`),
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not create a quotation'),
  });

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setWarnings([]);
    create.mutate();
  }

  return (
    <>
      <PageHeader
        title="Enquiries"
        subtitle="Walk-in, phone, WhatsApp, email and web-form enquiries in one inbox"
        actions={
          can('crm', 'C') && (
            <Button
              onClick={() => {
                setForm(empty);
                setError(null);
                setWarnings([]);
                setOpen(true);
              }}
            >
              Log enquiry
            </Button>
          )
        }
      />

      {error && (
        <div className="mb-4">
          <Alert tone="rose">{error}</Alert>
        </div>
      )}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3">
          <Input placeholder="Search name or phone…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
            <option value="">All statuses</option>
            {Object.keys(STATUS_TONE).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
          <span className="ml-auto text-[13px] text-slate-500">{list.data?.total ?? 0} enquiries</span>
        </div>

        {list.isLoading ? (
          <Spinner />
        ) : (list.data?.data ?? []).length === 0 ? (
          <EmptyState title="No enquiries yet" hint="Every walk-in and WhatsApp ask belongs here, so no quote is ever lost." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Contact</Th>
                <Th>Source</Th>
                <Th>Vertical</Th>
                <Th>Requirement</Th>
                <Th>Status</Th>
                <Th>Received</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {(list.data?.data ?? []).map((e) => (
                <tr key={e.id} className="hover:bg-slate-50">
                  <Td>
                    <span className="font-medium text-slate-800">{e.contactName}</span>
                    <div className="text-[12px] text-slate-500">{e.phone}</div>
                    {e.customer && <div className="text-[11px] text-ink-600">{e.customer.name}</div>}
                  </Td>
                  <Td>
                    <Badge tone="slate">{e.source.replace('_', ' ')}</Badge>
                  </Td>
                  <Td>{VERTICAL_LABELS[e.vertical] ?? e.vertical}</Td>
                  <Td className="max-w-xs truncate">{e.description ?? '—'}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[e.status]}>{e.status}</Badge>
                    {e.lostReason && <div className="mt-0.5 text-[11px] text-slate-400">{e.lostReason}</div>}
                  </Td>
                  <Td className="text-[12px]">{formatDateTime(e.receivedAt)}</Td>
                  <Td align="right">
                    <div className="flex justify-end gap-1">
                      {can('crm', 'U') && e.status === 'NEW' && (
                        <Button variant="ghost" size="sm" onClick={() => setEnquiryStatus.mutate({ id: e.id, status: 'CONTACTED' })}>
                          Contacted
                        </Button>
                      )}
                      {can('quotation', 'C') && !['WON', 'LOST'].includes(e.status) && (
                        <Button variant="secondary" size="sm" onClick={() => convert.mutate(e.id)}>
                          Quote
                        </Button>
                      )}
                      {can('crm', 'U') && !['WON', 'LOST'].includes(e.status) && (
                        <Button variant="ghost" size="sm" onClick={() => setLostFor(e)}>
                          Lost
                        </Button>
                      )}
                    </div>
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
        wide
        title="Log an enquiry"
        subtitle="Phone is mandatory; a matching number suggests the existing customer"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Close
            </Button>
            <Button form="enq-form" type="submit" disabled={create.isPending}>
              {create.isPending ? 'Saving…' : 'Save enquiry'}
            </Button>
          </>
        }
      >
        <form id="enq-form" onSubmit={onSubmit} className="space-y-4">
          {warnings.length > 0 && (
            <Alert tone="amber" title="Saved with warnings">
              <ul className="list-inside list-disc">
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Alert>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Source" required>
              <Select value={form.source} onChange={set('source')}>
                {SOURCES.map((s) => (
                  <option key={s} value={s}>
                    {s.replace('_', ' ')}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Vertical" required>
              <Select value={form.vertical} onChange={set('vertical')}>
                {Object.entries(VERTICAL_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Contact name" required>
              <Input value={form.contactName} onChange={set('contactName')} required autoFocus />
            </Field>
            <Field label="Phone" required>
              <Input value={form.phone} onChange={set('phone')} required inputMode="tel" />
            </Field>

            <Field label="Email">
              <Input type="email" value={form.email} onChange={set('email')} />
            </Field>
            <Field label="Link to customer" hint="Optional — an enquiry can exist before a customer record">
              <Select value={form.customerId} onChange={set('customerId')}>
                <option value="">Not linked</option>
                {(customers.data?.data ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Requirement" className="sm:col-span-2">
              <Textarea value={form.description} onChange={set('description')} placeholder="2 flex banners 6×4 ft for shop opening, needed Friday" />
            </Field>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(lostFor)}
        onClose={() => setLostFor(null)}
        title="Mark enquiry lost"
        subtitle="A reason is required"
        footer={
          <>
            <Button variant="secondary" onClick={() => setLostFor(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!lostReason.trim()}
              onClick={() => lostFor && setEnquiryStatus.mutate({ id: lostFor.id, status: 'LOST', lostReason })}
            >
              Mark lost
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Textarea value={lostReason} onChange={(e) => setLostReason(e.target.value)} />
        </Field>
      </Modal>
    </>
  );
}
