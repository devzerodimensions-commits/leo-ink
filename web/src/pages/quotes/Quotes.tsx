import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate, money } from '../../lib/format';
import { Badge, Button, Card, EmptyState, Input, PageHeader, Select, Spinner, Table, Td, Th } from '../../components/ui';

interface QuoteRow {
  id: string;
  quoteNo: string | null;
  quoteDate: string;
  validUntil: string | null;
  status: 'DRAFT' | 'SENT' | 'WON' | 'LOST' | 'EXPIRED';
  grandTotal: string;
  taxableValue: string;
  isInterstate: boolean;
  needsApproval: boolean;
  customer?: { id: string; name: string };
  jobcards?: Array<{ id: string; jobcardNo: string }>;
}

const TONE = { DRAFT: 'slate', SENT: 'blue', WON: 'green', LOST: 'rose', EXPIRED: 'amber' } as const;

export default function QuotesPage() {
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');

  const list = useQuery({
    queryKey: ['quotes', status, search],
    queryFn: () => api.get<{ data: QuoteRow[]; total: number }>(`/quotes${qs({ status, q: search, pageSize: 100 })}`),
  });

  return (
    <>
      <PageHeader
        title="Quotations"
        subtitle="Draft → Sent → Won/Lost, with validity and one-click conversion to a jobcard"
        actions={
          can('quotation', 'C') && (
            <Link to="/quotes/new">
              <Button>New quotation</Button>
            </Link>
          )
        }
      />

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3">
          <Input
            placeholder="Search quote number or customer…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
          />
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40">
            <option value="">All statuses</option>
            <option value="DRAFT">Draft</option>
            <option value="SENT">Sent</option>
            <option value="WON">Won</option>
            <option value="LOST">Lost</option>
            <option value="EXPIRED">Expired</option>
          </Select>
          <span className="ml-auto text-[13px] text-slate-500">{list.data?.total ?? 0} quotations</span>
        </div>

        {list.isLoading ? (
          <Spinner />
        ) : (list.data?.data ?? []).length === 0 ? (
          <EmptyState
            title="No quotations yet"
            hint="Pick a media, type height × width, and Leo Ink does the square-foot maths, the minimum charge and the GST split."
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
                <Th>Quote no.</Th>
                <Th>Date</Th>
                <Th>Customer</Th>
                <Th>Status</Th>
                <Th>Valid until</Th>
                <Th>Supply</Th>
                <Th align="right">Taxable</Th>
                <Th align="right">Grand total</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {(list.data?.data ?? []).map((q) => (
                <tr key={q.id} className="hover:bg-slate-50">
                  <Td>
                    <Link to={`/quotes/${q.id}`} className="font-medium text-ink-700 hover:underline">
                      {q.quoteNo ?? <span className="italic text-slate-400">Draft (unnumbered)</span>}
                    </Link>
                    {q.needsApproval && (
                      <Badge tone="amber" className="ml-2">
                        Needs approval
                      </Badge>
                    )}
                  </Td>
                  <Td>{formatDate(q.quoteDate)}</Td>
                  <Td>{q.customer?.name ?? '—'}</Td>
                  <Td>
                    <Badge tone={TONE[q.status]}>{q.status}</Badge>
                  </Td>
                  <Td>{formatDate(q.validUntil)}</Td>
                  <Td>
                    <Badge tone={q.isInterstate ? 'violet' : 'green'}>{q.isInterstate ? 'IGST' : 'CGST+SGST'}</Badge>
                  </Td>
                  <Td align="right">{money(q.taxableValue)}</Td>
                  <Td align="right" className="font-medium text-slate-900">
                    {money(q.grandTotal)}
                  </Td>
                  <Td align="right">
                    {q.jobcards?.length ? (
                      <Link to={`/jobcards/${q.jobcards[0].id}`}>
                        <Badge tone="blue">{q.jobcards[0].jobcardNo}</Badge>
                      </Link>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </>
  );
}
