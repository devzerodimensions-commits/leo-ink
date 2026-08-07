import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate, formatDateTime, money, qty as fmtQty, rate as fmtRate } from '../../lib/format';
import { stateName } from '../../lib/states';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Modal,
  PageHeader,
  Select,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from '../../components/ui';

interface QuoteLine {
  id: string;
  lineNo: number;
  description: string;
  hsnSac: string | null;
  specJson: Record<string, unknown> | null;
  qty: string;
  heightFt: string | null;
  widthFt: string | null;
  areaSqft: string | null;
  rate: string;
  rateSource: string;
  grossAmount: string;
  minChargeApplied: boolean;
  discountAmt: string;
  docDiscountShare: string;
  lineTaxable: string;
  gstPct: string;
  cgst: string;
  sgst: string;
  igst: string;
  lineTax: string;
  lineTotal: string;
}

interface Quote {
  id: string;
  quoteNo: string | null;
  quoteDate: string;
  validUntil: string | null;
  status: 'DRAFT' | 'SENT' | 'WON' | 'LOST' | 'EXPIRED';
  placeOfSupplyState: string | null;
  supplierStateCode: string;
  isInterstate: boolean;
  subtotal: string;
  discountTotal: string;
  taxableValue: string;
  cgst: string;
  sgst: string;
  igst: string;
  roundOff: string;
  grandTotal: string;
  amountInWords: string | null;
  engineVersion: string | null;
  needsApproval: boolean;
  lostReason: string | null;
  notes: string | null;
  sentAt: string | null;
  sentVia: string | null;
  customer?: { id: string; name: string; gstin: string | null; phone: string; email: string | null };
  branch?: { branchCode: string; name: string };
  lines: QuoteLine[];
  jobcards?: Array<{ id: string; jobcardNo: string }>;
}

const TONE = { DRAFT: 'slate', SENT: 'blue', WON: 'green', LOST: 'rose', EXPIRED: 'amber' } as const;

export default function QuoteViewPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { can } = useAuth();

  const [error, setError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [channel, setChannel] = useState('WHATSAPP');
  const [lostOpen, setLostOpen] = useState(false);
  const [lostReason, setLostReason] = useState('');

  const q = useQuery({
    queryKey: ['quote', id],
    queryFn: () => api.get<Quote>(`/quotes/${id}`),
    enabled: Boolean(id),
  });

  const quote = q.data;
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['quote', id] });
    void qc.invalidateQueries({ queryKey: ['quotes'] });
  };
  const fail = (err: unknown) => setError(err instanceof ApiError ? err.message : 'Something went wrong');

  const send = useMutation({
    mutationFn: () => api.post(`/quotes/${id}/send`, { channel }),
    onSuccess: () => {
      setError(null);
      setShareOpen(false);
      invalidate();
    },
    onError: fail,
  });

  const setStatus = useMutation({
    mutationFn: (body: { status: string; lostReason?: string }) => api.post(`/quotes/${id}/status`, body),
    onSuccess: () => {
      setError(null);
      setLostOpen(false);
      invalidate();
    },
    onError: fail,
  });

  const clone = useMutation({
    mutationFn: () => api.post<{ id: string }>(`/quotes/${id}/clone`, {}),
    onSuccess: (cloned) => navigate(`/quotes/${cloned.id}/edit`),
    onError: fail,
  });

  /** FR-233 — the conversion returns both sides of the link. */
  const convert = useMutation({
    mutationFn: () =>
      api.post<{ quote: { id: string }; jobcard: { id: string; jobcardNo: string } }>(
        `/quotes/${id}/convert-to-jobcard`,
        {},
      ),
    onSuccess: (res) => navigate(`/jobcards/${res.jobcard.id}`),
    onError: fail,
  });

  if (q.isLoading) return <Spinner label="Loading quotation…" />;
  if (!quote) return <Alert tone="rose">Quotation not found.</Alert>;

  const terminal = quote.status === 'WON' || quote.status === 'LOST';

  return (
    <>
      <PageHeader
        title={quote.quoteNo ?? 'Draft quotation'}
        subtitle={`${quote.customer?.name ?? ''} · ${formatDate(quote.quoteDate)}${
          quote.validUntil ? ` · valid until ${formatDate(quote.validUntil)}` : ''
        }`}
        actions={
          <>
            <Badge tone={TONE[quote.status]}>{quote.status}</Badge>
            {quote.status === 'DRAFT' && can('quotation', 'U') && (
              <>
                <Link to={`/quotes/${quote.id}/edit`}>
                  <Button variant="secondary">Edit</Button>
                </Link>
                <Button onClick={() => setShareOpen(true)}>Send to customer</Button>
              </>
            )}
            {quote.status === 'SENT' && can('quotation', 'U') && (
              <>
                <Button variant="secondary" onClick={() => setLostOpen(true)}>
                  Mark lost
                </Button>
                <Button onClick={() => setStatus.mutate({ status: 'WON' })}>Mark won</Button>
              </>
            )}
            {quote.status === 'WON' && can('jobcard', 'C') && !quote.jobcards?.length && (
              <Button onClick={() => convert.mutate()} disabled={convert.isPending}>
                {convert.isPending ? 'Creating…' : 'Convert to jobcard'}
              </Button>
            )}
            {can('quotation', 'C') && (
              <Button variant="secondary" onClick={() => clone.mutate()}>
                {quote.status === 'EXPIRED' ? 'Revive' : 'Clone'}
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
      {quote.needsApproval && (
        <div className="mb-4">
          <Alert tone="amber" title="Discount above the shop threshold">
            This quotation is flagged for manager approval.
          </Alert>
        </div>
      )}
      {quote.jobcards?.length ? (
        <div className="mb-4">
          <Alert tone="green" title="Converted to production">
            Jobcard{' '}
            <Link to={`/jobcards/${quote.jobcards[0].id}`} className="font-medium underline underline-offset-2">
              {quote.jobcards[0].jobcardNo}
            </Link>{' '}
            was created from this quotation.
          </Alert>
        </div>
      ) : null}
      {quote.status === 'LOST' && quote.lostReason && (
        <div className="mb-4">
          <Alert tone="rose" title="Lost">
            {quote.lostReason}
          </Alert>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[1fr_320px]">
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Quotation / Estimate"
              subtitle={`${quote.branch?.branchCode ?? ''} ${stateName(quote.supplierStateCode)} → ${stateName(
                quote.placeOfSupplyState,
              )} · ${quote.isInterstate ? 'IGST (inter-state)' : 'CGST + SGST (intra-state)'}`}
            />
            <Table>
              <thead>
                <tr>
                  <Th>#</Th>
                  <Th>Description</Th>
                  <Th>HSN/SAC</Th>
                  <Th align="right">Qty / area</Th>
                  <Th align="right">Rate</Th>
                  <Th align="right">Discount</Th>
                  <Th align="right">Taxable</Th>
                  <Th align="right">GST</Th>
                  <Th align="right">Total</Th>
                </tr>
              </thead>
              <tbody>
                {quote.lines.map((l) => (
                  <tr key={l.id}>
                    <Td>{l.lineNo}</Td>
                    <Td>
                      <span className="font-medium text-slate-800">{l.description}</span>
                      {l.heightFt && l.widthFt && (
                        <div className="text-[12px] text-slate-500">
                          {fmtRate(l.heightFt)} × {fmtRate(l.widthFt)} ft
                          {l.areaSqft && ` = ${fmtRate(l.areaSqft)} sq.ft`} × {fmtQty(l.qty)}
                        </div>
                      )}
                      {l.minChargeApplied && (
                        <Badge tone="amber" className="mt-1">
                          minimum charge applied
                        </Badge>
                      )}
                    </Td>
                    <Td className="font-mono text-[12px]">{l.hsnSac ?? '—'}</Td>
                    <Td align="right">{l.areaSqft ? `${fmtRate(l.areaSqft)} sq.ft` : fmtQty(l.qty)}</Td>
                    <Td align="right">{fmtRate(l.rate)}</Td>
                    <Td align="right">
                      {Number(l.discountAmt) + Number(l.docDiscountShare) > 0
                        ? `−${money(Number(l.discountAmt) + Number(l.docDiscountShare))}`
                        : '—'}
                    </Td>
                    <Td align="right">{money(l.lineTaxable)}</Td>
                    <Td align="right">
                      {money(l.lineTax)}
                      <div className="text-[11px] text-slate-400">{fmtRate(l.gstPct)}%</div>
                    </Td>
                    <Td align="right" className="font-medium text-slate-900">
                      {money(l.lineTotal)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>

            <div className="border-t border-slate-200 p-5">
              <div className="ml-auto max-w-sm space-y-1.5 text-[13px]">
                <Row label="Subtotal" value={money(quote.subtotal)} />
                {Number(quote.discountTotal) > 0 && <Row label="Discount" value={`−${money(quote.discountTotal)}`} />}
                <Row label="Taxable value" value={money(quote.taxableValue)} strong />
                {quote.isInterstate ? (
                  <Row label="IGST" value={money(quote.igst)} />
                ) : (
                  <>
                    <Row label="CGST" value={money(quote.cgst)} />
                    <Row label="SGST" value={money(quote.sgst)} />
                  </>
                )}
                {Number(quote.roundOff) !== 0 && (
                  <Row label="Round off" value={`${Number(quote.roundOff) > 0 ? '+' : ''}${money(quote.roundOff)}`} />
                )}
                <div className="flex items-baseline justify-between border-t border-slate-200 pt-2">
                  <span className="font-semibold text-slate-700">Grand total</span>
                  <span className="tnum text-lg font-semibold text-slate-900">{money(quote.grandTotal)}</span>
                </div>
                {quote.amountInWords && (
                  <p className="pt-1 text-[12px] italic leading-relaxed text-slate-500">{quote.amountInWords}</p>
                )}
              </div>
            </div>
          </Card>

          {quote.notes && (
            <Card>
              <CardHeader title="Notes & terms" />
              <p className="whitespace-pre-wrap p-5 text-[13px] text-slate-700">{quote.notes}</p>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader title="Customer" />
            <dl className="space-y-2 p-5 text-[13px]">
              <Row label="Name" value={quote.customer?.name ?? '—'} />
              <Row label="GSTIN" value={quote.customer?.gstin ?? 'Unregistered'} />
              <Row label="Phone" value={quote.customer?.phone ?? '—'} />
              <Row label="Email" value={quote.customer?.email ?? '—'} />
              <Row label="Place of supply" value={stateName(quote.placeOfSupplyState)} />
            </dl>
          </Card>

          <Card>
            <CardHeader title="Audit" />
            <dl className="space-y-2 p-5 text-[13px]">
              <Row label="Status" value={quote.status} />
              <Row label="Sent" value={quote.sentAt ? `${formatDateTime(quote.sentAt)} (${quote.sentVia})` : 'Not sent'} />
              <Row label="Pricing engine" value={quote.engineVersion ?? '—'} />
            </dl>
            <p className="border-t border-slate-100 px-5 py-3 text-[12px] leading-relaxed text-slate-500">
              The stamped engine version guarantees the invoice raised from this quote reproduces these figures exactly.
            </p>
          </Card>
        </div>
      </div>

      <Modal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        title="Send quotation"
        subtitle="Sending assigns the gap-free quote number and moves the status to Sent"
        footer={
          <>
            <Button variant="secondary" onClick={() => setShareOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => send.mutate()} disabled={send.isPending}>
              {send.isPending ? 'Sending…' : 'Send'}
            </Button>
          </>
        }
      >
        <Field label="Channel">
          <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
            <option value="WHATSAPP">WhatsApp — {quote.customer?.phone}</option>
            <option value="EMAIL">Email — {quote.customer?.email ?? 'no email on file'}</option>
            <option value="SMS">SMS — {quote.customer?.phone}</option>
          </Select>
        </Field>
      </Modal>

      <Modal
        open={lostOpen}
        onClose={() => setLostOpen(false)}
        title="Mark this quotation lost"
        subtitle="A reason is required so lost-reason analytics stay meaningful"
        footer={
          <>
            <Button variant="secondary" onClick={() => setLostOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => setStatus.mutate({ status: 'LOST', lostReason })}
              disabled={!lostReason.trim() || setStatus.isPending}
            >
              Mark lost
            </Button>
          </>
        }
      >
        <Field label="Reason" required>
          <Textarea value={lostReason} onChange={(e) => setLostReason(e.target.value)} placeholder="Price too high — went to a local competitor" />
        </Field>
      </Modal>

      {terminal && null}
    </>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className={'tnum truncate text-right ' + (strong ? 'font-semibold text-slate-900' : 'text-slate-700')}>{value}</dd>
    </div>
  );
}
