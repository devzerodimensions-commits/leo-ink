import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatDate, money, VERTICAL_LABELS } from '../lib/format';
import type { JobCard, Paged, QuoteSummary, TatResponse } from '../lib/types';
import { Alert, Badge, Button, Card, CardHeader, EmptyState, PageHeader, Spinner, Table, Td, Th } from '../components/ui';

const QUOTE_TONE: Record<string, 'slate' | 'blue' | 'green' | 'amber' | 'rose'> = {
  DRAFT: 'slate',
  SENT: 'blue',
  WON: 'green',
  LOST: 'rose',
  EXPIRED: 'amber',
};

function Stat({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'rose' | 'amber' }) {
  return (
    <Card className="p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p
        className={
          'mt-1 text-2xl font-semibold tnum ' +
          (tone === 'rose' ? 'text-rose-600' : tone === 'amber' ? 'text-amber-600' : 'text-slate-900')
        }
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-[12px] text-slate-500">{hint}</p>}
    </Card>
  );
}

export default function DashboardPage() {
  const { session, can } = useAuth();

  const quotes = useQuery({
    queryKey: ['quotes', 'dashboard'],
    queryFn: () => api.get<Paged<QuoteSummary>>('/quotes?pageSize=6'),
    enabled: can('quotation', 'R'),
  });

  const jobs = useQuery({
    queryKey: ['jobcards', 'dashboard'],
    queryFn: () => api.get<Paged<JobCard>>('/jobcards?pageSize=6'),
    enabled: can('jobcard', 'R'),
  });

  const tat = useQuery({
    queryKey: ['tat', 'dashboard'],
    queryFn: () => api.get<TatResponse>('/production/tat?filter=all'),
    enabled: can('production', 'R'),
  });

  const openQuoteValue = (quotes.data?.data ?? [])
    .filter((q) => q.status === 'SENT')
    .reduce((sum, q) => sum + Number(q.grandTotal || 0), 0);

  return (
    <>
      <PageHeader
        title={`Good day, ${session?.user.name?.split(' ')[0] ?? 'there'}`}
        subtitle={`${session?.tenant.tradeName ?? session?.tenant.legalName} · quote it right, run it on the floor, get paid on time`}
        actions={
          can('quotation', 'C') && (
            <Link to="/quotes/new">
              <Button>New quotation</Button>
            </Link>
          )
        }
      />

      {!session?.tenant.goLiveReady && (
        <div className="mb-5">
          <Alert tone="amber" title="Your shop isn't fully set up yet">
            Add your GSTIN, a branch and a financial year to start raising GST-compliant documents.{' '}
            <Link to="/setup" className="font-medium underline underline-offset-2">
              Finish setup
            </Link>
          </Alert>
        </div>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          label="Quotes awaiting decision"
          value={String((quotes.data?.data ?? []).filter((q) => q.status === 'SENT').length)}
          hint={openQuoteValue ? `${money(openQuoteValue)} in play` : undefined}
        />
        <Stat
          label="Jobs in production"
          value={String((jobs.data?.data ?? []).filter((j) => j.overallStatus === 'IN_PROGRESS').length)}
        />
        <Stat label="Due today" value={String(tat.data?.counts?.dueToday ?? 0)} tone="amber" />
        <Stat label="Overdue" value={String(tat.data?.counts?.overdue ?? 0)} tone="rose" hint="Past promised delivery" />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        {can('quotation', 'R') && (
          <Card>
            <CardHeader
              title="Recent quotations"
              subtitle="Priced through the shared engine — the invoice will match to the paise"
              actions={
                <Link to="/quotes">
                  <Button variant="secondary" size="sm">
                    View all
                  </Button>
                </Link>
              }
            />
            {quotes.isLoading ? (
              <Spinner />
            ) : (quotes.data?.data ?? []).length === 0 ? (
              <EmptyState
                title="No quotations yet"
                hint="Build your first quote — pick a media, enter height × width, and Leo Ink does the sq-ft maths and the GST."
                action={
                  can('quotation', 'C') ? (
                    <Link to="/quotes/new">
                      <Button size="sm">Create a quotation</Button>
                    </Link>
                  ) : undefined
                }
              />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Quote</Th>
                    <Th>Customer</Th>
                    <Th>Status</Th>
                    <Th align="right">Total</Th>
                  </tr>
                </thead>
                <tbody>
                  {(quotes.data?.data ?? []).map((q) => (
                    <tr key={q.id} className="hover:bg-slate-50">
                      <Td>
                        <Link to={`/quotes/${q.id}`} className="font-medium text-ink-700 hover:underline">
                          {q.quoteNo ?? 'Draft'}
                        </Link>
                        <span className="ml-2 text-[12px] text-slate-500">{formatDate(q.quoteDate)}</span>
                      </Td>
                      <Td>{q.customer?.name ?? '—'}</Td>
                      <Td>
                        <Badge tone={QUOTE_TONE[q.status] ?? 'slate'}>{q.status}</Badge>
                      </Td>
                      <Td align="right">{money(q.grandTotal)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        )}

        {can('jobcard', 'R') && (
          <Card>
            <CardHeader
              title="On the floor"
              subtitle="Where every job actually is"
              actions={
                <Link to="/board">
                  <Button variant="secondary" size="sm">
                    Open board
                  </Button>
                </Link>
              }
            />
            {jobs.isLoading ? (
              <Spinner />
            ) : (jobs.data?.data ?? []).length === 0 ? (
              <EmptyState title="No jobcards yet" hint="Convert a won quote, or book a 15-second walk-in jobcard." />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Jobcard</Th>
                    <Th>Customer</Th>
                    <Th>Vertical</Th>
                    <Th>Delivery</Th>
                  </tr>
                </thead>
                <tbody>
                  {(jobs.data?.data ?? []).map((j) => (
                    <tr key={j.id} className="hover:bg-slate-50">
                      <Td>
                        <Link to={`/jobcards/${j.id}`} className="font-medium text-ink-700 hover:underline">
                          {j.jobcardNo}
                        </Link>
                        {j.rushFlag && (
                          <Badge tone="rose" className="ml-2">
                            RUSH
                          </Badge>
                        )}
                        {j.stageName && <div className="text-[12px] text-slate-500">at {j.stageName}</div>}
                      </Td>
                      <Td>{j.customerName}</Td>
                      <Td>{VERTICAL_LABELS[j.vertical] ?? j.vertical}</Td>
                      <Td>
                        {formatDate(j.deliveryDate)}
                        {j.overdue && (
                          <Badge tone="rose" className="ml-2">
                            Overdue
                          </Badge>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
