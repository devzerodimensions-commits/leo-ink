# Leo Ink — Phase 1 (MVP)

Cloud ERP for the Indian printing industry. React + Node.js + PostgreSQL implementation of
**Leo Ink — Phase 1 FRD** (`../Leo Ink - Phase 1 FRD.md`) and the companion
**Product Feature Document**.

## What is built

Three features from the Phase-1 scope, chosen so they form the FRD's §2.6 happy path
end-to-end — *enquiry → quotation → jobcard → production board*:

| # | Feature | FRD section | Requirements |
|---|---|---|---|
| **1** | **Setup, configuration & master data** — first-run wizard, firm profile & branding, branches, bank/UPI, financial years & rollover, document numbering, GST rates, HSN/SAC, UOM, terms, rounding, customers, suppliers, products, materials/media, rate cards, bulk import, RBAC, audit log, subscription & seat limits | §3, §9.4, §9.6 | FR-100 … FR-125, FR-715 … FR-718, FR-722 … FR-725 |
| **2** | **CRM, estimation & the print-pricing engine** ⭐ *wedge #1* — enquiry inbox, follow-ups, guided job-spec wizard, flex square-foot pricing, media-rate lookup, markup/margin, discounts, minimum charge, GST-aware totals, quote lifecycle, clone/revive, quote → jobcard | §4 | FR-200 … FR-233 |
| **3** | **Jobcard & production workflow** ⭐ *wedge #2* — multi-vertical jobcards, 15-second quick jobcard, gap-free FY-resetting numbering, digital job bag with QR, configurable per-vertical stages, Kanban board, stage progression with timestamps, operator assignment & work queue, scan-to-status, TAT & overdue alerts | §5 | FR-300 … FR-313 |

Everything obeys the FRD's cross-cutting rules (§10): decimal money (BR-1), place-of-supply
tax split (BR-2), gap-free numbering (BR-3), tenant/branch isolation (BR-4), amount-in-words
and Indian grouping (BR-5), GSTIN checksum validation (BR-6), **one shared pricing engine for
quote and invoice** (BR-7), audit trail (BR-9), UTC storage / IST display (BR-10), and
deactivate-not-delete (BR-11).

## Stack

| Layer | Choice | Why |
|---|---|---|
| Web | React 19 + Vite + TypeScript + Tailwind v4 + TanStack Query + React Router | Fast, typed, no framework lock-in |
| API | Node.js + Express 5 + TypeScript (ESM) + Zod | Plain Node as requested; modular per-domain routers |
| Data | PostgreSQL + Prisma | The FRD (§15.6) names a Prisma schema as the recommended next artifact |
| Money | `decimal.js` + Postgres `numeric` | BR-1 forbids floating point on money |
| Auth | JWT + bcrypt, role matrix enforced server-side | FR-715 / FR-716 are deny-by-default |
| Tests | Vitest + Supertest, run against real PostgreSQL | Every test title quotes an FRD acceptance criterion |

## Getting started

```bash
npm install
```

Then create your local env file — `.env` is gitignored, so each machine gets its own:

```bash
cp server/.env.example server/.env
```

### 1. Start PostgreSQL

Either works — both listen on **5433** and share the same `DATABASE_URL`, so nothing else changes:

```bash
npm run db:up
```

(Docker Compose, `postgres:16-alpine`.) If no Docker engine is available:

```bash
npm run db:start --workspace server
```

That serves **PGlite** — real PostgreSQL 17 compiled to WebAssembly — over the PostgreSQL
wire protocol, so Prisma, `psql` and the app cannot tell the difference. Leave it running.

Two things differ from a normal server, both handled and both irrelevant once you point
`DATABASE_URL` at Docker or a hosted PostgreSQL:

- PGlite maps every client connection onto **one** backend, so `DATABASE_URL` carries
  `pgbouncer=true` to stop Prisma naming its prepared statements (two processes would
  otherwise both register `s0` and collide with `42P05`).
- The socket server defaults to a single concurrent connection; `scripts/db.ts` raises it so
  the API, the seed script and `psql` can be connected at the same time.

### 2. Create the schema and demo data

```bash
npm run db:push --workspace server
```

```bash
npm run seed --workspace server
```

The seed builds a realistic Pune flex/digital shop — GSTIN, branch, financial year, numbering
series, GST slabs, UOMs, HSN/SAC codes, six media items with per-sq-ft rates and minimum
charges, a published rate card, four customers (intra-state, inter-state and unregistered),
per-vertical workflow templates, and one user per Phase-1 role.

Sign in with `owner@leoink.test` / `leoink123` (also `sales@`, `production@`, `operator@`,
`accounts@`, `delivery@`).

### 3. Run it

```bash
npm run dev
```

API on <http://localhost:4000>, web on <http://localhost:5173>.

## Testing against the document

```bash
npm test
```

The suites are organised by FR-ID, and **every `it(...)` title quotes an acceptance criterion
from the FRD** so a failure names the requirement it breaks:

| Suite | Covers |
|---|---|
| `tests/fr-shared-utilities.test.ts` | FR-122/123 Indian format & amount-in-words, BR-6 GSTIN checksum, FR-102 IFSC, FR-104 financial year, FR-106 numbering render, BR-1 money precision |
| `tests/fr-pricing-engine.test.ts` | FR-210 … FR-215 pricing engine, FR-223/224 GST totals, FR-504/505/506 multi-rate and place-of-supply split |
| `tests/fr-100-setup-and-masters.test.ts` | FR-100 … FR-121 setup and masters, FR-715/716 RBAC, FR-718 audit, BR-4 tenant isolation |
| `tests/fr-200-quotation.test.ts` | FR-200 … FR-233 enquiries, pricing, quote lifecycle, quote → jobcard |
| `tests/fr-300-production.test.ts` | FR-300 … FR-313 jobcards, job bag/QR, Kanban board, assignment, scan-to-status, TAT |

The API suites boot a throwaway PostgreSQL (PGlite) and apply the real Prisma schema, so the
`numeric` arithmetic and the `SELECT … FOR UPDATE` behind gap-free numbering are exercised for
real, not mocked.

**Current result: 182 passing, 0 failing.**

### End-to-end smoke test

With the API running and the demo shop seeded:

```bash
npx tsx scripts/smoke.ts
```

This walks the §2.6 happy path over real HTTP — sign in → enquiry → quotation priced by the
engine → send (number allocated) → won → jobcard → job bag + QR → Kanban board → scan-to-status
→ done — and asserts the figures and the audit trail at each step.

### Verified in the browser

The same path was driven through the React UI end to end. A 4 ft × 6 ft Star Flex banner ×2,
priced from the media master at ₹18/sq.ft:

| | |
|---|---|
| Area | 24.00 sq.ft (height × width) |
| Taxable value | ₹864.00 (24 × 18 × 2) |
| CGST / SGST | ₹77.76 + ₹77.76 (intra-state, 9% each) |
| Round off | +₹0.48 |
| Grand total | **₹1,020.00** |
| In words | Rupees One Thousand Twenty Only |

…then sent as `QUO/2026-27/00003`, marked Won, and converted one-click into jobcard
`JC/2026-27/00003` carrying the same ₹864.00 onto the shop floor.

## Project layout

```
leo-ink/
├─ server/
│  ├─ prisma/schema.prisma      the Phase-1 physical data model
│  ├─ prisma/seed.ts            demo shop
│  ├─ scripts/db.ts             local PostgreSQL (PGlite over the wire protocol)
│  ├─ src/
│  │  ├─ engine/pricing.ts      THE shared pricing + GST engine (BR-7)
│  │  ├─ lib/                   money, Indian format, GSTIN, financial year, numbering
│  │  ├─ auth/                  JWT, the §2.3 permission matrix, branch scoping
│  │  └─ modules/               auth · setup · masters · crm · quotes · production
│  └─ tests/                    FRD conformance suites
└─ web/
   └─ src/
      ├─ lib/                   API client, auth context, Indian formatting
      ├─ components/            layout + UI kit
      └─ pages/                 setup · masters · crm · quotes · production
```

## Deliberate implementation notes

- **One pricing engine, called twice.** `src/engine/pricing.ts` is pure (no clock, no
  randomness, no I/O) and stamps its version onto every result, so a quote and the invoice
  raised from it reconcile to the paise — the FRD's BR-7 and FR-508.
- **Head-wise GST rounding.** FR-505 computes CGST and SGST at *half the rate each*, then
  rounds each. That legitimately differs from a single IGST rounding by one paise on some
  values; the behaviour is pinned by a test rather than papered over.
- **Numbers are allocated at finalisation, never on a draft** (BR-3), inside the same
  transaction as the document, under a row lock — so an abandoned draft leaves no gap.
- **Express instead of NestJS.** The FRD's §2.1 platform note names NestJS; this build uses
  Express with a module-per-domain layout to match the "React, Node.js, PostgreSQL" brief.
  The module boundaries map 1:1 onto Nest modules if you migrate later.
- **Response envelope.** A single entity comes back at the top level (`{ id, … }`); a list is
  wrapped (`{ data, page, pageSize, total }`). Nothing else is nested.
- **Rollover is schema-limited.** FR-105 creates the next FY, resets the FY-scoped numbering
  series and computes each party's closing→opening figure idempotently. It cannot yet write
  FY-scoped opening *entries* or opening stock, because §6/§8's ledger, invoice, payment and
  stock-movement tables are out of this build's scope. `rolloverFinancialYear` in
  `src/modules/setup/service.ts` is where that extends.

## Not in this build

The rest of Phase 1 — inventory & procurement (§6), billing/GST/e-invoice/e-way-bill (§7),
accounting, collections and dispatch (§8), and reporting/communication/platform (§9.1–§9.3) —
is specified but not implemented here. The data model, the shared pricing/tax engine, the
numbering service and the permission matrix were built to carry them without rework.
