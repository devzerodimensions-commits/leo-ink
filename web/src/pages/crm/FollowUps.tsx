import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { formatDateTime } from '../../lib/format';
import {
  Alert,
  Badge,
  Button,
  Card,
  EmptyState,
  Field,
  Modal,
  PageHeader,
  Spinner,
  Table,
  Td,
  Textarea,
  Th,
} from '../../components/ui';

interface FollowUp {
  id: string;
  dueAt: string;
  note: string;
  status: 'OPEN' | 'CLOSED';
  outcome: string | null;
  overdue?: boolean;
  enquiry?: { id: string; contactName: string } | null;
  quote?: { id: string; quoteNo: string | null } | null;
  assignee?: { id: string; name: string } | null;
}

export default function FollowUpsPage() {
  const qc = useQueryClient();
  const [closing, setClosing] = useState<FollowUp | null>(null);
  const [outcome, setOutcome] = useState('');
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['follow-ups', 'mine'],
    queryFn: () => api.get<{ data: FollowUp[] }>('/follow-ups/mine'),
  });

  const close = useMutation({
    mutationFn: (id: string) => api.post(`/follow-ups/${id}/close`, { outcome }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['follow-ups'] });
      setClosing(null);
      setOutcome('');
      setError(null);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not close the follow-up'),
  });

  const items = list.data?.data ?? [];
  const open = items.filter((f) => f.status === 'OPEN');

  return (
    <>
      <PageHeader
        title="My follow-ups"
        subtitle="Nothing slips — every lead and quote can carry a dated reminder"
        actions={
          open.some((f) => f.overdue) ? <Badge tone="rose">{open.filter((f) => f.overdue).length} overdue</Badge> : null
        }
      />

      {error && (
        <div className="mb-4">
          <Alert tone="rose">{error}</Alert>
        </div>
      )}

      <Card>
        {list.isLoading ? (
          <Spinner />
        ) : items.length === 0 ? (
          <EmptyState
            title="No follow-ups assigned to you"
            hint="Add a follow-up from an enquiry or a quotation and it will show up here when it's due."
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Due</Th>
                <Th>On</Th>
                <Th>Note</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {items.map((f) => (
                <tr key={f.id} className={f.status === 'CLOSED' ? 'text-slate-400' : 'hover:bg-slate-50'}>
                  <Td>
                    {formatDateTime(f.dueAt)}
                    {f.overdue && f.status === 'OPEN' && (
                      <Badge tone="rose" className="ml-2">
                        Overdue
                      </Badge>
                    )}
                  </Td>
                  <Td>
                    {f.quote ? (
                      <Link to={`/quotes/${f.quote.id}`} className="text-ink-700 hover:underline">
                        Quote {f.quote.quoteNo ?? 'draft'}
                      </Link>
                    ) : f.enquiry ? (
                      <Link to="/enquiries" className="text-ink-700 hover:underline">
                        Enquiry — {f.enquiry.contactName}
                      </Link>
                    ) : (
                      '—'
                    )}
                  </Td>
                  <Td className="max-w-md">{f.note}</Td>
                  <Td>
                    <Badge tone={f.status === 'OPEN' ? 'blue' : 'green'}>{f.status}</Badge>
                    {f.outcome && <div className="mt-0.5 text-[11px] text-slate-400">{f.outcome}</div>}
                  </Td>
                  <Td align="right">
                    {f.status === 'OPEN' && (
                      <Button variant="ghost" size="sm" onClick={() => setClosing(f)}>
                        Close
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
        open={Boolean(closing)}
        onClose={() => setClosing(null)}
        title="Close follow-up"
        subtitle="An outcome note is required so the history stays useful"
        footer={
          <>
            <Button variant="secondary" onClick={() => setClosing(null)}>
              Cancel
            </Button>
            <Button disabled={!outcome.trim() || close.isPending} onClick={() => closing && close.mutate(closing.id)}>
              {close.isPending ? 'Saving…' : 'Close follow-up'}
            </Button>
          </>
        }
      >
        <Field label="Outcome" required>
          <Textarea value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="Spoke to Mr Deshmukh — wants a revised rate for 10 banners" />
        </Field>
      </Modal>
    </>
  );
}
