import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { formatDate, VERTICAL_LABELS } from '../../lib/format';
import type { MyJobsResponse } from '../../lib/types';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Spinner, cx } from '../../components/ui';

export default function MyJobsPage() {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const queue = useQuery({
    queryKey: ['my-jobs'],
    queryFn: () => api.get<MyJobsResponse>('/production/my-jobs'),
    refetchInterval: 30_000,
  });

  const complete = useMutation({
    mutationFn: (jobcardId: string) => api.post(`/jobcards/${jobcardId}/advance`, {}),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ['my-jobs'] });
      void qc.invalidateQueries({ queryKey: ['board'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not complete that stage'),
  });

  const items = queue.data?.data ?? [];

  return (
    <>
      <PageHeader title="My jobs" subtitle="Your actionable stages — rush and overdue first" />

      {error && (
        <div className="mb-4">
          <Alert tone="rose">{error}</Alert>
        </div>
      )}

      {queue.isLoading ? (
        <Spinner label="Loading your queue…" />
      ) : items.length === 0 ? (
        <Card>
          <EmptyState title="Nothing waiting on you" hint="Jobs assigned to you, or unassigned in your department, appear here." />
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => (
            <Card
              key={item.stageProgressId ?? item.id}
              className={cx('p-4', item.rushFlag && 'ring-2 ring-amber-200', item.overdue && 'ring-2 ring-rose-300')}
            >
              <div className="flex items-start justify-between gap-2">
                <Link to={`/jobcards/${item.jobcardId}`} className="text-[14px] font-semibold text-ink-700 hover:underline">
                  {item.jobcardNo}
                </Link>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                  {item.rushFlag && <Badge tone="rose">RUSH</Badge>}
                  {item.overdue && <Badge tone="rose">Overdue</Badge>}
                  {item.dueToday && !item.overdue && <Badge tone="amber">Today</Badge>}
                  {!item.assignedOperatorId && <Badge tone="slate">Unassigned</Badge>}
                </div>
              </div>

              <p className="mt-1 text-[13px] text-slate-700">{item.customerName}</p>
              <p className="text-[12px] text-slate-500">{VERTICAL_LABELS[item.vertical] ?? item.vertical}</p>

              <div className="mt-3 flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
                <div>
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">Stage</p>
                  <p className="text-[13px] font-medium text-slate-800">{item.stageName ?? '—'}</p>
                  {item.department && <p className="text-[11px] text-slate-400">{item.department}</p>}
                </div>
                <div className="text-right">
                  <p className="text-[11px] uppercase tracking-wide text-slate-400">Due</p>
                  <p className="text-[13px] text-slate-700">{formatDate(item.deliveryDate)}</p>
                </div>
              </div>

              <Button className="mt-3 w-full" onClick={() => complete.mutate(item.jobcardId)} disabled={complete.isPending}>
                Done — send to next stage
              </Button>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}
