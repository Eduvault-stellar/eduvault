"use client";

import { FaHeart, FaRegHeart, FaSpinner } from "react-icons/fa";
import { useWallet } from "@/hooks/useWallet";
import { useSavedMaterials } from "@/hooks/api/useSavedMaterials";

function getMaterialId(material) {
	return String(material?._id || material?.id || material?.materialId || "");
}

export default function SaveMaterialButton({ material, variant = "card", className = "" }) {
	const { isConnected, connect, state } = useWallet();
	const { isSaved, toggleSaved, isToggling, pendingMaterialId } = useSavedMaterials();
	const materialId = getMaterialId(material);
	const saved = isSaved(materialId);
	const isPending = isToggling && pendingMaterialId === materialId;
	const isWalletBusy = state.status === "connecting" || state.status === "initializing";
	const disabled = isPending || isWalletBusy;

	const handleClick = (event) => {
		event.preventDefault();
		event.stopPropagation();

		if (disabled) return;

		if (!isConnected) {
			connect();
			return;
		}

		toggleSaved(material);
	};

	const Icon = isPending ? FaSpinner : saved ? FaHeart : FaRegHeart;
	const label = !isConnected ? "Connect wallet to save" : saved ? "Unsave material" : "Save material";

	if (variant === "detail") {
		return (
			<button
				type="button"
				onClick={handleClick}
				disabled={disabled}
				aria-pressed={isConnected ? saved : undefined}
				className={`px-6 py-2 border font-semibold rounded-md transition flex items-center gap-2 ${
					saved
						? "border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
						: "border-gray-300 text-gray-700 hover:bg-gray-100"
				} disabled:opacity-60 disabled:cursor-not-allowed ${className}`}
			>
				<Icon className={isPending || isWalletBusy ? "animate-spin" : ""} />
				{isPending ? "Updating..." : label}
			</button>
		);
	}

	return (
		<button
			type="button"
			onClick={handleClick}
			disabled={disabled}
			aria-label={label}
			aria-pressed={isConnected ? saved : undefined}
			title={label}
			className={`absolute right-3 top-3 z-20 inline-flex h-9 w-9 items-center justify-center rounded-full border shadow-sm transition ${
				saved
					? "border-rose-200 bg-rose-50 text-rose-600 hover:bg-rose-100"
					: "border-white/70 bg-white/90 text-gray-500 hover:text-rose-600"
			} disabled:opacity-60 disabled:cursor-not-allowed ${className}`}
		>
			<Icon className={isPending || isWalletBusy ? "animate-spin" : ""} />
		</button>
	);
}
