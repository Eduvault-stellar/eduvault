/**
 * GENERATED FILE — do not edit by hand.
 *
 * Produced by scripts/generate-api-client.mjs from docs/openapi.yaml.
 * Run `npm run generate:api-client` after changing the spec.
 * `npm run check:generated-client` (CI) fails if this file has drifted
 * from what the spec would generate.
 */

import { apiClient } from "../apiClient.js";

/**
 * List the authenticated user's materials
 * GET /api/materials
 */
export async function listMyMaterials({ query, ...init } = {}) {
  const path = `/api/materials`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "GET", ...init });
}

/**
 * Create a new material listing
 * POST /api/materials
 */
export async function createMaterial({ body, query, ...init } = {}) {
  const path = `/api/materials`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "POST", body, ...init });
}

/**
 * Replace editable material fields
 * PUT /api/materials
 */
export async function replaceMaterial({ body, query, ...init } = {}) {
  const path = `/api/materials`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "PUT", body, ...init });
}

/**
 * Update editable material fields
 * PATCH /api/materials
 */
export async function updateMaterial({ body, query, ...init } = {}) {
  const path = `/api/materials`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "PATCH", body, ...init });
}

/**
 * Validate or import structured material records
 * POST /api/materials/import
 */
export async function importMaterials({ body, query, ...init } = {}) {
  const path = `/api/materials/import`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "POST", body, ...init });
}

/**
 * Get material access status
 * GET /api/materials/access
 */
export async function getMaterialAccess({ query, ...init } = {}) {
  const path = `/api/materials/access`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "GET", ...init });
}

/**
 * Start a material access request
 * POST /api/materials/access
 */
export async function requestMaterialAccess({ body, query, ...init } = {}) {
  const path = `/api/materials/access`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "POST", body, ...init });
}

/**
 * Get material feedback
 * GET /api/materials/{id}/feedback
 */
export async function getMaterialFeedback({ id, query, ...init } = {}) {
  const path = `/api/materials/${id}/feedback`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "GET", ...init });
}

/**
 * Submit material feedback
 * POST /api/materials/{id}/feedback
 */
export async function submitMaterialFeedback({ id, body, query, ...init } = {}) {
  const path = `/api/materials/${id}/feedback`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "POST", body, ...init });
}

/**
 * Get an authorized material download
 * GET /api/materials/download/{id}
 */
export async function getMaterialDownload({ id, query, ...init } = {}) {
  const path = `/api/materials/download/${id}`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "GET", ...init });
}

/**
 * Get material edit history
 * GET /api/materials/history
 */
export async function getMaterialHistory({ query, ...init } = {}) {
  const path = `/api/materials/history`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "GET", ...init });
}

/**
 * Preview publish readiness for a material
 * GET /api/materials/{id}/publish
 */
export async function getMaterialPublishChecklist({ id, query, ...init } = {}) {
  const path = `/api/materials/${id}/publish`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "GET", ...init });
}

/**
 * Publish a material
 * POST /api/materials/{id}/publish
 */
export async function publishMaterial({ id, body, query, ...init } = {}) {
  const path = `/api/materials/${id}/publish`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "POST", body, ...init });
}

/**
 * Close a published material to new purchases
 * POST /api/materials/{id}/close
 */
export async function closeMaterial({ id, body, query, ...init } = {}) {
  const path = `/api/materials/${id}/close`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "POST", body, ...init });
}

/**
 * Cancel a draft or published material
 * POST /api/materials/{id}/cancel
 */
export async function cancelMaterial({ id, body, query, ...init } = {}) {
  const path = `/api/materials/${id}/cancel`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "POST", body, ...init });
}

/**
 * Report a material
 * POST /api/materials/{id}/report
 */
export async function reportMaterial({ id, body, query, ...init } = {}) {
  const path = `/api/materials/${id}/report`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "POST", body, ...init });
}

/**
 * List saved materials
 * GET /api/saved-materials
 */
export async function listSavedMaterials({ query, ...init } = {}) {
  const path = `/api/saved-materials`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "GET", ...init });
}

/**
 * Save a material
 * POST /api/saved-materials
 */
export async function saveMaterial({ body, query, ...init } = {}) {
  const path = `/api/saved-materials`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "POST", body, ...init });
}

/**
 * Unsave a material
 * DELETE /api/saved-materials
 */
export async function unsaveMaterial({ query, ...init } = {}) {
  const path = `/api/saved-materials`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "DELETE", ...init });
}

/**
 * Browse publicly listed materials
 * GET /api/market-materials
 */
export async function browseMarketMaterials({ query, ...init } = {}) {
  const path = `/api/market-materials`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "GET", ...init });
}

/**
 * Upload a material file to Pinata / IPFS
 * POST /api/upload
 */
export async function uploadMaterialFile({ body, query, ...init } = {}) {
  const path = `/api/upload`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "POST", body, ...init });
}

/**
 * List the authenticated user's purchases
 * GET /api/purchase
 */
export async function listPurchases({ query, ...init } = {}) {
  const path = `/api/purchase`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "GET", ...init });
}

/**
 * Record a material purchase after on-chain payment
 * POST /api/purchase
 */
export async function recordPurchase({ body, query, ...init } = {}) {
  const path = `/api/purchase`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "POST", body, ...init });
}

/**
 * Aggregate account purchase and Stellar transaction history
 * GET /api/transactions/history
 */
export async function listTransactionHistory({ query, ...init } = {}) {
  const path = `/api/transactions/history`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "GET", ...init });
}

/**
 * Check a buyer's entitlement to a material
 * GET /api/entitlements
 */
export async function checkEntitlement({ query, ...init } = {}) {
  const path = `/api/entitlements`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "GET", ...init });
}

/**
 * Look up a user profile
 * GET /api/profile
 */
export async function getProfile({ query, ...init } = {}) {
  const path = `/api/profile`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "GET", ...init });
}

/**
 * Create a profile
 * POST /api/profile
 */
export async function createProfile({ body, query, ...init } = {}) {
  const path = `/api/profile`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "POST", body, ...init });
}

/**
 * Update the authenticated user's profile
 * PATCH /api/profile
 */
export async function updateProfile({ body, query, ...init } = {}) {
  const path = `/api/profile`;
  const url = query && Object.keys(query).length ? `${path}?${new URLSearchParams(query)}` : path;
  return apiClient(url, { method: "PATCH", body, ...init });
}
