"use client";

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query/queryKeys";
import { useWallet } from "@/hooks/useWallet";

const STORAGE_PREFIX = "eduvault.savedMaterials.v1";
const REQUEST_DELAY_MS = 250;

function getMaterialId(material) {
	return String(material?._id || material?.id || material?.materialId || "");
}

function getStorageKey(address) {
	return `${STORAGE_PREFIX}:${String(address).toLowerCase()}`;
}

function readSavedMaterials(address) {
	if (!address || typeof window === "undefined") return [];

	const raw = window.localStorage.getItem(getStorageKey(address));
	if (!raw) return [];

	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function writeSavedMaterials(address, materials) {
	if (!address || typeof window === "undefined") return;
	window.localStorage.setItem(getStorageKey(address), JSON.stringify(materials));
}

function toSavedMaterial(material) {
	const id = getMaterialId(material);
	return {
		...material,
		id,
		_id: material?._id || id,
		savedAt: new Date().toISOString(),
	};
}

function waitForRequestWindow() {
	return new Promise((resolve) => {
		window.setTimeout(resolve, REQUEST_DELAY_MS);
	});
}

export function useSavedMaterials() {
	const { address, isConnected } = useWallet();
	const queryClient = useQueryClient();
	const savedQueryKey = queryKeys.materials.saved(address || "guest");

	const savedQuery = useQuery({
		queryKey: savedQueryKey,
		queryFn: () => readSavedMaterials(address),
		enabled: isConnected && !!address,
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

			await waitForRequestWindow();

			const current = readSavedMaterials(address);
			const isAlreadySaved = current.some((item) => getMaterialId(item) === id);
			const next = isAlreadySaved
				? current.filter((item) => getMaterialId(item) !== id)
				: [toSavedMaterial(material), ...current];

			writeSavedMaterials(address, next);
			return { id, saved: !isAlreadySaved, items: next };
		},
		onSuccess: (result) => {
			queryClient.setQueryData(savedQueryKey, result.items);
		},
	});

	return {
		...savedQuery,
		items: savedQuery.data || [],
		savedIds,
		isSaved: (materialOrId) => savedIds.has(typeof materialOrId === "string" ? materialOrId : getMaterialId(materialOrId)),
		toggleSaved: toggleMutation.mutate,
		toggleSavedAsync: toggleMutation.mutateAsync,
		isToggling: toggleMutation.isPending,
		pendingMaterialId: toggleMutation.variables ? getMaterialId(toggleMutation.variables) : null,
		toggleError: toggleMutation.error,
	};
}
