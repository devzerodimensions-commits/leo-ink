import { useState, type FormEvent } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { formatDate, VERTICAL_LABELS } from '../../lib/format';
import { Alert, Badge, Button, Card, CardHeader, Field, Input, PageHeader } from '../../components/ui';

/** The scan endpoint answers with the job bag, plus the action it performed. */
interface ScanResult {
  action: 'open' | 'advance';
  id: string;
  jobcardNo: string;
  vertical: string;
  deliveryDate: string;
  overallStatus: string;
  customer?: { name: string } | null;
  currentStage?: { stageName?: string; name?: string } | null;
  progress?: Array<{ stageName: string; status: string; isTerminal: boolean }>;
}

/** The active stage, falling back to the first stage still in progress. */
function stageName(result: ScanResult): string {
  const current = result.currentStage?.stageName ?? result.currentStage?.name;
  if (current) return current;
  const inFlight = result.progress?.find((p) => p.status === 'IN_PROGRESS');
  return inFlight?.stageName ?? (result.overallStatus === 'DONE' ? 'Completed' : '—');
}

export default function ScanPage() {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ScanResult | null>(null);

  const scan = useMutation({
    mutationFn: (action: 'open' | 'advance') => api.post<ScanResult>('/production/scan', { token: token.trim(), action }),
    onSuccess: (res) => {
      setError(null);
      setResult(res);
    },
    onError: (err) => {
      setResult(null);
      setError(err instanceof ApiError ? err.message : 'Could not read that job QR');
    },
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    scan.mutate('open');
  }

  return (
    <>
      <PageHeader
        title="Scan job QR"
        subtitle="Open a job bag from the floor, or advance its stage with one tap"
      />

      <div className="mx-auto max-w-xl space-y-4">
        <Card>
          <CardHeader title="Scan or type the token" subtitle="Tokens only resolve inside your own shop" />
          <form onSubmit={onSubmit} className="space-y-4 p-5">
            <Field label="QR token" required hint="Point a scanner at the job bag, or type the code printed under the QR">
              <Input
                value={token}
                onChange={(e) => setToken(e.target.value)}
                autoFocus
                className="font-mono"
                placeholder="paste or scan…"
              />
            </Field>
            <div className="flex gap-2">
              <Button type="submit" variant="secondary" className="flex-1" disabled={!token.trim() || scan.isPending}>
                Open job
              </Button>
              <Button
                type="button"
                className="flex-1"
                disabled={!token.trim() || scan.isPending}
                onClick={() => scan.mutate('advance')}
              >
                {scan.isPending ? 'Working…' : 'Advance stage'}
              </Button>
            </div>
          </form>
        </Card>

        {error && <Alert tone="rose" title="Scan rejected">{error}</Alert>}

        {result && (
          <Card>
            <CardHeader
              title={result.jobcardNo}
              subtitle={`${result.customer?.name ?? ''} · ${VERTICAL_LABELS[result.vertical] ?? result.vertical}`}
              actions={
                <Link to={`/jobcards/${result.id}`}>
                  <Button variant="secondary" size="sm">
                    Open job bag
                  </Button>
                </Link>
              }
            />
            <div className="space-y-3 p-5">
              {result.action === 'advance' && (
                <Alert tone="green" title={result.overallStatus === 'DONE' ? 'Job completed' : 'Stage advanced'}>
                  {result.overallStatus === 'DONE'
                    ? 'The terminal stage is complete — this job is done and has left the active board.'
                    : `Now at ${stageName(result)}, timestamped to you.`}
                </Alert>
              )}
              <dl className="space-y-2 text-[13px]">
                <div className="flex justify-between">
                  <dt className="text-slate-500">Current stage</dt>
                  <dd className="font-medium text-slate-800">{stageName(result)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Status</dt>
                  <dd>
                    <Badge tone={result.overallStatus === 'DONE' ? 'green' : 'blue'}>
                      {result.overallStatus.replace('_', ' ')}
                    </Badge>
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-slate-500">Delivery</dt>
                  <dd className="text-slate-800">{formatDate(result.deliveryDate)}</dd>
                </div>
              </dl>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}
