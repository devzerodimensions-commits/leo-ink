/**
 * Demo tenant — a realistic Pune flex/digital shop, enough to walk the whole
 * §2.6 happy path (enquiry → quotation → jobcard → production board) on real data.
 *
 *   npm run seed --workspace server
 */
import { PrismaClient, type DocType, type Vertical } from '@prisma/client';
import bcrypt from 'bcryptjs';
import { buildGstin } from '../src/lib/gstin.js';
import { fyRangeForDate } from '../src/lib/fy.js';
import { DEFAULT_SERIES } from '../src/lib/numbering.js';

const prisma = new PrismaClient();

const MAHARASHTRA = '27';
const KARNATAKA = '29';
const GUJARAT = '24';

const TAX_SLABS = [
  { name: 'GST 0%', gstPct: '0' },
  { name: 'GST 5%', gstPct: '5' },
  { name: 'GST 12%', gstPct: '12' },
  { name: 'GST 18%', gstPct: '18' },
  { name: 'GST 28%', gstPct: '28' },
];

/** FR-110 — standard print UOMs, pre-seeded. */
const UOMS = [
  { uomCode: 'SQFT', name: 'Square foot', symbol: 'sq.ft' },
  { uomCode: 'NOS', name: 'Numbers', symbol: 'nos' },
  { uomCode: 'PIECE', name: 'Piece', symbol: 'pc' },
  { uomCode: 'SHEET', name: 'Sheet', symbol: 'sheet' },
  { uomCode: 'KG', name: 'Kilogram', symbol: 'kg' },
  { uomCode: 'ROLL', name: 'Roll', symbol: 'roll' },
  { uomCode: 'METRE', name: 'Metre', symbol: 'm' },
  { uomCode: 'REAM', name: 'Ream', symbol: 'ream', baseUomCode: 'SHEET', factorToBase: '500' },
];

/** FR-306 — "a sensible default template is seeded per vertical on tenant setup." */
export const DEFAULT_WORKFLOWS: Record<Vertical, Array<{ name: string; department: string; isTerminal?: boolean }>> = {
  FLEX_LARGE_FORMAT: [
    { name: 'Design', department: 'Design' },
    { name: 'Print', department: 'Machine' },
    { name: 'Finishing', department: 'Finishing' },
    { name: 'QC', department: 'QC' },
    { name: 'Dispatch', department: 'Dispatch', isTerminal: true },
  ],
  OFFSET: [
    { name: 'Design', department: 'Design' },
    { name: 'Prepress', department: 'Prepress' },
    { name: 'Plate Making', department: 'Prepress' },
    { name: 'Print', department: 'Machine' },
    { name: 'Finishing', department: 'Finishing' },
    { name: 'QC', department: 'QC' },
    { name: 'Packing', department: 'Dispatch' },
    { name: 'Dispatch', department: 'Dispatch', isTerminal: true },
  ],
  DIGITAL: [
    { name: 'Design', department: 'Design' },
    { name: 'Print', department: 'Machine' },
    { name: 'Finishing', department: 'Finishing' },
    { name: 'QC', department: 'QC' },
    { name: 'Dispatch', department: 'Dispatch', isTerminal: true },
  ],
  SCREEN: [
    { name: 'Design', department: 'Design' },
    { name: 'Screen Making', department: 'Prepress' },
    { name: 'Print', department: 'Machine' },
    { name: 'Finishing', department: 'Finishing' },
    { name: 'QC', department: 'QC' },
    { name: 'Dispatch', department: 'Dispatch', isTerminal: true },
  ],
};

async function main() {
  const tenantGstin = buildGstin(MAHARASHTRA, 'AABCS1429B');

  // Wipe the demo tenant so the seed is re-runnable.
  await prisma.tenant.deleteMany({ where: { gstin: tenantGstin } });

  const plan = await prisma.plan.upsert({
    where: { code: 'GROWTH' },
    update: {},
    create: {
      code: 'GROWTH',
      name: 'Growth',
      maxUsers: 10,
      maxBranches: 3,
      features: ['quotation', 'jobcard', 'production', 'inventory', 'invoice'],
      pricePerYear: '11800.00',
    },
  });
  await prisma.plan.upsert({
    where: { code: 'STARTER' },
    update: {},
    create: {
      code: 'STARTER',
      name: 'Starter',
      maxUsers: 3,
      maxBranches: 1,
      features: ['quotation', 'jobcard', 'invoice'],
      pricePerYear: '5900.00',
    },
  });

  const tenant = await prisma.tenant.create({
    data: {
      legalName: 'Shree Ganesh Printers',
      tradeName: 'Shree Ganesh Flex & Digital',
      constitution: 'Proprietorship',
      gstin: tenantGstin,
      pan: 'AABCS1429B',
      homeStateCode: MAHARASHTRA,
      addressLine1: 'Shop 14, Laxmi Complex',
      addressLine2: 'Shivajinagar',
      city: 'Pune',
      stateCode: MAHARASHTRA,
      pincode: '411005',
      email: 'accounts@shreeganeshprinters.in',
      phone: '02025512345',
      status: 'LIVE',
      goLiveReady: true,
      defaultMarkupPct: '25',
      quoteValidityDays: 15,
      maxDiscountPct: '15',
      defaultVertical: 'FLEX_LARGE_FORMAT',
    },
  });

  await prisma.subscription.create({
    data: {
      tenantId: tenant.id,
      planId: plan.id,
      status: 'TRIAL',
      seats: 10,
      trialEndsAt: new Date(Date.now() + 14 * 86_400_000),
    },
  });

  const branch = await prisma.branch.create({
    data: {
      tenantId: tenant.id,
      branchCode: 'HO',
      name: 'Shivajinagar (Head Office)',
      gstin: tenantGstin,
      stateCode: MAHARASHTRA,
      addressLine1: 'Shop 14, Laxmi Complex, Shivajinagar',
      city: 'Pune',
      pincode: '411005',
      phone: '02025512345',
      isHeadOffice: true,
    },
  });

  await prisma.bankAccount.create({
    data: {
      tenantId: tenant.id,
      accountName: 'Shree Ganesh Printers',
      accountNo: '50100234567890',
      ifsc: 'HDFC0000123',
      bankName: 'HDFC Bank',
      branchName: 'Shivajinagar, Pune',
      upiVpa: 'shreeganesh@hdfcbank',
      isDefault: true,
    },
  });

  // FR-104 — current FY from the system date.
  const { startDate, endDate, fyLabel } = fyRangeForDate(new Date());
  const fy = await prisma.financialYear.create({
    data: { tenantId: tenant.id, fyLabel, startDate, endDate, status: 'OPEN', isCurrent: true },
  });

  // FR-100 / FR-106 — pre-seeded numbering series.
  await prisma.numberingSeries.createMany({
    data: DEFAULT_SERIES.map((s) => ({
      tenantId: tenant.id,
      docType: s.docType as DocType,
      branchId: branch.id,
      fyId: fy.id,
      prefix: s.prefix,
      padding: s.padding,
      startNumber: 1,
      nextNumber: 1,
      resetPolicy: 'YEARLY' as const,
    })),
  });

  await prisma.roundingRule.create({
    data: { tenantId: tenant.id, scope: null, mode: 'NORMAL', precision: 0 },
  });

  // FR-108 — standard slabs.
  const taxRates: Record<string, string> = {};
  for (const slab of TAX_SLABS) {
    const r = await prisma.taxRate.create({
      data: { tenantId: tenant.id, name: slab.name, gstPct: slab.gstPct, effectiveFrom: startDate },
    });
    taxRates[slab.gstPct] = r.id;
  }

  // FR-110 — UOMs (base units first so REAM can point at SHEET).
  const uoms: Record<string, string> = {};
  for (const u of UOMS.filter((x) => !x.baseUomCode)) {
    const rec = await prisma.unitOfMeasure.create({
      data: { tenantId: tenant.id, uomCode: u.uomCode, name: u.name, symbol: u.symbol },
    });
    uoms[u.uomCode] = rec.id;
  }
  for (const u of UOMS.filter((x) => x.baseUomCode)) {
    const rec = await prisma.unitOfMeasure.create({
      data: {
        tenantId: tenant.id,
        uomCode: u.uomCode,
        name: u.name,
        symbol: u.symbol,
        baseUomId: uoms[u.baseUomCode!],
        factorToBase: u.factorToBase!,
      },
    });
    uoms[u.uomCode] = rec.id;
  }

  // FR-109 — printing services sit at SAC 998912 / 18%; printed matter at HSN 4911 / 12%.
  const sacPrinting = await prisma.hsnSacCode.create({
    data: {
      tenantId: tenant.id,
      code: '998912',
      type: 'SAC',
      description: 'Printing and reproduction services of recorded media',
      defaultTaxRateId: taxRates['18'],
      defaultUomId: uoms.SQFT,
    },
  });
  const hsnPrinted = await prisma.hsnSacCode.create({
    data: {
      tenantId: tenant.id,
      code: '4911',
      type: 'HSN',
      description: 'Other printed matter, including printed pictures and photographs',
      defaultTaxRateId: taxRates['12'],
      defaultUomId: uoms.NOS,
    },
  });
  const hsnAdhesive = await prisma.hsnSacCode.create({
    data: {
      tenantId: tenant.id,
      code: '39199090',
      type: 'HSN',
      description: 'Self-adhesive plates, sheets, film of plastics',
      defaultTaxRateId: taxRates['18'],
      defaultUomId: uoms.SQFT,
    },
  });

  // FR-116 / FR-212 — the media master is the price source for every flex estimate.
  const media = [
    { itemCode: 'FLX-STAR', name: 'Star Flex 340 GSM', rollWidthFt: '10', costRate: '11.0000', sellingRate: '18.0000', minCharge: '250.00' },
    { itemCode: 'FLX-BACKLIT', name: 'Backlit Flex 510 GSM', rollWidthFt: '8', costRate: '19.0000', sellingRate: '32.0000', minCharge: '350.00' },
    { itemCode: 'VNL-GLOSS', name: 'Vinyl Gloss (self-adhesive)', rollWidthFt: '5', costRate: '22.0000', sellingRate: '38.0000', minCharge: '300.00' },
    { itemCode: 'VNL-OWV', name: 'One Way Vision', rollWidthFt: '4.5', costRate: '28.0000', sellingRate: '48.0000', minCharge: '400.00' },
    { itemCode: 'CNV-MATT', name: 'Canvas Matte', rollWidthFt: '4', costRate: '45.0000', sellingRate: '75.0000', minCharge: '500.00' },
    { itemCode: 'FAB-CLOTH', name: 'Cloth Banner Fabric', rollWidthFt: '6', costRate: '26.0000', sellingRate: '44.0000', minCharge: '350.00' },
  ];
  for (const m of media) {
    await prisma.materialItem.create({
      data: {
        tenantId: tenant.id,
        itemCode: m.itemCode,
        name: m.name,
        category: 'MEDIA',
        rollWidthFt: m.rollWidthFt,
        uomId: uoms.SQFT,
        hsnSacId: sacPrinting.id,
        costRate: m.costRate,
        sellingRate: m.sellingRate,
        minCharge: m.minCharge,
        gstPct: '18',
        reorderLevel: '200',
      },
    });
  }

  // A paper item to exercise the goods-vs-service mixed invoice (FR-506).
  await prisma.materialItem.create({
    data: {
      tenantId: tenant.id,
      itemCode: 'PPR-ART-300',
      name: 'Art Card 300 GSM (20×30 in)',
      category: 'PAPER',
      gsm: 300,
      size: '20x30 in',
      uomId: uoms.SHEET,
      hsnSacId: hsnPrinted.id,
      costRate: '9.5000',
      sellingRate: '15.0000',
      gstPct: '12',
      reorderLevel: '1000',
    },
  });

  // A deliberately rate-less item so FR-212's "cannot be auto-priced" path is demonstrable.
  await prisma.materialItem.create({
    data: {
      tenantId: tenant.id,
      itemCode: 'VNL-REFLECT',
      name: 'Reflective Vinyl (rate pending)',
      category: 'MEDIA',
      rollWidthFt: '4',
      uomId: uoms.SQFT,
      hsnSacId: hsnAdhesive.id,
      sellingRate: null,
      gstPct: '18',
    },
  });

  // FR-216 — published price list for instant counter quoting.
  const rateCards = [
    { itemName: 'Flex Banner Printing (Star Flex)', uom: 'SQFT', publishedRate: '18.0000', hsnSac: '998912', gstPct: '18', minCharge: '250.00' },
    { itemName: 'Backlit Board Printing', uom: 'SQFT', publishedRate: '32.0000', hsnSac: '998912', gstPct: '18', minCharge: '350.00' },
    { itemName: 'Visiting Cards (per 100)', uom: 'NOS', publishedRate: '250.0000', hsnSac: '4911', gstPct: '12', minCharge: '250.00' },
    { itemName: 'A4 Colour Print (single side)', uom: 'NOS', publishedRate: '10.0000', hsnSac: '998912', gstPct: '18', minCharge: '0.00' },
    { itemName: 'Lamination — Gloss', uom: 'SQFT', publishedRate: '6.0000', hsnSac: '998912', gstPct: '18', minCharge: '0.00' },
    { itemName: 'Eyelet fitting', uom: 'NOS', publishedRate: '5.0000', hsnSac: '998912', gstPct: '18', minCharge: '0.00' },
  ];
  for (const rc of rateCards) {
    await prisma.rateCard.create({
      data: {
        tenantId: tenant.id,
        itemName: rc.itemName,
        uomId: uoms[rc.uom],
        publishedRate: rc.publishedRate,
        hsnSac: rc.hsnSac,
        gstPct: rc.gstPct,
        minCharge: rc.minCharge,
      },
    });
  }

  // FR-113 — customers spanning intra-state, inter-state and unregistered (B2C).
  await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      name: 'Deccan Auto Spares Pvt Ltd',
      customerType: 'REGISTERED',
      gstin: buildGstin(MAHARASHTRA, 'AACCD5678K'),
      pan: 'AACCD5678K',
      placeOfSupplyState: MAHARASHTRA,
      billingAddress: '221 Bajirao Road',
      billingCity: 'Pune',
      billingPincode: '411002',
      phone: '9822011223',
      email: 'purchase@deccanauto.in',
      creditDays: 30,
      creditLimit: '200000.00',
      openingBalance: '48500.00',
    },
  });
  await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      name: 'Bengaluru Events LLP',
      customerType: 'REGISTERED',
      gstin: buildGstin(KARNATAKA, 'AAEFB9012M'),
      pan: 'AAEFB9012M',
      placeOfSupplyState: KARNATAKA,
      billingAddress: '48 Residency Road',
      billingCity: 'Bengaluru',
      billingPincode: '560025',
      phone: '9845566778',
      email: 'ops@bengalurevents.in',
      creditDays: 15,
      creditLimit: '150000.00',
    },
  });
  await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      name: 'Rakesh Sweets (Walk-in)',
      customerType: 'UNREGISTERED',
      placeOfSupplyState: MAHARASHTRA,
      billingAddress: 'FC Road',
      billingCity: 'Pune',
      phone: '9011223344',
    },
  });
  await prisma.customer.create({
    data: {
      tenantId: tenant.id,
      name: 'Surat Textiles Trading Co',
      customerType: 'REGISTERED',
      gstin: buildGstin(GUJARAT, 'AAGCS3456P'),
      pan: 'AAGCS3456P',
      placeOfSupplyState: GUJARAT,
      billingAddress: 'Ring Road',
      billingCity: 'Surat',
      phone: '9825566778',
      email: 'admin@surattextiles.in',
      creditDays: 45,
    },
  });

  await prisma.supplier.create({
    data: {
      tenantId: tenant.id,
      name: 'Maharashtra Media Supplies',
      gstin: buildGstin(MAHARASHTRA, 'AAFCM7890L'),
      placeOfSupplyState: MAHARASHTRA,
      address: 'Bhosari MIDC, Pune',
      paymentTermDays: 30,
      phone: '9765544332',
    },
  });

  // FR-306 — per-vertical default workflow templates.
  for (const [vertical, stages] of Object.entries(DEFAULT_WORKFLOWS)) {
    await prisma.workflowTemplate.create({
      data: {
        tenantId: tenant.id,
        vertical: vertical as Vertical,
        name: `${vertical.replace(/_/g, ' ')} — standard`,
        isDefault: true,
        stages: {
          create: stages.map((s, i) => ({
            tenantId: tenant.id,
            name: s.name,
            sequence: i + 1,
            department: s.department,
            isTerminal: s.isTerminal ?? false,
          })),
        },
      },
    });
  }

  // FR-119 — one user per Phase-1 role so the §2.3 matrix is demonstrable.
  const password = await bcrypt.hash('leoink123', 10);
  const users = [
    { name: 'Ganesh Kulkarni', email: 'owner@leoink.test', role: 'OWNER_ADMIN' as const, allBranches: true },
    { name: 'Sneha Patil', email: 'accounts@leoink.test', role: 'ACCOUNTS' as const, allBranches: false },
    { name: 'Amit Jadhav', email: 'sales@leoink.test', role: 'SALES_COUNTER' as const, allBranches: false },
    { name: 'Vikram Shinde', email: 'production@leoink.test', role: 'PRODUCTION_MANAGER' as const, allBranches: false },
    { name: 'Ravi Pawar', email: 'operator@leoink.test', role: 'OPERATOR' as const, allBranches: false },
    { name: 'Sanjay More', email: 'delivery@leoink.test', role: 'DELIVERY' as const, allBranches: false },
  ];
  for (const u of users) {
    await prisma.user.create({
      data: {
        tenantId: tenant.id,
        name: u.name,
        email: u.email,
        passwordHash: password,
        role: u.role,
        status: 'ACTIVE',
        allBranches: u.allBranches,
        branches: { create: [{ branchId: branch.id }] },
      },
    });
  }

  process.stdout.write(
    `\nSeeded "${tenant.tradeName}" (${tenant.gstin}), FY ${fyLabel}\n` +
      `  Sign in with any of:\n` +
      users.map((u) => `    ${u.email.padEnd(26)} ${u.role}`).join('\n') +
      `\n  Password for all: leoink123\n\n`,
  );
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error(err);
    await prisma.$disconnect();
    process.exit(1);
  });
