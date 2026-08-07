import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate, VERTICAL_LABELS } from '../../lib/format';
import type { BoardResponse, Priority } from '../../lib/types';
import { Alert, Badge, Button, Card, EmptyState, PageHeader, Select, Spinner, cx } from '../../components/ui';

const PRIORITY_TONE: Record<Priority, 'rose' | 'slate'> = { HIGH: 'rose', NORMAL: 'slate', LOW: 'slate' };

export default function BoardPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [vertical, setVertical] = useState('');
  const [filter, setFilter] = useState('');
  const [includeDone, setIncludeDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const board = useQuery({
    queryKey: ['board', vertical, filter, includeDone],
    queryFn: () =>
      api.get<BoardResponse>(
        `/production/board${qs({
          vertical,
          includeDone: includeDone ? 'true' : '',
          dueToday: filter === 'dueToday' ? 'true' : '',
          overdue: filter === 'overdue' ? 'true' : '',
          rush: filter === 'rush' ? 'true' : '',
        })}`,
      ),
    refetchInterval: 30_000,
  });

  const advance = useMutation({
    mutationFn: (jobcardId: string) => api.post(`/jobcards/${jobcardId}/advance`, {}),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: ['board'] });
      void qc.invalidateQueries({ queryKey: ['jobcards'] });
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not move that job'),
  });

  const columns = board.data?.columns ?? [];
  const totalCards = columns.reduce((n, c) => n + c.cards.length, 0);

  return (
    <>
      <PageHeader
        title="Job board"
        subtitle="One screen for where every job is — counter, design, machine, dispatch"
        actions={
          <>
            <Select value={vertical} onChange={(e) => setVertical(e.target.value)} className="w-44">
              <option value="">All verticals</option>
              {Object.entries(VERTICAL_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <Select value={filter} onChange={(e) => setFilter(e.target.value)} className="w-40">
              <option value="">All jobs</option>
              <option value="dueToday">Due today</option>
              <option value="overdue">Overdue</option>
              <option value="rush">Rush only</option>
            </Select>
            <label className="flex items-center gap-2 whitespace-nowrap text-[13px] text-slate-600">
              <input type="checkbox" checked={includeDone} onChange={(e) => setIncludeDone(e.target.checked)} />
              Show done
            </label>
          </>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert tone="rose">{error}</Alert>
        </div>
      )}

      {board.isLoading ? (
        <Spinner label="Loading the floor…" />
      ) : totalCards === 0 ? (
        <Card>
          <EmptyState
            title="Nothing on the floor right now"
            hint="Convert a won quotation or book a walk-in jobcard and it appears here immediately."
            action={
              can('jobcard', 'C') ? (
                <Link to="/jobcards">
                  <Button size="sm">Book a jobcard</Button>
                </Link>
              ) : undefined
            }
          />
        </Card>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {columns.map((col) => (
            <div key={col.key} className="w-72 shrink-0">
              <div className="mb-2 flex items-center justify-between px-1">
                <div className="min-w-0">
                  <p className="truncate text-[13px] font-semibold text-slate-700">{col.name}</p>
                  {col.departments.length > 0 && (
                    <p className="truncate text-[11px] text-slate-400">{col.departments.join(' · ')}</p>
                  )}
                </div>
                <Badge tone={col.isDone ? 'green' : col.isTerminal ? 'violet' : 'slate'}>{col.cards.length}</Badge>
              </div>

              <div className="min-h-24 space-y-2 rounded-xl bg-slate-200/50 p-2">
                {col.cards.length === 0 && <p className="px-2 py-6 text-center text-[12px] text-slate-400">Nothing here</p>}

                {col.cards.map((card) => (
                  <div
                    key={card.id}
                    className={cx(
                      'rounded-lg border bg-white p-3 shadow-sm transition-shadow hover:shadow',
                      card.overdue ? 'border-rose-300' : card.rushFlag ? 'border-amber-300' : 'border-slate-200',
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <Link to={`/jobcards/${card.id}`} className="text-[13px] font-semibold text-ink-700 hover:underline">
                        {card.jobcardNo}
                      </Link>
                      <div className="flex shrink-0 flex-wrap justify-end gap-1">
                        {card.rushFlag && <Badge tone="rose">RUSH</Badge>}
                        {card.overdue && <Badge tone="rose">Overdue</Badge>}
                        {card.dueToday && !card.overdue && <Badge tone="amber">Today</Badge>}
                        {card.specIncomplete && <Badge tone="amber">Spec</Badge>}
                      </div>
                    </div>

                    <p className="mt-1 truncate text-[13px] text-slate-700">{card.customerName}</p>
                    <p className="truncate text-[11px] text-slate-400">
                      {VERTICAL_LABELS[card.vertical] ?? card.vertical}
                      {card.specCount > 1 && ` · ${card.specCount} items`}
                    </p>

                    <div className="mt-2 flex items-center justify-between text-[11px] text-slate-500">
                      <span>{formatDate(card.deliveryDate)}</span>
                      {card.priority !== 'NORMAL' && <Badge tone={PRIORITY_TONE[card.priority]}>{card.priority}</Badge>}
                    </div>

                    {card.assignedOperatorName && (
                      <p className="mt-1 truncate text-[11px] text-slate-400">→ {card.assignedOperatorName}</p>
                    )}

                    {can('production', 'U') && !col.isDone && (
                      <Button
                        variant={col.isTerminal ? 'primary' : 'secondary'}
                        size="sm"
                        className="mt-2 w-full"
                        onClick={() => advance.mutate(card.id)}
                        disabled={advance.isPending}
                      >
                        {col.isTerminal ? 'Mark done ✓' : 'Move to next stage →'}
                      </Button>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
