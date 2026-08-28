/**
 * Zod request schemas for the material lifecycle routes (publish/close/cancel).
 * Mirrors the requestBody shapes declared for these operations in
 * docs/openapi.yaml — the spec and these schemas describe the same contract.
 */

import { z } from "zod";

export const publishRequestSchema = z
  .object({
    contractId: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

export const closeRequestSchema = z
  .object({
    reason: z.string().trim().min(1).optional(),
  })
  .strict();

export const cancelRequestSchema = z
  .object({
    reason: z.string().trim().min(1).optional(),
  })
  .strict();
