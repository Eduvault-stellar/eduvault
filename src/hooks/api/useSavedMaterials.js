"use client";

import { useMemo, useCallback } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/queryKeys";
import { useWallet } from "@/hooks/useWallet";
import { savedMaterialService } from "@/services/savedMaterialService";

const STORAGE_PREFIX = "eduvault.savedMaterials.v1";

function getMaterialId(material) {
  return String(material?._id || material?.id || material?.materialId || "");
}

function getStorageKey(address) {
  return `${STORAGE_PREFIX}:${String(address).toLowerCase()}`;
}

function getLocalSavedIds(address) {
  if (!address || typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(getStorageKey(address));
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function setLocalSavedIds(address, ids) {
  if (!address || typeof window === "undefined") return;
  window.localStorage.setItem(getStorageKey(address), JSON.stringify(ids));
}

export function useSavedMaterials() {
  const { address, isConnected } = useWallet();
  const queryClient = useQueryClient();
  const savedQueryKey = queryKeys.materials.saved(address || "guest");

  // Fetch saved materials from backend (with localStorage fallback)
  const savedQuery = useQuery({
    queryKey: savedQueryKey,
    queryFn: async () => {
      let items = [];

      // Try backend first if connected
      if (isConnected && address) {
        try {
          const response = await savedMaterialService.getSavedMaterials();
          if (response?.items) {
            items = response.items.map((entry) => ({
              ...(entry.material || {}),
              id: entry.material?._id || entry.materialId,
              _id: entry.material?._id || entry.materialId,
              savedAt: entry.savedAt,
            }));
          }
        } catch {
          // Fallback to localStorage
          items = getLocalSavedIds(address);
        }
      } else if (address) {
        items = getLocalSavedIds(address);
      }

      return items;
    },
    enabled: !!address,
    initialData: [],
    staleTime: 30 * 1000,
  });

  const savedIds = useMemo(
    () => new Set((savedQuery.data || []).map((material) => getMaterialId(material))),
    [savedQuery.data]
  );

  const toggleMutation = useMutation({
    mutationFn: async (material) => {
      if (!address) {
        throw new Error("Connect your wallet to save materials.");
      }

      const id = getMaterialId(material);
      if (!id) {
        throw new Error("Unable to identify this material.");
      }

      const isAlreadySaved = savedIds.has(id);

      if (isAlreadySaved) {
        // Unsave - try backend first
        try {
          await savedMaterialService.unsaveMaterial(id);
        } catch {
          // Fallback to localStorage
          const current = getLocalSavedIds(address);
          setLocalSavedIds(address, current.filter((savedId) => savedId !== id));
        }
        return { id, saved: false };
      } else {
        // Save - try backend first
        try {
          await savedMaterialService.saveMaterial(id);
        } catch {
          // Fallback to localStorage
          const current = getLocalSavedIds(address);
          setLocalSavedIds(address, [...current, id]);
        }
        return { id, saved: true };
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: savedQueryKey });
    },
    onError: (err) => {
      console.error("Toggle saved material failed:", err);
    },
  });

  const isSaved = useCallback(
    (materialOrId) => {
      const id = typeof materialOrId === "string" ? materialOrId : getMaterialId(materialOrId);
      return savedIds.has(id);
    },
    [savedIds]
  );

  return {
    ...savedQuery,
    items: savedQuery.data || [],
    savedIds,
    isSaved,
    toggleSaved: toggleMutation.mutate,
    toggleSavedAsync: toggleMutation.mutateAsync,
    isToggling: toggleMutation.isPending,
    pendingMaterialId: toggleMutation.variables ? getMaterialId(toggleMutation.variables) : null,
    toggleError: toggleMutation.error,
  };
}
