import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { money, rate as fmtRate } from '../../lib/format';
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
  Th,
} from '../../components/ui';

interface RateCard {
  id: string;
  itemName: string;
  publishedRate: string;
  hsnSac: string | null;
  gstPct: string;
  minCharge: string;
  active: boolean;
  uom?: { uomCode: string; name: string };
}

interface Uom {
  id: string;
  uomCode: string;
  name: string;
}

const empty = { itemName: '', uomId: '', publishedRate: '', hsnSac: '', gstPct: '18', minCharge: '0' };

export default function RateCardsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<RateCard | null>(null);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ['rate-cards', search],
    queryFn: () => api.get<{ data: RateCard[]; total: number }>(`/rate-cards${qs({ q: search, active: 'all', pageSize: 200 })}`),
  });
  const uoms = useQuery({ queryKey: ['uoms'], queryFn: () => api.get<{ data: Uom[] }>('/setup/uoms') });

  const save = useMutation({
    mutationFn: () => {
      const payload = { ...form, hsnSac: form.hsnSac || null };
      return editing ? api.put(`/rate-cards/${editing.id}`, payload) : api.post('/rate-cards', payload);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['rate-cards'] });
      setOpen(false);
    },
    onError: (err) => setError(err instanceof ApiError ? err.message : 'Could not save the rate card'),
  });

  const toggle = useMutation({
    mutationFn: (rc: RateCard) => api.put(`/rate-cards/${rc.id}`, { active: !rc.active }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['rate-cards'] }),
  });

  function openCreate() {
    setEditing(null);
    setForm({ ...empty, uomId: uoms.data?.data.find((u) => u.uomCode === 'SQFT')?.id ?? '' });
    setError(null);
    setOpen(true);
  }

  function openEdit(rc: RateCard) {
    setEditing(rc);
    setForm({
      itemName: rc.itemName,
      uomId: uoms.data?.data.find((u) => u.uomCode === rc.uom?.uomCode)?.id ?? '',
      publishedRate: rc.publishedRate,
      hsnSac: rc.hsnSac ?? '',
      gstPct: rc.gstPct,
      minCharge: rc.minCharge,
    });
    setError(null);
    setOpen(true);
  }

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    save.mutate();
  }

  return (
    <>
      <PageHeader
        title="Rate cards"
        subtitle="Your published price list — quote a common job in one click, still priced by the shared engine"
        actions={can('inventory', 'C') && <Button onClick={openCreate}>Add rate</Button>}
      />

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3">
          <Input placeholder="Search item…" value={search} onChange={(e) => setSearch(e.target.value)} className="max-w-xs" />
          <span className="ml-auto text-[13px] text-slate-500">{list.data?.total ?? 0} items</span>
        </div>

        {list.isLoading ? (
          <Spinner />
        ) : (list.data?.data ?? []).length === 0 ? (
          <EmptyState
            title="No published rates yet"
            hint="Add the jobs you quote every day — flex per sq.ft, visiting cards per 100, A4 colour print per sheet."
            action={can('inventory', 'C') ? <Button size="sm" onClick={openCreate}>Add rate</Button> : undefined}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Item</Th>
                <Th>UOM</Th>
                <Th>HSN/SAC</Th>
                <Th align="right">Published rate</Th>
                <Th align="right">Min charge</Th>
                <Th align="right">GST</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {(list.data?.data ?? []).map((rc) => (
                <tr key={rc.id} className={rc.active ? 'hover:bg-slate-50' : 'bg-slate-50/60 text-slate-400'}>
                  <Td>
                    <span className="font-medium text-slate-800">{rc.itemName}</span>
                    {!rc.active && (
                      <Badge tone="slate" className="ml-2">
                        Inactive
                      </Badge>
                    )}
                  </Td>
                  <Td>{rc.uom?.uomCode ?? '—'}</Td>
                  <Td className="font-mono text-[12px]">{rc.hsnSac ?? '—'}</Td>
                  <Td align="right" className="font-medium text-slate-900">
                    ₹{fmtRate(rc.publishedRate)}
                  </Td>
                  <Td align="right">{Number(rc.minCharge) > 0 ? money(rc.minCharge) : '—'}</Td>
                  <Td align="right">{fmtRate(rc.gstPct)}%</Td>
                  <Td align="right">
                    {can('inventory', 'U') && (
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" size="sm" onClick={() => openEdit(rc)}>
                          Edit
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => toggle.mutate(rc)}>
                          {rc.active ? 'Deactivate' : 'Activate'}
                        </Button>
                      </div>
                    )}
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
        title={editing ? `Edit ${editing.itemName}` : 'Add published rate'}
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button form="rc-form" type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <form id="rc-form" onSubmit={onSubmit} className="space-y-4">
          {error && <Alert tone="rose">{error}</Alert>}

          <Field label="Item name" required>
            <Input value={form.itemName} onChange={set('itemName')} required autoFocus placeholder="Flex Banner Printing (Star Flex)" />
          </Field>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Unit of measure" required>
              <Select value={form.uomId} onChange={set('uomId')} required>
                <option value="">Select…</option>
                {(uoms.data?.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.uomCode} — {u.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Published rate (₹)" required>
              <NumberInput value={form.publishedRate} onChange={set('publishedRate')} step="0.0001" min={0} required />
            </Field>
            <Field label="HSN / SAC">
              <Input value={form.hsnSac} onChange={set('hsnSac')} className="font-mono" placeholder="998912" />
            </Field>
            <Field label="GST %" required>
              <NumberInput value={form.gstPct} onChange={set('gstPct')} step="0.01" min={0} max={28} required />
            </Field>
            <Field label="Minimum charge (₹)">
              <NumberInput value={form.minCharge} onChange={set('minCharge')} step="0.01" min={0} />
            </Field>
          </div>
        </form>
      </Modal>
    </>
  );
}
