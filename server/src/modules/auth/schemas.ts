/** Request validation for the public auth surface (FR-715, FR-723). */
import { z } from 'zod';
import { emailSchema } from '../setup/schemas.js';

export { emailSchema };

/** FR-723 — self-serve sign-up: firm + first Owner/Admin in one call. */
export const registerSchema = z
  .object({
    legalName: z.string().trim().min(2).max(160).optional(),
    /** Alias accepted by the sign-up form. */
    firmName: z.string().trim().min(2).max(160).optional(),
    tradeName: z.string().trim().max(160).optional(),
    gstin: z
      .string()
      .max(20)
      .transform((v) => v.trim().toUpperCase())
      .optional(),
    ownerName: z.string().trim().min(2).max(120).optional(),
    name: z.string().trim().min(2).max(120).optional(),
    email: emailSchema,
    password: z.string().min(8, 'Password must be at least 8 characters').max(72),
    phone: z.string().trim().max(20).optional(),
    planCode: z
      .string()
      .trim()
      .max(40)
      .transform((v) => v.toUpperCase())
      .optional(),
  })
  .refine((v) => !!(v.legalName ?? v.firmName), {
    message: 'The firm legal name is required',
    path: ['legalName'],
  })
  .refine((v) => !!(v.ownerName ?? v.name), {
    message: "The owner's name is required",
    path: ['ownerName'],
  });

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Password is required').max(72),
  /** Optional disambiguator when one email exists in more than one tenant. */
  tenantId: z.string().trim().min(1).optional(),
});
