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

type Category = 'PAPER' | 'BOARD' | 'MEDIA' | 'INK' | 'PLATE' | 'OTHER';

interface Material {
  id: string;
  itemCode: string;
  name: string;
  category: Category;
  gsm: number | null;
  size: string | null;
  rollWidthFt: string | null;
  sellingRate: string | null;
  costRate: string | null;
  minCharge: string;
  gstPct: string | null;
  reorderLevel: string;
  active: boolean;
  uom?: { uomCode: string; symbol: string | null };
  hsnSac?: { code: string };
}

interface Uom {
  id: string;
  uomCode: string;
  name: string;
}
interface Hsn {
  id: string;
  code: string;
  type: string;
  description: string | null;
}

const CATEGORIES: Category[] = ['MEDIA', 'PAPER', 'BOARD', 'INK', 'PLATE', 'OTHER'];

const empty = {
  itemCode: '',
  name: '',
  category: 'MEDIA' as Category,
  gsm: '',
  size: '',
  rollWidthFt: '',
  uomId: '',
  hsnSacId: '',
  costRate: '',
  sellingRate: '',
  minCharge: '0',
  gstPct: '18',
  reorderLevel: '0',
};

export default function MaterialsPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Material | null>(null);
  const [form, setForm] = useState(empty);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const list = useQuery({
    queryKey: ['materials', search],
    queryFn: () => api.get<{ data: Material[]; total: number }>(`/materials${qs({ q: search, pageSize: 200 })}`),
  });
  const uoms = useQuery({ queryKey: ['uoms'], queryFn: () => api.get<{ data: Uom[] }>('/setup/uoms') });
  const hsns = useQuery({ queryKey: ['hsn-codes'], queryFn: () => api.get<{ data: Hsn[] }>('/setup/hsn-codes') });

  const save = useMutation({
    mutationFn: () => {
      const payload: Record<string, unknown> = {
        itemCode: form.itemCode.trim(),
        name: form.name.trim(),
        category: form.category,
        uomId: form.uomId || undefined,
        hsnSacId: form.hsnSacId || undefined,
        gsm: form.gsm ? Number(form.gsm) : null,
        size: form.size || null,
        rollWidthFt: form.rollWidthFt || null,
        costRate: form.costRate || null,
        sellingRate: form.sellingRate || null,
        minCharge: form.minCharge || '0',
        gstPct: form.gstPct || null,
        reorderLevel: form.reorderLevel || '0',
      };
      return editing ? api.put(`/materials/${editing.id}`, payload) : api.post('/materials', payload);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['materials'] });
      setOpen(false);
    },
    onError: (err) => {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else setError('Could not save the item');
    },
  });

  function openCreate() {
    setEditing(null);
    setForm({ ...empty, uomId: uoms.data?.data.find((u) => u.uomCode === 'SQFT')?.id ?? '' });
    setError(null);
    setFieldErrors({});
    setOpen(true);
  }

  function openEdit(m: Material) {
    setEditing(m);
    setForm({
      itemCode: m.itemCode,
      name: m.name,
      category: m.category,
      gsm: m.gsm ? String(m.gsm) : '',
      size: m.size ?? '',
      rollWidthFt: m.rollWidthFt ?? '',
      uomId: uoms.data?.data.find((u) => u.uomCode === m.uom?.uomCode)?.id ?? '',
      hsnSacId: hsns.data?.data.find((h) => h.code === m.hsnSac?.code)?.id ?? '',
      costRate: m.costRate ?? '',
      sellingRate: m.sellingRate ?? '',
      minCharge: m.minCharge,
      gstPct: m.gstPct ?? '18',
      reorderLevel: m.reorderLevel,
    });
    setError(null);
    setFieldErrors({});
    setOpen(true);
  }

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const isMedia = form.category === 'MEDIA';
  const isPaper = form.category === 'PAPER' || form.category === 'BOARD';

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    save.mutate();
  }

  return (
    <>
      <PageHeader
        title="Materials & media"
        subtitle="The price source for every estimate — a media without an active rate cannot be auto-priced"
        actions={can('inventory', 'C') && <Button onClick={openCreate}>Add item</Button>}
      />

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-5 py-3">
          <Input
            placeholder="Search item code or name…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="max-w-xs"
          />
          <span className="ml-auto text-[13px] text-slate-500">{list.data?.total ?? 0} items</span>
        </div>

        {list.isLoading ? (
          <Spinner />
        ) : (list.data?.data ?? []).length === 0 ? (
          <EmptyState
            title="No materials yet"
            hint="Add your flex, vinyl, backlit and paper stock with their per-sq-ft rates and minimum charge."
            action={can('inventory', 'C') ? <Button size="sm" onClick={openCreate}>Add item</Button> : undefined}
          />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Code</Th>
                <Th>Item</Th>
                <Th>Category</Th>
                <Th>UOM</Th>
                <Th>HSN/SAC</Th>
                <Th align="right">Cost</Th>
                <Th align="right">Selling</Th>
                <Th align="right">Min charge</Th>
                <Th align="right">GST</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {(list.data?.data ?? []).map((m) => (
                <tr key={m.id} className={m.active ? 'hover:bg-slate-50' : 'bg-slate-50/60 text-slate-400'}>
                  <Td className="font-mono text-[12px]">{m.itemCode}</Td>
                  <Td>
                    <span className="font-medium text-slate-800">{m.name}</span>
                    {m.rollWidthFt && <div className="text-[12px] text-slate-500">Roll {fmtRate(m.rollWidthFt)} ft</div>}
                    {m.gsm && <div className="text-[12px] text-slate-500">{m.gsm} GSM {m.size}</div>}
                  </Td>
                  <Td>
                    <Badge tone={m.category === 'MEDIA' ? 'violet' : 'slate'}>{m.category}</Badge>
                  </Td>
                  <Td>{m.uom?.symbol ?? m.uom?.uomCode ?? '—'}</Td>
                  <Td className="font-mono text-[12px]">{m.hsnSac?.code ?? '—'}</Td>
                  <Td align="right">{m.costRate ? fmtRate(m.costRate) : '—'}</Td>
                  <Td align="right">
                    {m.sellingRate ? (
                      <span className="font-medium text-slate-800">{fmtRate(m.sellingRate)}</span>
                    ) : (
                      <Badge tone="amber">No rate</Badge>
                    )}
                  </Td>
                  <Td align="right">{Number(m.minCharge) > 0 ? money(m.minCharge) : '—'}</Td>
                  <Td align="right">{m.gstPct ? `${fmtRate(m.gstPct)}%` : '—'}</Td>
                  <Td align="right">
                    {can('inventory', 'U') && (
                      <Button variant="ghost" size="sm" onClick={() => openEdit(m)}>
                        Edit
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
        open={open}
        onClose={() => setOpen(false)}
        wide
        title={editing ? `Edit ${editing.name}` : 'Add material / media'}
        subtitle="Selling rate and minimum charge feed the quotation pricing engine directly"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button form="material-form" type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save item'}
            </Button>
          </>
        }
      >
        <form id="material-form" onSubmit={onSubmit} className="space-y-4">
          {error && <Alert tone="rose">{error}</Alert>}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Item code" required error={fieldErrors.itemCode}>
              <Input value={form.itemCode} onChange={set('itemCode')} required className="font-mono" placeholder="FLX-STAR" />
            </Field>
            <Field label="Item name" required error={fieldErrors.name}>
              <Input value={form.name} onChange={set('name')} required placeholder="Star Flex 340 GSM" />
            </Field>

            <Field label="Category" required>
              <Select value={form.category} onChange={set('category')}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Unit of measure" required error={fieldErrors.uomId}>
              <Select value={form.uomId} onChange={set('uomId')} required>
                <option value="">Select…</option>
                {(uoms.data?.data ?? []).map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.uomCode} — {u.name}
                  </option>
                ))}
              </Select>
            </Field>

            {isMedia && (
              <Field label="Roll width (ft)" required hint="Used for roll costing" error={fieldErrors.rollWidthFt}>
                <NumberInput value={form.rollWidthFt} onChange={set('rollWidthFt')} step="0.1" min={0} required />
              </Field>
            )}
            {isPaper && (
              <>
                <Field label="GSM" required error={fieldErrors.gsm}>
                  <NumberInput value={form.gsm} onChange={set('gsm')} min={0} required />
                </Field>
                <Field label="Sheet size" required error={fieldErrors.size}>
                  <Input value={form.size} onChange={set('size')} placeholder="20x30 in" required />
                </Field>
              </>
            )}

            <Field label="HSN / SAC" required error={fieldErrors.hsnSacId}>
              <Select value={form.hsnSacId} onChange={set('hsnSacId')} required>
                <option value="">Select…</option>
                {(hsns.data?.data ?? []).map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.code} — {h.description ?? h.type}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="GST %" required>
              <NumberInput value={form.gstPct} onChange={set('gstPct')} step="0.01" min={0} max={28} />
            </Field>

            <Field label="Cost rate (₹ per UOM)" hint="What you pay">
              <NumberInput value={form.costRate} onChange={set('costRate')} step="0.0001" min={0} />
            </Field>
            <Field
              label="Selling rate (₹ per UOM)"
              hint="Leave blank to block auto-pricing until a rate is set"
              error={fieldErrors.sellingRate}
            >
              <NumberInput value={form.sellingRate} onChange={set('sellingRate')} step="0.0001" min={0} />
            </Field>

            <Field label="Minimum charge (₹)" hint="A small job is billed at least this much">
              <NumberInput value={form.minCharge} onChange={set('minCharge')} step="0.01" min={0} />
            </Field>
            <Field label="Reorder level">
              <NumberInput value={form.reorderLevel} onChange={set('reorderLevel')} step="0.01" min={0} />
            </Field>
          </div>
        </form>
      </Modal>
    </>
  );
}
