"use client";

import { useMemo, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { materialService } from "@/services/materialService";

const STORAGE_KEY = "eduvault.recentlyViewed";
const MAX_ITEMS = 12;

function getStoredIds() {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function storeIds(ids) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Silently fail if localStorage is full
  }
}

export function trackRecentlyViewed(material) {
  if (typeof window === "undefined") return;

  const id = String(material?._id || material?.id || material?.materialId || "");
  if (!id) return;

  const current = getStoredIds();
  const filtered = current.filter((storedId) => storedId !== id);
  const updated = [id, ...filtered].slice(0, MAX_ITEMS);
  storeIds(updated);
}

export function useRecentlyViewed() {
  const ids = useMemo(() => getStoredIds(), []);

  const query = useQuery({
    queryKey: ["materials", "recently-viewed", ids],
    queryFn: async () => {
      if (ids.length === 0) return [];

      const results = [];
      for (const id of ids.slice(0, 6)) {
        try {
          const material = await materialService.getMaterialDetail(id);
          if (material) results.push(material);
        } catch {
          // Skip materials that fail to load
        }
      }
      return results;
    },
    enabled: ids.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  return {
    ...query,
    items: query.data || [],
    ids,
  };
}
