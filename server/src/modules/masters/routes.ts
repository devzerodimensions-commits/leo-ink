/**
 * Master-data routes — mounted at /api (see src/app.ts).
 *
 * FR-113 customers · FR-114 suppliers · FR-115 products/SKUs · FR-116 material
 * items · FR-120 bulk import · FR-121 opening balances · FR-201 customer master
 * · FR-202 read-only ledger · FR-212 media rate exposure · FR-216 rate cards.
 *
 * FR-716 — every route is guarded by a deny-by-default permission check on the
 * `setup` module ("Setup, config & masters" in the §2.3 matrix).
 */
import { Router } from 'express';
import { requireAuth, requirePermission } from '../../auth/middleware.js';
import { asyncHandler, notFound } from '../../http/errors.js';
import {
  customerCreateSchema,
  customerUpdateSchema,
  importBatchListQuerySchema,
  importBodySchema,
  importEntitySchema,
  ledgerQuerySchema,
  listQuerySchema,
  materialCreateSchema,
  materialUpdateSchema,
  openingBalanceImportSchema,
  productCreateSchema,
  productUpdateSchema,
  rateCardCreateSchema,
  rateCardListQuerySchema,
  rateCardUpdateSchema,
  supplierCreateSchema,
  supplierDetailQuerySchema,
  supplierListQuerySchema,
  supplierUpdateSchema,
  templateEntitySchema,
} from './schemas.js';
import * as service from './service.js';

export const mastersRouter = Router();

/**
 * Express 5 types every path param as `string | string[]`; a single `:id`
 * segment can only ever be one string, so narrow it once here.
 */
function pathParam(raw: string | string[] | undefined): string {
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

const canRead = requirePermission('setup', 'R');
const canCreate = requirePermission('setup', 'C');
const canUpdate = requirePermission('setup', 'U');
const canDelete = requirePermission('setup', 'D');

// ─────────────────────────────────────────────────────────────────────────────
// FR-113 / FR-201 — Customers
// ─────────────────────────────────────────────────────────────────────────────

mastersRouter.get(
  '/customers',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.listCustomers(auth, listQuerySchema.parse(req.query)));
  }),
);

mastersRouter.post(
  '/customers',
  canCreate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const created = await service.createCustomer(auth, customerCreateSchema.parse(req.body));
    res.status(201).json(created);
  }),
);

/** FR-202 — read-only ledger; registered before the generic :id read for clarity. */
mastersRouter.get(
  '/customers/:id/ledger',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const { asOn } = ledgerQuerySchema.parse(req.query);
    res.json(await service.customerLedger(auth, pathParam(req.params.id), asOn));
  }),
);

/** BR-11 — the deactivation offered when a hard delete is refused. */
mastersRouter.post(
  '/customers/:id/deactivate',
  canUpdate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.deactivateCustomer(auth, pathParam(req.params.id)));
  }),
);

mastersRouter.get(
  '/customers/:id',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.getCustomer(auth, pathParam(req.params.id)));
  }),
);

mastersRouter.put(
  '/customers/:id',
  canUpdate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.updateCustomer(auth, pathParam(req.params.id), customerUpdateSchema.parse(req.body)));
  }),
);

mastersRouter.delete(
  '/customers/:id',
  canDelete,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.deleteCustomer(auth, pathParam(req.params.id)));
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// FR-114 — Suppliers
// ─────────────────────────────────────────────────────────────────────────────

mastersRouter.get(
  '/suppliers',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.listSuppliers(auth, supplierListQuerySchema.parse(req.query)));
  }),
);

mastersRouter.post(
  '/suppliers',
  canCreate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.status(201).json(await service.createSupplier(auth, supplierCreateSchema.parse(req.body)));
  }),
);

mastersRouter.post(
  '/suppliers/:id/deactivate',
  canUpdate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.deactivateSupplier(auth, pathParam(req.params.id)));
  }),
);

mastersRouter.get(
  '/suppliers/:id',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const { billDate } = supplierDetailQuerySchema.parse(req.query);
    res.json(await service.getSupplier(auth, pathParam(req.params.id), billDate));
  }),
);

mastersRouter.put(
  '/suppliers/:id',
  canUpdate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.updateSupplier(auth, pathParam(req.params.id), supplierUpdateSchema.parse(req.body)));
  }),
);

mastersRouter.delete(
  '/suppliers/:id',
  canDelete,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.deleteSupplier(auth, pathParam(req.params.id)));
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// FR-115 — Products / SKUs
// ─────────────────────────────────────────────────────────────────────────────

mastersRouter.get(
  '/products',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.listProducts(auth, listQuerySchema.parse(req.query)));
  }),
);

mastersRouter.post(
  '/products',
  canCreate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.status(201).json(await service.createProduct(auth, productCreateSchema.parse(req.body)));
  }),
);

mastersRouter.post(
  '/products/:id/deactivate',
  canUpdate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.deactivateProduct(auth, pathParam(req.params.id)));
  }),
);

mastersRouter.get(
  '/products/:id',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.getProduct(auth, pathParam(req.params.id)));
  }),
);

mastersRouter.put(
  '/products/:id',
  canUpdate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.updateProduct(auth, pathParam(req.params.id), productUpdateSchema.parse(req.body)));
  }),
);

mastersRouter.delete(
  '/products/:id',
  canDelete,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.deleteProduct(auth, pathParam(req.params.id)));
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// FR-116 / FR-212 — Material items
// ─────────────────────────────────────────────────────────────────────────────

mastersRouter.get(
  '/materials',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.listMaterials(auth, listQuerySchema.parse(req.query)));
  }),
);

mastersRouter.post(
  '/materials',
  canCreate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.status(201).json(await service.createMaterial(auth, materialCreateSchema.parse(req.body)));
  }),
);

mastersRouter.post(
  '/materials/:id/deactivate',
  canUpdate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.deactivateMaterial(auth, pathParam(req.params.id)));
  }),
);

mastersRouter.get(
  '/materials/:id',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.getMaterial(auth, pathParam(req.params.id)));
  }),
);

mastersRouter.put(
  '/materials/:id',
  canUpdate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.updateMaterial(auth, pathParam(req.params.id), materialUpdateSchema.parse(req.body)));
  }),
);

mastersRouter.delete(
  '/materials/:id',
  canDelete,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.deleteMaterial(auth, pathParam(req.params.id)));
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// FR-216 — Rate cards
// ─────────────────────────────────────────────────────────────────────────────

mastersRouter.get(
  '/rate-cards',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.listRateCards(auth, rateCardListQuerySchema.parse(req.query)));
  }),
);

mastersRouter.post(
  '/rate-cards',
  canCreate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.status(201).json(await service.createRateCard(auth, rateCardCreateSchema.parse(req.body)));
  }),
);

mastersRouter.post(
  '/rate-cards/:id/deactivate',
  canUpdate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.deactivateRateCard(auth, pathParam(req.params.id)));
  }),
);

mastersRouter.get(
  '/rate-cards/:id',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.getRateCard(auth, pathParam(req.params.id)));
  }),
);

mastersRouter.put(
  '/rate-cards/:id',
  canUpdate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.updateRateCard(auth, pathParam(req.params.id), rateCardUpdateSchema.parse(req.body)));
  }),
);

mastersRouter.delete(
  '/rate-cards/:id',
  canDelete,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.deleteRateCard(auth, pathParam(req.params.id)));
  }),
);

// ─────────────────────────────────────────────────────────────────────────────
// FR-120 / FR-121 — Bulk import
// ─────────────────────────────────────────────────────────────────────────────

mastersRouter.get(
  '/imports/templates/:entity',
  canRead,
  asyncHandler(async (req, res) => {
    requireAuth(req);
    const entity = templateEntitySchema.safeParse(pathParam(req.params.entity));
    if (!entity.success) throw notFound(`No import template for "${pathParam(req.params.entity)}"`);
    res.json(service.importTemplate(entity.data));
  }),
);

mastersRouter.get(
  '/imports/batches',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.listImportBatches(auth, importBatchListQuerySchema.parse(req.query)));
  }),
);

mastersRouter.get(
  '/imports/batches/:id',
  canRead,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.json(await service.getImportBatch(auth, pathParam(req.params.id)));
  }),
);

/** FR-121 — must be registered before the generic /imports/:entity handler. */
mastersRouter.post(
  '/imports/opening-balances',
  canCreate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    res.status(201).json(await service.runOpeningBalanceImport(auth, openingBalanceImportSchema.parse(req.body)));
  }),
);

mastersRouter.post(
  '/imports/:entity',
  canCreate,
  asyncHandler(async (req, res) => {
    const auth = requireAuth(req);
    const entity = importEntitySchema.safeParse(pathParam(req.params.entity));
    if (!entity.success) throw notFound(`"${pathParam(req.params.entity)}" cannot be bulk-imported`);
    res.status(201).json(await service.runImport(auth, entity.data, importBodySchema.parse(req.body)));
  }),
);
