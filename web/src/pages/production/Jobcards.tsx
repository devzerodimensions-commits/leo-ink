import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate, toDateInput, VERTICAL_LABELS } from '../../lib/format';
import type { JobCard, Paged } from '../../lib/types';
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
  Textarea,
  Th,
} from '../../components/ui';

const STATUS_TONE = { OPEN: 'slate', IN_PROGRESS: 'blue', DONE: 'green', CANCELLED: 'rose' } as const;

const quickEmpty = {
  customerId: '',
  newCustomerName: '',
  newCustomerPhone: '',
  description: '',
  quantity: '1',
  deliveryDate: toDateInput(new Date(Date.now() + 2 * 86400000)),
  priority: 'NORMAL',
  rushFlag: false,
};

export default function JobcardsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [quickOpen, setQuickOpen] = useState(false);
  const [quick, setQuick] = useState(quickEmpty);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['jobcards', status, search],
    queryFn: () => api.get<Paged<JobCard>>(`/jobcards${qs({ status, q: search, pageSize: 100 })}`),
  });
  const customers = useQuery({
    queryKey: ['customers', 'picker'],
    queryFn: () => api.get<{ data: Array<{ id: string; name: string }> }>('/customers?pageSize=200&active=true'),
  });

  const createQuick = useMutation({
    mutationFn: () =>
      api.post<{ data: JobCard } | JobCard>('/jobcards/quick', {
        customerId: quick.customerId || undefined,
        customer: quick.customerId ? undefined : { name: quick.newCustomerName, phone: quick.newCustomerPhone },
        description: quick.description,
        quantity: quick.quantity,
        deliveryDate: quick.deliveryDate,
        priority: quick.priority,
        rushFlag: quick.rushFlag,
      }),
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['jobcards'] });
      void qc.invalidateQueries({ queryKey: ['board'] });
      setQuickOpen(false);
      const created = 'data' in res ? res.data : res;
      navigate(`/jobcards/${created.id}`);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not book the jobcard'),
  });

  function onQuickSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    createQuick.mutate();
  }

  return (
    <>
      <PageHeader
        title="Jobcards"
        subtitle="Every job that hits the floor — from a 15-second walk-in to a converted quotation"
        actions={
          can('jobcard', 'C') && (
            <Button
              onClick={() => {
                setQuick(quickEmpty);
                setError(null);
                setQuickOpen(true);
              }}
            >
              Quick jobcard
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
          <Input placeholder="Search jobcard no. or customer…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-44">
            <option value="">All statuses</option>
            <option value="OPEN">Open</option>
            <option value="IN_PROGRESS">In progress</option>
            <option value="DONE">Done</option>
          </Select>
          <span className="ml-auto text-[13px] text-slate-500">{list.data?.total ?? 0} jobcards</span>
        </div>

        {list.isLoading ? (
          <Spinner />
        ) : (list.data?.data ?? []).length === 0 ? (
          <EmptyState
            title="No jobcards yet"
            hint="Convert a won quotation, or book a walk-in in seconds and fill in the spec later."
            action={can('jobcard', 'C') ? <Button size="sm" onClick={() => setQuickOpen(true)}>Quick jobcard</Button> : undefined}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Jobcard</Th>
                <Th>Customer</Th>
                <Th>Vertical</Th>
                <Th>Stage</Th>
                <Th>Operator</Th>
                <Th>Status</Th>
                <Th>Delivery</Th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.data ?? []).map((j) => (
                <tr key={j.id} className="hover:bg-slate-50">
                  <Td>
                    <Link to={`/jobcards/${j.id}`} className="font-medium text-ink-700 hover:underline">
                      {j.jobcardNo}
                    </Link>
                    {j.title && <div className="max-w-xs truncate text-[12px] text-slate-500">{j.title}</div>}
                    <div className="mt-0.5 flex gap-1">
                      {j.rushFlag && <Badge tone="rose">RUSH</Badge>}
                      {j.specIncomplete && <Badge tone="amber">Spec pending</Badge>}
                      {j.isQuick && <Badge tone="slate">Quick</Badge>}
                    </div>
                  </Td>
                  <Td>{j.customerName}</Td>
                  <Td>{VERTICAL_LABELS[j.vertical] ?? j.vertical}</Td>
                  <Td>
                    {j.stageName ?? '—'}
                    {j.department && <div className="text-[12px] text-slate-500">{j.department}</div>}
                  </Td>
                  <Td>{j.assignedOperatorName ?? <span className="text-slate-400">Unassigned</span>}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[j.overallStatus]}>{j.overallStatus.replace('_', ' ')}</Badge>
                  </Td>
                  <Td>
                    {formatDate(j.deliveryDate)}
                    {j.overdue && (
                      <Badge tone="rose" className="ml-2">
                        Overdue
                      </Badge>
                    )}
                    {j.dueToday && !j.overdue && (
                      <Badge tone="amber" className="ml-2">
                        Today
                      </Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <Modal
        open={quickOpen}
        onClose={() => setQuickOpen(false)}
        title="Quick jobcard"
        subtitle="Customer, what it is, how many, when — the rest can wait"
        footer={
          <>
            <Button variant="secondary" onClick={() => setQuickOpen(false)}>
              Cancel
            </Button>
            <Button form="quick-form" type="submit" disabled={createQuick.isPending}>
              {createQuick.isPending ? 'Booking…' : 'Book job'}
            </Button>
          </>
        }
      >
        <form id="quick-form" onSubmit={onQuickSubmit} className="space-y-4">
          <Field label="Customer" hint="Or leave blank and enter a new walk-in below">
            <Select value={quick.customerId} onChange={(e) => setQuick((q) => ({ ...q, customerId: e.target.value }))}>
              <option value="">— new walk-in —</option>
              {(customers.data?.data ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>

          {!quick.customerId && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Walk-in name" required>
                <Input value={quick.newCustomerName} onChange={(e) => setQuick((q) => ({ ...q, newCustomerName: e.target.value }))} required />
              </Field>
              <Field label="Mobile" required>
                <Input value={quick.newCustomerPhone} onChange={(e) => setQuick((q) => ({ ...q, newCustomerPhone: e.target.value }))} required inputMode="tel" />
              </Field>
            </div>
          )}

          <Field label="What is the job?" required>
            <Textarea value={quick.description} onChange={(e) => setQuick((q) => ({ ...q, description: e.target.value }))} required placeholder="2 flex banners 6×4 ft, star flex, eyelets" />
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Quantity" required>
              <NumberInput value={quick.quantity} onChange={(e) => setQuick((q) => ({ ...q, quantity: e.target.value }))} min={1} required />
            </Field>
            <Field label="Delivery date" required>
              <Input type="date" value={quick.deliveryDate} onChange={(e) => setQuick((q) => ({ ...q, deliveryDate: e.target.value }))} required />
            </Field>
            <Field label="Priority">
              <Select value={quick.priority} onChange={(e) => setQuick((q) => ({ ...q, priority: e.target.value }))}>
                <option value="LOW">Low</option>
                <option value="NORMAL">Normal</option>
                <option value="HIGH">High</option>
              </Select>
            </Field>
          </div>

          <label className="flex items-center gap-2 text-[13px] text-slate-700">
            <input type="checkbox" checked={quick.rushFlag} onChange={(e) => setQuick((q) => ({ ...q, rushFlag: e.target.checked }))} />
            Rush job — show it at the top of every stage column
          </label>
        </form>
      </Modal>
    </>
  );
}
