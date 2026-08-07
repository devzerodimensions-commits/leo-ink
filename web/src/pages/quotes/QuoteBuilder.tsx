import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { money, rate as fmtRate, toDateInput } from '../../lib/format';
import { STATE_OPTIONS, stateName } from '../../lib/states';
import type { Paged } from '../../lib/types';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardHeader,
  Field,
  Input,
  NumberInput,
  PageHeader,
  Select,
  Spinner,
  Textarea,
  cx,
} from '../../components/ui';

// ── Types mirroring the server's pricing contract (serializePricing) ─────────

interface PricedLine {
  lineNo: number;
  areaSqft: string | null;
  units: string;
  rate: string;
  rateSource: string;
  grossAmount: string;
  minChargeApplied: boolean;
  minChargeUplift: string;
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

interface PricingResult {
  engineVersion: string;
  isInterstate: boolean;
  lines: PricedLine[];
  subtotal: string;
  discountTotal: string;
  docDiscountAmt: string;
  taxableValue: string;
  cgst: string;
  sgst: string;
  igst: string;
  totalTax: string;
  computedTotal: string;
  roundOff: string;
  grandTotal: string;
  amountInWords: string;
  rateWiseSummary: Array<{ gstPct: string; taxableValue: string; cgst: string; sgst: string; igst: string; total: string }>;
  needsApproval: boolean;
  effectiveDiscountPct: string;
}

interface Customer {
  id: string;
  name: string;
  placeOfSupplyState: string;
  gstin: string | null;
  phone: string;
  email: string | null;
}

interface Material {
  id: string;
  itemCode: string;
  name: string;
  sellingRate: string | null;
  minCharge: string;
  gstPct: string | null;
  hsnSac?: { code: string };
  uom?: { uomCode: string };
}

interface RateCard {
  id: string;
  itemName: string;
  publishedRate: string;
  hsnSac: string | null;
  gstPct: string;
  minCharge: string;
  uom?: { uomCode: string };
}

interface Branch {
  id: string;
  branchCode: string;
  name: string;
  stateCode: string;
}

// ── Local line model ─────────────────────────────────────────────────────────

type LineKind = 'AREA' | 'QTY';

interface LineDraft {
  key: string;
  kind: LineKind;
  materialId: string;
  rateCardId: string;
  description: string;
  heightFt: string;
  widthFt: string;
  qty: string;
  rate: string;
  hsnSac: string;
  gstPct: string;
  minCharge: string;
  addOnRate: string;
  addOnFlat: string;
  discountPct: string;
  // FR-221 job-spec wizard
  substrate: string;
  gsm: string;
  colours: string;
  sides: string;
  lamination: string;
  finishing: string;
}

let seq = 0;
const newLine = (kind: LineKind = 'AREA'): LineDraft => ({
  key: `l${++seq}`,
  kind,
  materialId: '',
  rateCardId: '',
  description: '',
  heightFt: kind === 'AREA' ? '4' : '',
  widthFt: kind === 'AREA' ? '6' : '',
  qty: '1',
  rate: '',
  hsnSac: '',
  gstPct: '18',
  minCharge: '0',
  addOnRate: '0',
  addOnFlat: '0',
  discountPct: '0',
  substrate: '',
  gsm: '',
  colours: '',
  sides: '1',
  lamination: 'none',
  finishing: '',
});

const LAMINATION = [
  { value: 'none', label: 'None' },
  { value: 'gloss', label: 'Gloss' },
  { value: 'matte', label: 'Matte' },
];

export default function QuoteBuilderPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { session } = useAuth();

  const [customerId, setCustomerId] = useState(params.get('customerId') ?? '');
  const [branchId, setBranchId] = useState('');
  const [placeOfSupplyState, setPlaceOfSupplyState] = useState('');
  const [posOverridden, setPosOverridden] = useState(false);
  const [quoteDate, setQuoteDate] = useState(toDateInput(new Date()));
  const [validUntil, setValidUntil] = useState('');
  const [docDiscountAmt, setDocDiscountAmt] = useState('0');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([newLine('AREA')]);
  const [saveError, setSaveError] = useState<string | null>(null);

  const customers = useQuery({
    queryKey: ['customers', 'picker'],
    queryFn: () => api.get<Paged<Customer>>('/customers?pageSize=200&active=true'),
  });
  const materials = useQuery({
    queryKey: ['materials', 'picker'],
    queryFn: () => api.get<Paged<Material>>('/materials?pageSize=200&active=true'),
  });
  const rateCards = useQuery({
    queryKey: ['rate-cards', 'picker'],
    queryFn: () => api.get<Paged<RateCard>>('/rate-cards?pageSize=200&forPicker=true'),
  });
  const branches = useQuery({
    queryKey: ['branches'],
    queryFn: () => api.get<Paged<Branch>>('/setup/branches'),
  });

  const existing = useQuery({
    queryKey: ['quote', id],
    queryFn: () => api.get<Record<string, unknown>>(`/quotes/${id}`),
    enabled: Boolean(id),
  });

  // Default the issuing branch to the head office / first permitted branch.
  useEffect(() => {
    if (!branchId && branches.data?.data?.length) {
      setBranchId(branches.data.data[0].id);
    }
  }, [branches.data, branchId]);

  // FR-224 — place of supply defaults from the customer, overridable per quote.
  const customer = customers.data?.data.find((c) => c.id === customerId) ?? null;
  useEffect(() => {
    if (customer && !posOverridden) setPlaceOfSupplyState(customer.placeOfSupplyState);
  }, [customer, posOverridden]);

  const branch = branches.data?.data.find((b) => b.id === branchId) ?? null;
  const supplierState = branch?.stateCode ?? session?.tenant.homeStateCode ?? '';
  const isInterstate = Boolean(supplierState && placeOfSupplyState && supplierState !== placeOfSupplyState);

  // ── Live pricing (FR-222: recompute on every change, via the shared engine) ──

  const [pricing, setPricing] = useState<PricingResult | null>(null);
  const [priceError, setPriceError] = useState<string | null>(null);
  const [pricingBusy, setPricingBusy] = useState(false);
  const debounce = useRef<number | undefined>(undefined);

  const payloadLines = useMemo(
    () =>
      lines.map((l, i) => ({
        lineNo: i + 1,
        kind: l.kind,
        description: l.description || undefined,
        materialId: l.materialId || undefined,
        rateCardId: l.rateCardId || undefined,
        qty: l.qty || '0',
        heightFt: l.kind === 'AREA' ? l.heightFt || '0' : undefined,
        widthFt: l.kind === 'AREA' ? l.widthFt || '0' : undefined,
        rate: l.rate === '' ? undefined : l.rate,
        hsnSac: l.hsnSac || undefined,
        gstPct: l.gstPct || '0',
        minCharge: l.minCharge || '0',
        addOnRate: l.addOnRate || '0',
        addOnFlat: l.addOnFlat || '0',
        discountPct: l.discountPct || '0',
        spec: {
          substrate: l.substrate || undefined,
          gsm: l.gsm || undefined,
          colours: l.colours || undefined,
          sides: l.sides || undefined,
          lamination: l.lamination === 'none' ? undefined : l.lamination,
          finishing: l.finishing ? l.finishing.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        },
      })),
    [lines],
  );

  useEffect(() => {
    if (!placeOfSupplyState || !branchId) return;
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(async () => {
      setPricingBusy(true);
      try {
        const res = await api.post<PricingResult>('/quotes/price', {
          customerId: customerId || undefined,
          branchId,
          placeOfSupplyState,
          docDiscountAmt: docDiscountAmt || '0',
          lines: payloadLines,
        });
        setPricing(res);
        setPriceError(null);
      } catch (err) {
        setPricing(null);
        setPriceError(err instanceof ApiError ? err.message : 'Could not price this quote');
      } finally {
        setPricingBusy(false);
      }
    }, 350);
    return () => window.clearTimeout(debounce.current);
  }, [payloadLines, placeOfSupplyState, branchId, customerId, docDiscountAmt]);

  // ── Line helpers ────────────────────────────────────────────────────────────

  function updateLine(key: string, patch: Partial<LineDraft>) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  }

  function pickMaterial(key: string, materialId: string) {
    const m = materials.data?.data.find((x) => x.id === materialId);
    updateLine(key, {
      materialId,
      rateCardId: '',
      // FR-212 — the master supplies rate, HSN/SAC, GST and minimum charge; all overridable.
      rate: m?.sellingRate ?? '',
      hsnSac: m?.hsnSac?.code ?? '',
      gstPct: m?.gstPct ?? '18',
      minCharge: m?.minCharge ?? '0',
      substrate: m?.name ?? '',
      description: '',
    });
  }

  function pickRateCard(key: string, rateCardId: string) {
    const rc = rateCards.data?.data.find((x) => x.id === rateCardId);
    updateLine(key, {
      rateCardId,
      materialId: '',
      rate: rc?.publishedRate ?? '',
      hsnSac: rc?.hsnSac ?? '',
      gstPct: rc?.gstPct ?? '18',
      minCharge: rc?.minCharge ?? '0',
      description: rc?.itemName ?? '',
      kind: rc?.uom?.uomCode === 'SQFT' ? 'AREA' : 'QTY',
    });
  }

  // ── Persist ─────────────────────────────────────────────────────────────────

  const body = () => ({
    customerId,
    branchId,
    placeOfSupplyState,
    quoteDate,
    validUntil: validUntil || undefined,
    docDiscountAmt: docDiscountAmt || '0',
    notes: notes || undefined,
    lines: payloadLines,
  });

  const saveDraft = useMutation({
    mutationFn: () =>
      id ? api.put<{ id: string }>(`/quotes/${id}`, body()) : api.post<{ id: string }>('/quotes', body()),
    onSuccess: (saved) => navigate(`/quotes/${saved.id}`),
    onError: (err) => setSaveError(err instanceof ApiError ? err.message : 'Could not save the quotation'),
  });

  const canSave = Boolean(customerId && branchId && placeOfSupplyState && pricing && !priceError);

  if (id && existing.isLoading) return <Spinner label="Loading quotation…" />;

  return (
    <>
      <PageHeader
        title={id ? 'Edit quotation' : 'New quotation'}
        subtitle="Every figure below is computed by the shared pricing engine — the invoice will match to the paise"
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate('/quotes')}>
              Cancel
            </Button>
            <Button onClick={() => saveDraft.mutate()} disabled={!canSave || saveDraft.isPending}>
              {saveDraft.isPending ? 'Saving…' : 'Save draft'}
            </Button>
          </>
        }
      />

      {saveError && (
        <div className="mb-4">
          <Alert tone="rose">{saveError}</Alert>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[1fr_360px]">
        <div className="space-y-5">
          {/* Header */}
          <Card>
            <CardHeader title="Customer & supply" subtitle="Place of supply decides CGST+SGST vs IGST" />
            <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Customer" required className="sm:col-span-2">
                <Select value={customerId} onChange={(e) => { setCustomerId(e.target.value); setPosOverridden(false); }}>
                  <option value="">Select a customer…</option>
                  {(customers.data?.data ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                      {c.gstin ? ` — ${c.gstin}` : ' — unregistered'}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Issuing branch" required>
                <Select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
                  {(branches.data?.data ?? []).map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.branchCode} — {b.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field
                label="Place of supply"
                required
                hint={posOverridden ? 'Overridden for this quote' : 'From the customer master'}
              >
                <Select
                  value={placeOfSupplyState}
                  onChange={(e) => {
                    setPlaceOfSupplyState(e.target.value);
                    setPosOverridden(true);
                  }}
                >
                  <option value="">Select…</option>
                  {STATE_OPTIONS.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.code} — {s.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Quote date" required>
                <Input type="date" value={quoteDate} onChange={(e) => setQuoteDate(e.target.value)} />
              </Field>
              <Field label="Valid until" hint={`Defaults to ${session ? '15' : ''} days from today`}>
                <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
              </Field>

              <div className="sm:col-span-2 lg:col-span-2 flex items-end">
                {placeOfSupplyState && supplierState && (
                  <div className="w-full rounded-lg bg-slate-50 px-3 py-2 ring-1 ring-inset ring-slate-200">
                    <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">GST treatment</p>
                    <p className="mt-0.5 text-sm text-slate-800">
                      {isInterstate ? (
                        <>
                          <Badge tone="violet">Inter-state</Badge>{' '}
                          <span className="text-[13px]">
                            IGST — {stateName(supplierState)} → {stateName(placeOfSupplyState)}
                          </span>
                        </>
                      ) : (
                        <>
                          <Badge tone="green">Intra-state</Badge>{' '}
                          <span className="text-[13px]">CGST + SGST within {stateName(supplierState)}</span>
                        </>
                      )}
                    </p>
                  </div>
                )}
              </div>
            </div>
          </Card>

          {/* Lines */}
          <Card>
            <CardHeader
              title="Job lines"
              subtitle="Flex lines price as height × width × rate/sq.ft; piece lines price per unit"
              actions={
                <>
                  <Button variant="secondary" size="sm" onClick={() => setLines((l) => [...l, newLine('AREA')])}>
                    + Flex line
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setLines((l) => [...l, newLine('QTY')])}>
                    + Piece line
                  </Button>
                </>
              }
            />

            <div className="space-y-4 p-5">
              {lines.map((line, idx) => {
                const priced = pricing?.lines.find((p) => p.lineNo === idx + 1);
                return (
                  <div key={line.key} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="grid size-6 place-items-center rounded-md bg-slate-200 text-[11px] font-semibold text-slate-600">
                          {idx + 1}
                        </span>
                        <Badge tone={line.kind === 'AREA' ? 'violet' : 'blue'}>
                          {line.kind === 'AREA' ? 'Square-foot' : 'Per piece'}
                        </Badge>
                        {priced?.minChargeApplied && (
                          <Badge tone="amber">Minimum charge applied (+{money(priced.minChargeUplift)})</Badge>
                        )}
                        {priced && priced.rateSource !== 'LINE_OVERRIDE' && (
                          <Badge tone="slate">rate from {priced.rateSource === 'MATERIAL_MASTER' ? 'material master' : 'rate card'}</Badge>
                        )}
                      </div>
                      {lines.length > 1 && (
                        <Button variant="ghost" size="sm" onClick={() => setLines((ls) => ls.filter((l) => l.key !== line.key))}>
                          Remove
                        </Button>
                      )}
                    </div>

                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                      <Field label="Media / material" className="lg:col-span-2">
                        <Select value={line.materialId} onChange={(e) => pickMaterial(line.key, e.target.value)}>
                          <option value="">— pick a media —</option>
                          {(materials.data?.data ?? []).map((m) => (
                            <option key={m.id} value={m.id}>
                              {m.name}
                              {m.sellingRate ? ` — ₹${fmtRate(m.sellingRate)}/${m.uom?.uomCode ?? ''}` : ' — no rate set'}
                            </option>
                          ))}
                        </Select>
                      </Field>

                      <Field label="…or a rate-card item" className="lg:col-span-2">
                        <Select value={line.rateCardId} onChange={(e) => pickRateCard(line.key, e.target.value)}>
                          <option value="">— pick from price list —</option>
                          {(rateCards.data?.data ?? []).map((rc) => (
                            <option key={rc.id} value={rc.id}>
                              {rc.itemName} — ₹{fmtRate(rc.publishedRate)}
                            </option>
                          ))}
                        </Select>
                      </Field>

                      {line.kind === 'AREA' ? (
                        <>
                          <Field label="Height (ft)" required>
                            <NumberInput
                              value={line.heightFt}
                              onChange={(e) => updateLine(line.key, { heightFt: e.target.value })}
                              step="0.01"
                              min={0}
                            />
                          </Field>
                          <Field label="Width (ft)" required>
                            <NumberInput
                              value={line.widthFt}
                              onChange={(e) => updateLine(line.key, { widthFt: e.target.value })}
                              step="0.01"
                              min={0}
                            />
                          </Field>
                          <Field label="Quantity" required>
                            <NumberInput
                              value={line.qty}
                              onChange={(e) => updateLine(line.key, { qty: e.target.value })}
                              step="1"
                              min={0}
                            />
                          </Field>
                          <Field label="Area" hint="height × width">
                            <div className="flex h-[38px] items-center rounded-lg bg-white px-3 text-sm tnum ring-1 ring-inset ring-slate-200">
                              {priced?.areaSqft ? `${fmtRate(priced.areaSqft)} sq.ft` : '—'}
                            </div>
                          </Field>
                        </>
                      ) : (
                        <Field label="Quantity" required>
                          <NumberInput
                            value={line.qty}
                            onChange={(e) => updateLine(line.key, { qty: e.target.value })}
                            step="1"
                            min={0}
                          />
                        </Field>
                      )}

                      <Field label="Rate (₹ per unit)" required hint="Overrides the master rate">
                        <NumberInput
                          value={line.rate}
                          onChange={(e) => updateLine(line.key, { rate: e.target.value })}
                          step="0.0001"
                          min={0}
                        />
                      </Field>
                      <Field label="HSN / SAC">
                        <Input
                          value={line.hsnSac}
                          onChange={(e) => updateLine(line.key, { hsnSac: e.target.value })}
                          className="font-mono"
                        />
                      </Field>
                      <Field label="GST %">
                        <NumberInput
                          value={line.gstPct}
                          onChange={(e) => updateLine(line.key, { gstPct: e.target.value })}
                          step="0.01"
                          min={0}
                          max={28}
                        />
                      </Field>
                      <Field label="Line discount %">
                        <NumberInput
                          value={line.discountPct}
                          onChange={(e) => updateLine(line.key, { discountPct: e.target.value })}
                          step="0.01"
                          min={0}
                          max={100}
                        />
                      </Field>
                    </div>

                    {/* FR-221 job-spec wizard */}
                    <details className="mt-3 rounded-lg bg-white p-3 ring-1 ring-inset ring-slate-200">
                      <summary className="cursor-pointer text-[13px] font-medium text-slate-700">
                        Job specification & finishing
                      </summary>
                      <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                        <Field label="Substrate">
                          <Input value={line.substrate} onChange={(e) => updateLine(line.key, { substrate: e.target.value })} />
                        </Field>
                        <Field label="GSM">
                          <Input value={line.gsm} onChange={(e) => updateLine(line.key, { gsm: e.target.value })} />
                        </Field>
                        <Field label="Colours" hint="4/0, 4/4, spot…">
                          <Input value={line.colours} onChange={(e) => updateLine(line.key, { colours: e.target.value })} />
                        </Field>
                        <Field label="Sides">
                          <Select value={line.sides} onChange={(e) => updateLine(line.key, { sides: e.target.value })}>
                            <option value="1">Single</option>
                            <option value="2">Double</option>
                          </Select>
                        </Field>
                        <Field label="Lamination">
                          <Select value={line.lamination} onChange={(e) => updateLine(line.key, { lamination: e.target.value })}>
                            {LAMINATION.map((l) => (
                              <option key={l.value} value={l.value}>
                                {l.label}
                              </option>
                            ))}
                          </Select>
                        </Field>
                        <Field label="Lamination rate (₹/unit)" hint="Added to the line rate">
                          <NumberInput
                            value={line.addOnRate}
                            onChange={(e) => updateLine(line.key, { addOnRate: e.target.value })}
                            step="0.01"
                            min={0}
                          />
                        </Field>
                        <Field label="Finishing" hint="eyelets, hemming, mounting — comma separated">
                          <Input value={line.finishing} onChange={(e) => updateLine(line.key, { finishing: e.target.value })} />
                        </Field>
                        <Field label="Finishing charge (₹ flat)">
                          <NumberInput
                            value={line.addOnFlat}
                            onChange={(e) => updateLine(line.key, { addOnFlat: e.target.value })}
                            step="0.01"
                            min={0}
                          />
                        </Field>
                        <Field label="Description on the quote" className="sm:col-span-2 lg:col-span-4">
                          <Input
                            value={line.description}
                            onChange={(e) => updateLine(line.key, { description: e.target.value })}
                            placeholder="Auto-generated from the spec if left blank"
                          />
                        </Field>
                      </div>
                    </details>

                    {priced && (
                      <div className="mt-3 flex flex-wrap items-center justify-end gap-x-6 gap-y-1 border-t border-slate-200 pt-3 text-[13px]">
                        <span className="text-slate-500">
                          Gross <span className="tnum font-medium text-slate-800">{money(priced.grossAmount)}</span>
                        </span>
                        {Number(priced.discountAmt) > 0 && (
                          <span className="text-slate-500">
                            Discount <span className="tnum font-medium text-rose-600">−{money(priced.discountAmt)}</span>
                          </span>
                        )}
                        <span className="text-slate-500">
                          Taxable <span className="tnum font-medium text-slate-800">{money(priced.lineTaxable)}</span>
                        </span>
                        <span className="text-slate-500">
                          GST {fmtRate(priced.gstPct)}% <span className="tnum font-medium text-slate-800">{money(priced.lineTax)}</span>
                        </span>
                        <span className="font-semibold text-slate-900">
                          Total <span className="tnum">{money(priced.lineTotal)}</span>
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Card>

          <Card>
            <CardHeader title="Notes & terms" />
            <div className="p-5">
              <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Delivery in 3 working days. Artwork approval required before print." />
            </div>
          </Card>
        </div>

        {/* Totals rail */}
        <div className="space-y-4 xl:sticky xl:top-20 xl:self-start">
          <Card>
            <CardHeader
              title="Totals"
              subtitle={pricing ? `engine v${pricing.engineVersion}` : undefined}
              actions={pricingBusy ? <span className="text-[12px] text-slate-400">pricing…</span> : undefined}
            />

            {priceError ? (
              <div className="p-5">
                <Alert tone="rose" title="Cannot price this quote">
                  {priceError}
                </Alert>
              </div>
            ) : !pricing ? (
              <Spinner label="Waiting for a customer and a line…" />
            ) : (
              <div className="p-5">
                <dl className="space-y-2 text-[13px]">
                  <Row label="Subtotal" value={money(pricing.subtotal)} />
                  {Number(pricing.discountTotal) > 0 && (
                    <Row label="Discount" value={`−${money(pricing.discountTotal)}`} tone="rose" />
                  )}
                  <Row label="Taxable value" value={money(pricing.taxableValue)} strong />
                  {pricing.isInterstate ? (
                    <Row label="IGST" value={money(pricing.igst)} />
                  ) : (
                    <>
                      <Row label="CGST" value={money(pricing.cgst)} />
                      <Row label="SGST" value={money(pricing.sgst)} />
                    </>
                  )}
                  {Number(pricing.roundOff) !== 0 && (
                    <Row label="Round off" value={`${Number(pricing.roundOff) > 0 ? '+' : ''}${money(pricing.roundOff)}`} />
                  )}
                </dl>

                <div className="mt-4 border-t border-slate-200 pt-3">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm font-semibold text-slate-700">Grand total</span>
                    <span className="tnum text-xl font-semibold text-slate-900">{money(pricing.grandTotal)}</span>
                  </div>
                  <p className="mt-2 text-[12px] italic leading-relaxed text-slate-500">{pricing.amountInWords}</p>
                </div>

                {pricing.needsApproval && (
                  <div className="mt-4">
                    <Alert tone="amber" title="Needs approval">
                      Discount of {fmtRate(pricing.effectiveDiscountPct)}% exceeds the shop's threshold.
                    </Alert>
                  </div>
                )}
              </div>
            )}
          </Card>

          <Card>
            <CardHeader title="Document discount" />
            <div className="p-5">
              <Field label="Discount on the whole quote (₹)" hint="Apportioned across lines so each GST rate stays correct">
                <NumberInput value={docDiscountAmt} onChange={(e) => setDocDiscountAmt(e.target.value)} step="0.01" min={0} />
              </Field>
            </div>
          </Card>

          {pricing && pricing.rateWiseSummary.length > 0 && (
            <Card>
              <CardHeader title="Rate-wise GST summary" />
              <div className="p-5">
                <table className="w-full text-[13px]">
                  <thead>
                    <tr className="text-[11px] uppercase tracking-wide text-slate-500">
                      <th className="pb-2 text-left">Rate</th>
                      <th className="pb-2 text-right">Taxable</th>
                      <th className="pb-2 text-right">Tax</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pricing.rateWiseSummary.map((b) => (
                      <tr key={b.gstPct} className="border-t border-slate-100">
                        <td className="py-1.5">{fmtRate(b.gstPct)}%</td>
                        <td className="py-1.5 text-right tnum">{money(b.taxableValue)}</td>
                        <td className="py-1.5 text-right tnum">
                          {money(Number(b.cgst) + Number(b.sgst) + Number(b.igst))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function Row({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: 'rose' }) {
  return (
    <div className="flex items-center justify-between">
      <dt className={cx('text-slate-500', strong && 'font-medium text-slate-700')}>{label}</dt>
      <dd className={cx('tnum', strong ? 'font-semibold text-slate-900' : 'text-slate-700', tone === 'rose' && 'text-rose-600')}>
        {value}
      </dd>
    </div>
  );
}
