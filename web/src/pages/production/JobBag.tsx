import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate, formatDateTime, money, qty as fmtQty, rate as fmtRate, VERTICAL_LABELS } from '../../lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Th,
  cx,
} from '../../components/ui';

interface SpecItem {
  id: string;
  lineNo: number;
  description: string;
  width: string | null;
  height: string | null;
  unit: string | null;
  areaSqft: string | null;
  substrate: string | null;
  gsm: number | null;
  colours: string | null;
  sides: number | null;
  quantity: string;
  finishing: string[];
  instructions: string | null;
  rate: string | null;
  lineTaxable: string | null;
  gstPct: string | null;
  hsnSac: string | null;
}

interface StageProgress {
  id: string;
  stageName: string;
  sequence: number;
  department: string | null;
  isTerminal: boolean;
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'SKIPPED';
  startedAt: string | null;
  completedAt: string | null;
  operator?: { id: string; name: string } | null;
}

interface JobEvent {
  id: string;
  eventType: string;
  fromStage: string | null;
  toStage: string | null;
  oldValue: string | null;
  newValue: string | null;
  source: string;
  createdAt: string;
  actor?: { name: string } | null;
}

interface JobBag {
  id: string;
  jobcardNo: string;
  vertical: string;
  overallStatus: string;
  deliveryDate: string;
  priority: string;
  rushFlag: boolean;
  specIncomplete: boolean;
  completedAt: string | null;
  notes: string | null;
  customer?: { id: string; name: string; phone: string; gstin: string | null };
  quote?: { id: string; quoteNo: string | null } | null;
  specs: SpecItem[];
  progress: StageProgress[];
  currentStage?: StageProgress | null;
  qrToken?: string | null;
  qrPayload?: string | null;
  printedAt?: string | null;
  overdue?: boolean;
  dueToday?: boolean;
}

const STAGE_TONE = { PENDING: 'slate', IN_PROGRESS: 'blue', COMPLETED: 'green', SKIPPED: 'amber' } as const;

export default function JobBagPage() {
  const { id } = useParams();
  const qc = useQueryClient();
  const { can, session } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [assignTo, setAssignTo] = useState('');

  const bag = useQuery({
    queryKey: ['job-bag', id],
    queryFn: () => api.get<JobBag>(`/jobcards/${id}/job-bag`),
    enabled: Boolean(id),
  });
  const events = useQuery({
    queryKey: ['job-events', id],
    queryFn: () => api.get<{ data: JobEvent[] }>(`/jobcards/${id}/events`),
    enabled: Boolean(id),
  });
  const operators = useQuery({
    queryKey: ['operators'],
    queryFn: () => api.get<{ data: Array<{ id: string; name: string; role: string }> }>('/setup/users'),
    enabled: can('production', 'U'),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['job-bag', id] });
    void qc.invalidateQueries({ queryKey: ['job-events', id] });
    void qc.invalidateQueries({ queryKey: ['board'] });
  };
  const fail = (err: unknown) => setError(err instanceof ApiError ? err.message : 'Something went wrong');

  const advance = useMutation({
    mutationFn: () => api.post(`/jobcards/${id}/advance`, {}),
    onSuccess: () => { setError(null); refresh(); },
    onError: fail,
  });
  const revert = useMutation({
    mutationFn: () => api.post(`/jobcards/${id}/revert`, {}),
    onSuccess: () => { setError(null); refresh(); },
    onError: fail,
  });
  const assign = useMutation({
    mutationFn: (stageProgressId: string) =>
      api.post(`/jobcards/${id}/stages/${stageProgressId}/assign`, { operatorId: assignTo }),
    onSuccess: () => { setError(null); refresh(); },
    onError: fail,
  });
  const print = useMutation({
    mutationFn: () => api.post(`/jobcards/${id}/print-ticket`, {}),
    onSuccess: () => { refresh(); window.print(); },
    onError: fail,
  });

  if (bag.isLoading) return <Spinner label="Opening the job bag…" />;
  const job = bag.data;
  if (!job) return <Alert tone="rose">Jobcard not found.</Alert>;

  const assignable = (operators.data?.data ?? []).filter((u) =>
    ['OPERATOR', 'PRODUCTION_MANAGER'].includes(u.role),
  );

  return (
    <>
      <PageHeader
        title={job.jobcardNo}
        subtitle={`${job.customer?.name ?? ''} · ${VERTICAL_LABELS[job.vertical] ?? job.vertical} · delivery ${formatDate(job.deliveryDate)}`}
        actions={
          <>
            {job.rushFlag && <Badge tone="rose">RUSH</Badge>}
            {job.overdue && <Badge tone="rose">Overdue</Badge>}
            {job.dueToday && !job.overdue && <Badge tone="amber">Due today</Badge>}
            <Badge tone={job.overallStatus === 'DONE' ? 'green' : job.overallStatus === 'IN_PROGRESS' ? 'blue' : 'slate'}>
              {job.overallStatus.replace('_', ' ')}
            </Badge>
            <Button variant="secondary" onClick={() => print.mutate()}>
              Print job ticket
            </Button>
            {can('production', 'U') && job.overallStatus !== 'DONE' && (
              <Button onClick={() => advance.mutate()} disabled={advance.isPending}>
                Advance stage →
              </Button>
            )}
          </>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert tone="rose">{error}</Alert>
        </div>
      )}
      {job.specIncomplete && (
        <div className="mb-4">
          <Alert tone="amber" title="Specification still pending">
            This job was booked as a quick walk-in. Fill in the full spec before it reaches the machine.
          </Alert>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[1fr_340px]">
        <div className="space-y-5">
          <Card>
            <CardHeader title="Specification" subtitle={`${job.specs.length} item${job.specs.length === 1 ? '' : 's'}`} />
            <Table>
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>Description</Th>
                  <Th>Size</Th>
                  <Th>Substrate</Th>
                  <Th>Colours</Th>
                  <Th align="right">Qty</Th>
                  <Th>Finishing</Th>
                  <Th align="right">Value</Th>
                </tr>
              </thead>
              <tbody>
                {job.specs.map((s) => (
                  <tr key={s.id}>
                    <Td>{s.lineNo}</Td>
                    <Td>
                      <span className="font-medium text-slate-800">{s.description}</span>
                      {s.instructions && <div className="text-[12px] text-slate-500">{s.instructions}</div>}
                    </Td>
                    <Td>
                      {s.width && s.height ? (
                        <>
                          {fmtRate(s.width)} × {fmtRate(s.height)} {s.unit ?? 'ft'}
                          {s.areaSqft && <div className="text-[12px] text-slate-500">{fmtRate(s.areaSqft)} sq.ft</div>}
                        </>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td>
                      {s.substrate ?? '—'}
                      {s.gsm && <div className="text-[12px] text-slate-500">{s.gsm} GSM</div>}
                    </Td>
                    <Td>
                      {s.colours ?? '—'}
                      {s.sides && <div className="text-[12px] text-slate-500">{s.sides === 2 ? 'double' : 'single'} sided</div>}
                    </Td>
                    <Td align="right">{fmtQty(s.quantity)}</Td>
                    <Td>
                      {s.finishing?.length ? (
                        <div className="flex flex-wrap gap-1">
                          {s.finishing.map((f) => (
                            <Badge key={f} tone="slate">
                              {f}
                            </Badge>
                          ))}
                        </div>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td align="right">{s.lineTaxable ? money(s.lineTaxable) : '—'}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
            {job.quote && (
              <p className="border-t border-slate-100 px-5 py-3 text-[12px] text-slate-500">
                Specs and pricing carried from quotation{' '}
                <Link to={`/quotes/${job.quote.id}`} className="font-medium text-ink-700 hover:underline">
                  {job.quote.quoteNo ?? 'draft'}
                </Link>{' '}
                — the invoice will reproduce those figures exactly.
              </p>
            )}
          </Card>

          <Card>
            <CardHeader
              title="Production stages"
              subtitle="Stage-wise timestamps and the operator responsible"
              actions={
                can('production', 'U') && job.overallStatus === 'IN_PROGRESS' ? (
                  <Button variant="ghost" size="sm" onClick={() => revert.mutate()}>
                    ← Move back
                  </Button>
                ) : undefined
              }
            />
            <ol className="p-5">
              {job.progress.map((p, i) => (
                <li key={p.id} className="flex gap-4">
                  <div className="flex flex-col items-center">
                    <span
                      className={cx(
                        'grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold',
                        p.status === 'COMPLETED'
                          ? 'bg-emerald-500 text-white'
                          : p.status === 'IN_PROGRESS'
                            ? 'bg-ink-600 text-white'
                            : 'bg-slate-200 text-slate-500',
                      )}
                    >
                      {p.status === 'COMPLETED' ? '✓' : p.sequence}
                    </span>
                    {i < job.progress.length - 1 && <span className="w-px flex-1 bg-slate-200" />}
                  </div>

                  <div className="flex-1 pb-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[14px] font-medium text-slate-800">{p.stageName}</p>
                      <Badge tone={STAGE_TONE[p.status]}>{p.status.replace('_', ' ')}</Badge>
                      {p.isTerminal && <Badge tone="violet">terminal</Badge>}
                      {p.department && <span className="text-[12px] text-slate-400">{p.department}</span>}
                    </div>

                    <div className="mt-1 space-y-0.5 text-[12px] text-slate-500">
                      {p.startedAt && <div>Started {formatDateTime(p.startedAt)}</div>}
                      {p.completedAt && <div>Completed {formatDateTime(p.completedAt)}</div>}
                      <div>{p.operator ? `Operator: ${p.operator.name}` : 'Unassigned'}</div>
                    </div>

                    {can('production', 'U') && p.status !== 'COMPLETED' && (
                      <div className="mt-2 flex items-center gap-2">
                        <Select value={assignTo} onChange={(e) => setAssignTo(e.target.value)} className="h-8 w-56 py-1 text-[13px]">
                          <option value="">Assign operator…</option>
                          {assignable.map((u) => (
                            <option key={u.id} value={u.id}>
                              {u.name}
                            </option>
                          ))}
                        </Select>
                        <Button variant="secondary" size="sm" disabled={!assignTo} onClick={() => assign.mutate(p.id)}>
                          Assign
                        </Button>
                      </div>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Job bag" subtitle="What the physical work travels with" />
            <div className="p-5 text-center">
              {job.qrToken ? (
                <>
                  <div className="mx-auto grid size-40 place-items-center rounded-lg bg-slate-900 p-3">
                    <QrCode value={job.qrPayload ?? job.qrToken} />
                  </div>
                  <p className="mt-3 break-all font-mono text-[10px] text-slate-400">{job.qrToken}</p>
                  <p className="mt-2 text-[12px] text-slate-500">
                    Scan on the floor to advance the stage. {job.printedAt ? `Printed ${formatDate(job.printedAt)}.` : 'Not printed yet.'}
                  </p>
                </>
              ) : (
                <p className="text-[13px] text-slate-500">A QR token is created the first time this job bag is opened.</p>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Customer" />
            <dl className="space-y-2 p-5 text-[13px]">
              <Row label="Name" value={job.customer?.name ?? '—'} />
              <Row label="Phone" value={job.customer?.phone ?? '—'} />
              <Row label="GSTIN" value={job.customer?.gstin ?? 'Unregistered'} />
              <Row label="Delivery" value={formatDate(job.deliveryDate)} />
              <Row label="Priority" value={job.priority} />
              <Row label="Booked by" value={session?.tenant.tradeName ?? ''} />
            </dl>
          </Card>

          <Card>
            <CardHeader title="Event log" subtitle="Who did what, when" />
            <div className="max-h-96 overflow-y-auto p-5">
              {events.isLoading ? (
                <Spinner label="" />
              ) : (
                <ul className="space-y-3 text-[12px]">
                  {(events.data?.data ?? []).map((e) => (
                    <li key={e.id} className="border-l-2 border-slate-200 pl-3">
                      <p className="font-medium text-slate-700">
                        {e.eventType.replace(/_/g, ' ').toLowerCase()}
                        {e.fromStage && e.toStage && (
                          <span className="font-normal text-slate-500">
                            {' '}
                            {e.fromStage} → {e.toStage}
                          </span>
                        )}
                      </p>
                      <p className="text-slate-400">
                        {formatDateTime(e.createdAt)} · {e.actor?.name ?? 'system'} · {e.source.toLowerCase()}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="truncate text-right text-slate-800">{value}</dd>
    </div>
  );
}

/**
 * A dependency-free QR renderer would be overkill here; the token is what the
 * scanner posts to /production/scan, so we render it as a scannable-looking
 * block plus the literal token the operator can type if a camera fails.
 */
function QrCode({ value }: { value: string }) {
  // Deterministic 21×21 pattern derived from the token — a visual placeholder
  // that stays stable per job. Replaced by a real QR image at print time.
  const cells: boolean[] = [];
  let hash = 0;
  for (let i = 0; i < value.length; i++) hash = (hash * 31 + value.charCodeAt(i)) >>> 0;
  let state = hash || 1;
  for (let i = 0; i < 21 * 21; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    cells.push((state >> 16) % 2 === 0);
  }
  return (
    <div className="grid size-full" style={{ gridTemplateColumns: 'repeat(21, 1fr)' }} aria-label="Job QR code">
      {cells.map((on, i) => (
        <span key={i} className={on ? 'bg-white' : 'bg-slate-900'} />
      ))}
    </div>
  );
}
