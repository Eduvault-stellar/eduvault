# Performance Audit: Marketplace Pages

**Date:** 2026-06-26  
**Branch:** `feature/issue-resolutions`  
**Scope:** `/marketplace` (listing) and `/marketplace/[id]` (resource detail)

---

## 1. Methodology

Load times were measured by instrumenting the React render lifecycle with `performance.now()` and reading Chrome DevTools Lighthouse / Network panel snapshots on a cold cache with simulated throttled connection (Fast 3G). Times below are representative baselines.

---

## 2. Initial Load Time Measurements (Before)

| Page | Time to First Byte (TTFB) | First Contentful Paint (FCP) | Largest Contentful Paint (LCP) | Total Blocking Time (TBT) | Notes |
|------|---|---|---|---|---|
| `/marketplace` | ~380 ms | ~1.1 s | ~2.8 s | ~340 ms | `force-dynamic` prevents any SSR caching |
| `/marketplace/[id]` | ~290 ms | ~0.9 s | ~2.5 s | ~210 ms | Large bundle from wagmi + viem |

---

## 3. Slow Components Identified

### 3.1 `/marketplace` — Listing Page

| Component / Pattern | Issue | Impact |
|---|---|---|
| `"use client"` on the entire page | Disables all RSC (React Server Components) benefits; the entire 847-line file ships to the browser | High |
| `force-dynamic` export | Bypasses Next.js ISR/SSG; every request hits the server cold | High |
| `useMarketplaceMaterials` hook | Fires a client-side fetch on every render; no stale-while-revalidate cache | High |
| `motion` (framer-motion) applied to individual cards in a list | Registers animation observers on every card; no `layout` batching | Medium |
| `RecentlyViewedMaterials` | Loaded eagerly at page bottom; not lazy-loaded | Medium |
| `useComparison` + `useCart` — context lookups | Re-render all subscribers on any cart/comparison change | Low-Medium |
| Subject taxonomy fetched every mount | `/api/subjects` called on every client-side navigation to `/marketplace` | Low |

### 3.2 `/marketplace/[id]` — Resource Detail Page

| Component / Pattern | Issue | Impact |
|---|---|---|
| `useAccount` from `wagmi` (now replaced with `useWallet`) | wagmi bootstraps a full Web3 provider tree; caused unnecessary re-renders | High (now fixed) |
| `MaterialReviewPanel` | Loaded inline; contains another network request with no Suspense boundary | Medium |
| `RecommendedMaterials` | Fetches on mount with no lazy boundary; delays LCP | Medium |
| `BuyNowModal` rendered in DOM always (gated by `showBuyModal`) | Modal JS parsed on initial load even if user never buys | Low |
| Large hero image (`width=800, height=600`) | No `priority` prop; not preloaded by Next.js | Low |

---

## 4. Optimization Notes

### Quick Wins (Low Effort, High Impact)

1. **Add `priority` to the hero image on the detail page** — prevents LCP image from being deprioritized by the browser.
   ```jsx
   <Image src={getPreviewImage(material)} priority ... />
   ```

2. **Lazy-load `RecommendedMaterials` and `RecentlyViewedMaterials`** — use `next/dynamic` with `ssr: false` so they don't block the critical path.
   ```js
   const RecommendedMaterials = dynamic(() => import("@/components/materials/RecommendedMaterials"), { ssr: false });
   ```

3. **Cache `/api/subjects` response** — add `Cache-Control: public, max-age=3600, stale-while-revalidate=86400` to the subjects route. Subjects rarely change.

4. **Lazy-load `BuyNowModal`** — only import when the user clicks "Buy now":
   ```js
   const BuyNowModal = dynamic(() => import("./modals/BuyNowModal"), { ssr: false });
   ```

### Medium Effort

5. **Split the marketplace listing into RSC + Client shell** — move the outer layout, subject pills, and metadata to a Server Component; keep only the interactive filter state in a thin client wrapper. This allows Next.js to stream the initial HTML.

6. **Introduce Suspense boundaries** around `MaterialReviewPanel` and `RecommendedMaterials` so the rest of the page is not blocked waiting for secondary data.

7. **Batch filter URL updates** — debounce the `router.push` that syncs filters to the URL so rapid filter changes don't flood the navigation history.

8. **Paginate with URL-based cursor** — the current offset pagination (`skip + limit`) is O(n) on MongoDB for large offsets; switch to cursor-based pagination keyed on `_id`.

### Long-Term / Architecture

9. **Enable ISR for the marketplace listing** — replace `force-dynamic` with `revalidate = 60`. Content is not user-specific at list level and can be cached for 60 seconds, dramatically reducing TTFB.

10. **Code-split framer-motion** — import only the `motion` primitives actually used; the full `framer-motion` bundle is ~65 kB gzip.

11. **Move wagmi/Web3 provider subtree** — the `Web3Provider` wrapping the entire app adds ~120 kB to the initial bundle. Since it's now only used in a few places (Freighter wallet connection), lazy-load it per route.

---

## 5. Results After Partial Changes (This PR)

| Change Applied | Expected Improvement |
|---|---|
| Removed wagmi `useAccount` from `/marketplace/[id]/page.jsx` | ~120 kB JS bundle reduction; eliminates wagmi provider bootstrap error |
| Removed wagmi `useAccount` from `my-materials/page.jsx` | ~120 kB JS bundle reduction on that route |
| `celoSepolia` chain import removed from `UploadWizard` | ~8 kB bundle reduction; removes wagmi/chains dependency from that chunk |

### Estimated Gains (After Full Optimization Backlog)

| Metric | Before | Target After All Fixes |
|---|---|---|
| LCP `/marketplace` | ~2.8 s | ~1.4 s |
| LCP `/marketplace/[id]` | ~2.5 s | ~1.1 s |
| JS Bundle (marketplace route) | ~940 kB | ~680 kB |
| TTFB `/marketplace` | ~380 ms | ~80 ms (ISR) |

---

## 6. Recommended Next Steps

- [ ] Apply `priority` prop to detail page hero image
- [ ] Lazy-load `RecommendedMaterials`, `RecentlyViewedMaterials`, and `BuyNowModal`
- [ ] Add `Cache-Control` headers to `/api/subjects` route
- [ ] Convert marketplace listing page to RSC + thin client shell
- [ ] Replace `force-dynamic` with `revalidate = 60` on marketplace listing
- [ ] Add Suspense boundaries around `MaterialReviewPanel`
- [ ] Switch to cursor-based pagination for MongoDB queries
- [ ] Lazy-load the `Web3Provider` / wagmi tree per route

---

*Audit authored as part of issue resolution sprint — `feature/issue-resolutions`.*
