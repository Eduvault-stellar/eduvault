# API contract & migration guide

This documents the mechanisms already enforced by `docs/openapi.yaml` and
`scripts/check-api-contracts.mjs` — how a change gets classified as breaking
or non-breaking, what's required to ship a breaking change, and how the
generated client and runtime validation fit into that lifecycle. It doesn't
introduce new process; it explains what's already checked in CI.

## What counts as breaking

`scripts/check-api-contracts.mjs`'s `findBreakingChanges()` diffs the spec on
the PR branch against the spec on the base branch (wired into
`.github/workflows/backend.yml` via `API_CONTRACT_BASE_FILE`) and fails the
build if any of the following changed without a version bump:

- An operation (`METHOD /path`) was removed.
- An operation's `operationId` changed.
- A documented `2xx` response status was removed from an operation.
- A schema had a property removed.
- A schema made a previously-optional property `required`.
- A schema's enum values were narrowed (a value the old spec allowed is no
  longer allowed).

Anything else — adding a new operation, adding an optional response field,
widening an enum, adding a new optional request field — is non-breaking and
needs no special handling.

## Shipping a breaking change

1. Bump `info.version`'s **major** component in `docs/openapi.yaml`.
2. Add `x-migration:` to the spec describing what changed and how to adapt.
   `findBreakingChanges()` only clears the detected breaking changes when
   *both* the major version increased *and* an `x-migration:` note is
   present — a major bump alone isn't sufficient, and neither is a
   migration note without a version bump.
3. If replacing an operation rather than changing it in place, deprecate the
   old one first (see below) rather than deleting it outright, so existing
   clients have the support window to move over.

## Deprecating an operation

Per `info.x-version-policy` (`support-window-days: 180`), a deprecated
operation must keep working for at least 180 days. Mark it in the spec with
`deprecated: true` plus:

- `x-sunset:` — the date the operation stops working.
- `x-successor:` — the operation (or path) that replaces it.
- `x-removal-version:` — the major version where it's actually removed.

`validateOpenApi()` enforces that all three are present on any operation
marked `deprecated: true`. At runtime, `src/lib/api/contract.js`'s
`enforceApiResponse()` sets the corresponding `Deprecation`, `Sunset`, and
`Link: <successor>; rel="successor-version"` headers automatically whenever
a route wrapped in `withApiContract()` is called with `{ deprecation: {...}
}` passed as an option.

## Runtime request/response validation

- **Request bodies**: `src/lib/api/validateRequest.js`'s
  `validateRequestBody(request, zodSchema)` parses and validates against a
  Zod schema, returning the same `Problem` shape as every other error
  response on failure (see `src/lib/materials/lifecycleSchemas.js` for the
  publish/close/cancel schemas as the reference pattern).
- **Responses**: `withApiContract()` wraps a route handler, negotiates
  `X-API-Version`/`Accept`, and coerces any non-`Problem`-shaped error
  response into the documented `Problem` shape — so callers get one
  consistent error envelope regardless of which route they hit. It's a
  genuine behavior change for a route's existing error shape (any ad hoc
  `{ error: "..." }` payload gets rewritten to the full `Problem` object),
  so adopting it on a route with existing consumers is a breaking change in
  its own right and needs to go through the same major-version/`x-migration:`
  process as any other breaking change above — it isn't a drop-in.
- Request validation (`validateRequestBody`) is purely additive by contrast
  — it only changes behavior for input that was previously accepted
  un-validated — which is why it's the piece adopted on the material
  publish/close/cancel routes in this change (see
  `src/lib/materials/lifecycleSchemas.js`); extending it to the rest of
  `src/app/api/**` is mechanical repetition of this same pattern. Adopting
  `withApiContract()` itself on an existing route is a separate, deliberate
  migration each time, not a default to reach for.

## The generated client

`npm run generate:api-client` (`scripts/generate-api-client.mjs`) reads
`docs/openapi.yaml` and emits `src/lib/api/generated/client.js` — one
function per `operationId`, routed through the existing `apiClient` fetch
wrapper. `npm run check:generated-client` (wired into CI) fails if the
committed generated file doesn't match what the current spec would produce,
so a spec change can't ship without a regenerated client alongside it.

Frontend services should call through the generated client instead of
building `/api/...` path strings by hand (see
`src/services/materialService.js`'s `publishMaterial`/`closeMaterial`/
`cancelMaterial` for the pattern) — that's what lets
`validateServiceConsumers()` catch a service calling an undocumented path,
and what keeps the client's shape tied to the spec instead of drifting
independently.
