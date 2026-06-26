"use client";

import Image from "next/image";
import Link from "next/link";
import { useState, useEffect } from "react";
import {
	FaHeart,
	FaCheckCircle,
	FaClock,
	FaExclamationTriangle,
	FaTag,
	FaBookOpen,
	FaListUl,
	FaStickyNote,
	FaImage,
	FaHistory,
	FaFlag,
} from "react-icons/fa";
import ResourceStatusBadge from "@/components/materials/ResourceStatusBadge";
import { motion } from "framer-motion";
import Navbar from "@/components/Navbar";
import BuyNowModal from "./modals/BuyNowModal";
import { useParams } from "next/navigation";
import { useMaterialDetail } from "@/hooks/api/useMaterials";
import { useEntitlement } from "@/hooks/api/useEntitlements";
import { QueryStateProvider } from "@/components/common/QueryStateProvider";
import Web3ErrorBoundary from "@/components/web3/Web3ErrorBoundary";
import SaveMaterialButton from "@/components/materials/SaveMaterialButton";
import { trackRecentlyViewed } from "@/hooks/useRecentlyViewed";
import RecommendedMaterials from "@/components/materials/RecommendedMaterials";
import MaterialReviewPanel from "@/components/materials/MaterialReviewPanel";
import { useAccount } from "wagmi";

function getPreviewImage(material) {
	return material.coverImageUrl || material.thumbnailUrl || material.image || "/images/image2.jpg";
}

function getPreviewCounts(material) {
	return {
		outcomes: Array.isArray(material.learningOutcomes) ? material.learningOutcomes.length : 0,
		sections: Array.isArray(material.tableOfContents) ? material.tableOfContents.length : 0,
		notes: Array.isArray(material.sampleNotes) ? material.sampleNotes.length : 0,
	};
}

function hasCoverImage(material) {
	return Boolean(material.coverImageUrl || material.thumbnailUrl || material.image);
}

function getAverageScore(material) {
	const score = Number(material.averageScore ?? material.rating);
	return Number.isFinite(score) && score > 0 ? score.toFixed(1) : "New";
}

function getFeedbackCount(material) {
	return Number(material.feedbackCount ?? material.reviewsCount ?? 0) || 0;
}

function PreviewBlock({ title, emptyLabel, items, icon: Icon }) {
	const hasItems = Array.isArray(items) && items.length > 0;

	return (
		<section className="bg-white border border-gray-200 rounded-2xl p-5 shadow-sm sm:p-6 h-full">
			<div className="flex items-center gap-2 mb-3">
				{Icon ? <Icon className="text-blue-600" aria-hidden="true" /> : null}
				<h2 className="text-base sm:text-lg font-semibold text-gray-900">{title}</h2>
			</div>
			{hasItems ? (
				<ul role="list" className="space-y-2 sm:space-y-3">
					{items.map((item) => (
						<li
							key={item}
							role="listitem"
							className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-2.5 sm:px-4 sm:py-3 text-sm text-gray-700"
						>
							{item}
						</li>
					))}
				</ul>
			) : (
				<div className="rounded-xl border border-dashed border-gray-200 bg-gray-50 px-4 py-5 text-sm text-gray-500">
					{emptyLabel}
				</div>
			)}
		</section>
	);
}

function PreviewStat({ label, value, icon: Icon }) {
	return (
		<div className="rounded-2xl border border-gray-100 bg-white px-4 py-4 shadow-sm flex items-start gap-3">
			{Icon ? (
				<span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-blue-50 text-blue-600">
					<Icon aria-hidden="true" />
				</span>
			) : null}
			<div className="min-w-0">
				<p className="text-[10px] uppercase tracking-[0.24em] text-gray-400">{label}</p>
				<p className="mt-1.5 text-base font-semibold text-gray-900 break-words">{value}</p>
			</div>
		</div>
	);
}

function CreatorCard({ author, creator, createdAt }) {
	const authorName = author?.name || creator || "Anonymous creator";
	const institution = author?.institution || "Independent educator";
	const level = author?.level || "All learners";
	const badgeText = author?.verified ? "Verified creator" : "Creator profile unverified";
	const badgeTone = author?.verified
		? "text-emerald-700 bg-emerald-50 border border-emerald-200"
		: "text-amber-700 bg-amber-50 border border-amber-200";

	return (
		<div className="bg-white border border-gray-200 rounded-3xl p-5 sm:p-6 shadow-sm h-full">
			<h2 className="text-base sm:text-lg font-semibold text-gray-900 mb-4">Creator</h2>
			<div className="flex flex-col sm:flex-row sm:items-center gap-4">
				<div
					className="h-14 w-14 sm:h-16 sm:w-16 rounded-2xl bg-slate-100 text-slate-600 grid place-items-center text-xl font-semibold shrink-0"
					aria-hidden="true"
				>
					{authorName.charAt(0).toUpperCase()}
				</div>
				<div className="space-y-1 text-sm text-gray-600 min-w-0">
					<p className="text-base font-semibold text-gray-900 break-words">{authorName}</p>
					<p className="break-words">{institution}</p>
					<p className="break-words">{level}</p>
					<p
						className={`mt-2 inline-flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] font-semibold px-2.5 py-1 rounded-full ${badgeTone}`}
					>
						{badgeText}
					</p>
				</div>
			</div>
			<div className="mt-5 grid gap-3 sm:grid-cols-2">
				<div className="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-700">
					<strong className="block text-[10px] uppercase tracking-[0.2em] text-slate-500">
						Uploaded
					</strong>
					<span className="mt-1 block">
						{createdAt ? new Date(createdAt).toLocaleDateString() : "Unknown date"}
					</span>
				</div>
				<div className="rounded-2xl bg-slate-50 px-4 py-3 text-sm text-slate-700">
					<strong className="block text-[10px] uppercase tracking-[0.2em] text-slate-500">
						Author type
					</strong>
					<span className="mt-1 block">{author?.department || "General"}</span>
				</div>
			</div>
		</div>
	);
}

function getAccessCopy(status, isLoading) {
	if (isLoading) {
		return {
			label: "Checking access",
			message: "We are checking your payment and entitlement status.",
			className: "border-slate-200 bg-slate-50 text-slate-700",
			icon: FaClock,
		};
	}

	switch (status) {
		case "active":
			return {
				label: "Access granted",
				message: "Payment is complete. This material is unlocked for your wallet.",
				className: "border-emerald-200 bg-emerald-50 text-emerald-800",
				icon: FaCheckCircle,
			};
		case "pending":
			return {
				label: "Payment pending",
				message: "Your access request started, but payment still needs to be completed.",
				className: "border-amber-200 bg-amber-50 text-amber-800",
				icon: FaClock,
			};
		case "payment_failed":
			return {
				label: "Payment incomplete",
				message: "The previous payment attempt did not complete, so access is still locked.",
				className: "border-rose-200 bg-rose-50 text-rose-800",
				icon: FaExclamationTriangle,
			};
		case "wallet_required":
			return {
				label: "Wallet required",
				message: "Connect your wallet to request access and complete payment.",
				className: "border-blue-200 bg-blue-50 text-blue-800",
				icon: FaClock,
			};
		default:
			return {
				label: "Payment required",
				message:
					"Start an access request from this page, then complete payment to unlock the file.",
				className: "border-slate-200 bg-white text-slate-700",
				icon: FaClock,
			};
	}
}

function AccessStatusPanel({ status, isLoading }) {
	const copy = getAccessCopy(status, isLoading);
	const Icon = copy.icon;

	return (
		<div className={`rounded-2xl border px-4 py-3 text-sm ${copy.className}`}>
			<div className="flex items-start gap-3">
				<Icon className="mt-0.5 shrink-0" aria-hidden="true" />
				<div className="min-w-0">
					<p className="font-semibold">{copy.label}</p>
					<p className="mt-1 leading-5 break-words">{copy.message}</p>
				</div>
			</div>
		</div>
	);
}

function PriceLine({ price, currency, rating, reviewsCount }) {
	return (
		<div className="flex flex-wrap items-center gap-3 sm:gap-4">
			<div className="flex items-center gap-2">
				<Image
					src="/images/stellar.png"
					alt="Stellar"
					width={28}
					height={28}
					className="rounded-full"
				/>
				<span className="text-xl sm:text-2xl font-bold text-gray-900">
					{price} {currency || "XLM"}
				</span>
			</div>
			<div className="flex items-center gap-2 text-sm">
				{rating && rating !== "New" ? (
				<span className="text-yellow-500">⭐ {rating}</span>
			) : (
				<span className="text-gray-400">No ratings yet</span>
			)}
				<span className="text-gray-400">({reviewsCount || 0} reviews)</span>
			</div>
		</div>
	);
}

function PurchaseCard({
	material,
	accessStatus,
	entitlementQuery,
	address,
	isOwned,
	isDownloading,
	downloadError,
	onDownload,
	onRequestAccess,
	onAddToCart,
	onReport,
}) {
	// NOTE: avoid `overflow-hidden/clip` on any ancestor of this card or
	// `lg:sticky` will silently stop working (browsers need an overflow-visible
	// scroll container between the sticky element and the viewport).
	return (
		<aside className="bg-white border border-gray-200 rounded-3xl p-5 sm:p-6 shadow-sm space-y-5 lg:sticky lg:top-24">
			<div className="space-y-3">
				<PriceLine
					price={material.price}
					currency={material.currency}
					rating={getAverageScore(material)}
					reviewsCount={getFeedbackCount(material)}
				/>
				<AccessStatusPanel
					status={accessStatus}
					isLoading={Boolean(address && entitlementQuery.isLoading)}
				/>
			</div>

			<div className="flex flex-col sm:flex-row sm:flex-wrap sm:justify-start items-stretch sm:items-center gap-3 w-full">
				<div className="w-full sm:w-auto sm:flex-1">
					<SaveMaterialButton material={material} variant="detail" className="w-full sm:w-auto" />
				</div>
				{isOwned ? (
					<button
						type="button"
						className="w-full sm:w-auto sm:flex-1 px-6 sm:px-8 py-2.5 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-md transition flex items-center justify-center gap-2 shadow-sm focus-visible:ring-2 focus-visible:ring-blue-500 disabled:opacity-60 disabled:cursor-not-allowed"
						onClick={onDownload}
						disabled={isDownloading}
					>
						<FaCheckCircle aria-hidden="true" />
						{isDownloading ? "Preparing..." : "Download material"}
					</button>
				) : (
					<>
						<button
							type="button"
							className="w-full sm:w-auto sm:flex-1 px-6 py-2 border border-gray-300 text-gray-700 font-semibold rounded-md hover:bg-gray-100 transition focus-visible:ring-2 focus-visible:ring-blue-500"
							onClick={onAddToCart}
						>
							Buy now
						</button>
						<button
							type="button"
							className="w-full sm:w-auto sm:flex-1 px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-md transition focus-visible:ring-2 focus-visible:ring-blue-500"
							onClick={onRequestAccess}
						>
							{accessStatus === "pending" ? "Complete payment" : "Request access"}
						</button>
					</>
				)}
			</div>

			{downloadError ? (
				<p role="alert" className="text-sm text-red-600">
					{downloadError}
				</p>
			) : null}

			<div className="flex items-center justify-between text-sm text-gray-500 pt-3 border-t border-gray-100">
				<div className="flex items-center gap-2">
					<FaHeart className="text-pink-500" aria-hidden="true" />
					<span>{material.likes || 0} likes</span>
				</div>
				<button
					type="button"
					onClick={onReport}
					className="flex items-center gap-1.5 text-gray-400 hover:text-red-600 transition duration-150 font-medium"
				>
					<FaFlag className="text-xs" aria-hidden="true" />
					<span>Report quality issue</span>
				</button>
			</div>
		</aside>
	);
}

function RevisionHistoryPanel({ history, currentVersion }) {
	return (
		<section className="bg-white border border-gray-200 rounded-2xl p-5 sm:p-6 shadow-sm">
			<div className="flex items-center gap-2 mb-4">
				<FaHistory className="text-blue-600" aria-hidden="true" />
				<h2 className="text-base sm:text-lg font-semibold text-gray-900">Revision History</h2>
			</div>
			{history.length === 0 ? (
				<div className="text-sm text-gray-500 py-3">
					No past edits recorded. This is the initial version (v1).
				</div>
			) : (
				<div className="relative border-l border-gray-200 pl-4 ml-2 space-y-6">
					{/* Current active version */}
					<div className="relative">
						<span className="absolute -left-[22px] top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-blue-600 ring-4 ring-white" />
						<div className="flex flex-col gap-1 text-sm">
							<div className="flex flex-wrap items-center gap-2">
								<span className="font-bold text-blue-700 text-xs uppercase px-2 py-0.5 rounded bg-blue-50 border border-blue-100">
									v{currentVersion || 1} (Current)
								</span>
							</div>
						</div>
					</div>

					{/* Previous versions */}
					{history.map((entry, index) => {
						const revVersion = entry.version || (history.length - index);
						return (
							<div key={entry._id || index} className="relative">
								<span className="absolute -left-[22px] top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full bg-gray-300 ring-4 ring-white" />
								<div className="flex flex-col gap-1 text-sm text-gray-600">
									<div className="flex flex-wrap items-center gap-2">
										<span className="font-bold text-gray-800 text-xs uppercase px-2 py-0.5 rounded bg-gray-100 border border-gray-200">
											v{revVersion}
										</span>
										<span className="text-xs text-gray-400">
											{entry.updatedAt ? new Date(entry.updatedAt).toLocaleDateString() : "Unknown Date"}
										</span>
									</div>
									{entry.changeReason && (
										<p className="mt-1 text-gray-700 bg-slate-50 border border-slate-100 rounded-lg p-2.5 italic text-xs leading-relaxed max-w-2xl">
											&ldquo;{entry.changeReason}&rdquo;
										</p>
									)}
									{entry.changes && Object.keys(entry.changes).length > 0 && (
										<div className="mt-1 text-xs text-gray-400">
											Modified: {Object.keys(entry.changes).join(", ")}
										</div>
									)}
								</div>
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}

function ReportModal({ isOpen, onClose, materialId, materialTitle }) {
	const [reason, setReason] = useState("");
	const [description, setDescription] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [submitted, setSubmitted] = useState(false);
	const [error, setError] = useState("");

	if (!isOpen) return null;

	const reasons = [
		"Inappropriate content",
		"Copyright violation",
		"Low quality / Unreadable",
		"Spam / Advertising",
		"Incorrect information",
		"Other"
	];

	const handleSubmit = async (e) => {
		e.preventDefault();
		if (!reason) {
			setError("Please select a reason for reporting.");
			return;
		}

		setSubmitting(true);
		setError("");

		try {
			const res = await fetch(`/api/materials/${materialId}/report`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json"
				},
				body: JSON.stringify({ reason, description })
			});

			const data = await res.json();
			if (!res.ok) {
				throw new Error(data.error || "Failed to submit report");
			}

			setSubmitted(true);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Something went wrong. Please try again.");
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4">
			<div className="bg-white rounded-3xl p-6 max-w-md w-full shadow-xl border border-gray-100">
				{submitted ? (
					<div className="text-center py-6 space-y-4">
						<div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-green-100 text-green-600">
							<FaCheckCircle className="h-6 w-6" />
						</div>
						<h3 className="text-lg font-bold text-gray-900">Report Submitted</h3>
						<p className="text-sm text-gray-500 leading-relaxed">
							Thank you for your report. The listing has been flagged and is currently under admin review. We will investigate the issue.
						</p>
						<div className="mt-4 bg-slate-50 rounded-xl p-3 border border-slate-100 text-left">
							<span className="text-[10px] uppercase font-bold tracking-wider text-slate-400 block">Moderation Queue</span>
							<p className="text-xs text-slate-600 mt-1">
								Status: <span className="font-semibold text-amber-600">Pending Review</span>
							</p>
							<p className="text-[11px] text-slate-500 mt-0.5">
								Placeholder: Admin review will process this flag shortly.
							</p>
						</div>
						<button
							onClick={() => {
								setSubmitted(false);
								setReason("");
								setDescription("");
								onClose();
							}}
							className="mt-6 w-full py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 font-semibold rounded-xl transition"
						>
							Close
						</button>
					</div>
				) : (
					<form onSubmit={handleSubmit} className="space-y-4">
						<div className="flex items-center justify-between border-b border-gray-100 pb-3">
							<h3 className="text-lg font-bold text-gray-950">Report Resource</h3>
							<button
								type="button"
								onClick={onClose}
								className="text-gray-400 hover:text-gray-600 font-semibold text-lg"
							>
								&times;
							</button>
						</div>
						
						<p className="text-xs text-gray-500">
							Help us keep EduVault clean and reliable. Please tell us why you are flagging this listing:
						</p>

						<div className="space-y-2">
							<label className="block text-xs font-bold text-gray-700 uppercase tracking-wider">
								Reason for Flagging
							</label>
							<select
								value={reason}
								onChange={(e) => setReason(e.target.value)}
								className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-800"
								required
							>
								<option value="">Select a reason...</option>
								{reasons.map((r) => (
									<option key={r} value={r}>
										{r}
									</option>
								))}
							</select>
						</div>

						<div className="space-y-2">
							<label className="block text-xs font-bold text-gray-700 uppercase tracking-wider">
								Additional Information
							</label>
							<textarea
								value={description}
								onChange={(e) => setDescription(e.target.value)}
								placeholder="Please provide details about the issue..."
								rows={4}
								className="w-full border border-gray-300 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-800"
							/>
						</div>

						{error && <p className="text-xs text-red-600 font-medium">{error}</p>}

						<div className="flex items-center gap-3 pt-2">
							<button
								type="button"
								onClick={onClose}
								className="flex-1 py-2 border border-gray-200 text-gray-600 hover:bg-gray-50 font-semibold rounded-xl transition"
							>
								Cancel
							</button>
							<button
								type="submit"
								disabled={submitting}
								className="flex-1 py-2 bg-red-600 hover:bg-red-700 text-white font-semibold rounded-xl transition disabled:opacity-60"
							>
								{submitting ? "Submitting..." : "Submit Report"}
							</button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}

export default function MaterialDetailsPage() {
	const params = useParams();
	const id = String(params.id);
	const [showBuyModal, setShowBuyModal] = useState(false);
	const [showReportModal, setShowReportModal] = useState(false);
	const [history, setHistory] = useState([]);
	const materialQuery = useMaterialDetail(id);
	const entitlementQuery = useEntitlement(id);
	const { address } = useAccount();
	const [downloadError, setDownloadError] = useState(null);
	const [isDownloading, setIsDownloading] = useState(false);

	useEffect(() => {
		if (id) {
			fetch(`/api/materials/history?id=${id}`)
				.then((res) => res.json())
				.then((data) => {
					if (Array.isArray(data)) {
						setHistory(data);
					}
				})
				.catch((err) => console.error("Error fetching material history:", err));
		}
	}, [id]);

	const accessStatus = !address
		? "wallet_required"
		: entitlementQuery.data?.status || (entitlementQuery.isLoading ? "checking" : "not_purchased");
	const isOwned =
		accessStatus === "active" ||
		Boolean(address && (entitlementQuery.data?.owned || entitlementQuery.data?.hasAccess));

	const handleDownload = async () => {
		if (!address) {
			setShowBuyModal(true);
			return;
		}

		setIsDownloading(true);
		setDownloadError(null);

		try {
			const query = new URLSearchParams({ materialId: id, buyerAddress: address });
			const response = await fetch(`/api/download?${query.toString()}`);
			const payload = await response.json();

			if (!response.ok) {
				throw new Error(payload?.detail || payload?.error || "Unable to request material access.");
			}

			if (payload.fileUrl) {
				window.open(payload.fileUrl, "_blank", "noopener,noreferrer");
			}
		} catch (err) {
			setDownloadError(err instanceof Error ? err.message : "Unable to request material access.");
		} finally {
			setIsDownloading(false);
		}
	};

	useEffect(() => {
		if (materialQuery.data) {
			trackRecentlyViewed(materialQuery.data);
		}
	}, [materialQuery.data]);

	return (
		<>
			<Navbar />

			<main className="relative bg-[#fffaf6] min-h-screen py-6 sm:py-10 px-4 sm:px-6 md:px-10 lg:px-20">
				{/* Background grid pattern */}
				<div
					className="absolute inset-0 bg-[linear-gradient(to_right,#f2ede8_1px,transparent_1px),linear-gradient(to_bottom,#f2ede8_1px,transparent_1px)] bg-[size:40px_40px] opacity-70 pointer-events-none -z-10"
					aria-hidden="true"
				/>

				<QueryStateProvider query={materialQuery}>
					{(material) => {
						const counts = getPreviewCounts(material);

						return (
							<motion.div
								initial={{ opacity: 0, y: 40 }}
								animate={{ opacity: 1, y: 0 }}
								transition={{ duration: 0.6 }}
								aria-live="polite"
								className="max-w-6xl mx-auto"
							>
								{/* Breadcrumb */}
								<nav aria-label="Breadcrumb" className="mb-4 sm:mb-6">
									<p className="text-xs sm:text-sm text-gray-500 break-words">
										<Link
											href="/marketplace"
											className="text-blue-600 hover:underline focus-visible:ring-2 focus-visible:ring-blue-500 rounded-sm"
										>
											Marketplace
										</Link>{" "}
										→ <span className="text-gray-700">{material.title}</span>
									</p>
								</nav>

								{/* Page header (title) */}
								<header className="mb-6 sm:mb-8">
									<h1 className="text-2xl sm:text-3xl lg:text-4xl font-bold text-gray-900 break-words">
										{material.title}
									</h1>
									<div className="mt-3 flex flex-wrap items-center gap-3">
										<ResourceStatusBadge material={material} />
										<span className="inline-flex items-center gap-1.5 text-xs font-semibold px-2.5 py-1 rounded-full text-blue-700 bg-blue-50 border border-blue-200">
											Current Revision: v{material.version || 1}
										</span>
									</div>
									<p className="mt-3 text-sm sm:text-base text-gray-600 leading-relaxed max-w-3xl break-words">
										{material.shortSummary || material.description || "Creator preview not shared yet."}
									</p>
									{material.tags?.length ? (
										<div className="mt-4 flex flex-wrap gap-2" role="list">
											{material.tags.map((tag, i) => (
												<span
													key={i}
													role="listitem"
													className="inline-flex items-center gap-1 text-xs bg-gray-100 text-gray-700 px-3 py-1 rounded-full"
												>
													<FaTag aria-hidden="true" className="text-[10px] text-gray-400" />
													#{tag}
												</span>
											))}
										</div>
									) : null}
								</header>

								{/* Main two-column area (mobile: purchase card first, lg+: content left + sticky card right) */}
								<div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-6 lg:gap-8 items-start">
									{/* LEFT: preview + content */}
									<div className="space-y-6 lg:space-y-8 min-w-0 order-2 lg:order-1">
										{/* Preview hero image */}
										<div className="bg-white rounded-2xl overflow-hidden shadow-sm border border-gray-200">
											<Image
												src={getPreviewImage(material)}
												alt={material.title}
												width={800}
												height={600}
												className="w-full h-56 sm:h-72 md:h-[380px] object-cover"
											/>
										</div>

										{/* Preview stat grid */}
										<section aria-labelledby="preview-summary-heading" className="space-y-3">
											<h2 id="preview-summary-heading" className="text-base sm:text-lg font-semibold text-gray-900">
												What you will get
											</h2>
											<div className="grid grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4">
												<PreviewStat
													label="Cover image"
													value={hasCoverImage(material) ? "Provided" : "Missing"}
													icon={FaImage}
												/>
												<PreviewStat
													label="Learning outcomes"
													value={`${counts.outcomes} shared`}
													icon={FaBookOpen}
												/>
												<PreviewStat
													label="Table of contents"
													value={`${counts.sections} sections`}
													icon={FaListUl}
												/>
												<PreviewStat
													label="Sample notes"
													value={`${counts.notes} included`}
													icon={FaStickyNote}
												/>
											</div>
										</section>

										{/* About + Creator */}
										<div className="grid grid-cols-1 md:grid-cols-2 gap-5 lg:gap-6">
											<section className="bg-white border border-gray-200 rounded-2xl p-5 sm:p-6 shadow-sm">
												<h2 className="text-base sm:text-lg font-semibold text-gray-900 mb-3">
													About
												</h2>
												<p className="text-sm text-gray-600 leading-relaxed break-words">
													{material.shortSummary || material.description}
												</p>
											</section>

											<CreatorCard
												author={material.author}
												creator={material.creator}
												createdAt={material.createdAt}
											/>
										</div>

										{/* Performance Summary */}
										<div className="bg-white border border-gray-200 rounded-2xl p-5 sm:p-6 shadow-sm">
											<h2 className="text-base sm:text-lg font-semibold text-gray-900 mb-4">Performance Summary</h2>
											<div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
												<div className="rounded-xl bg-blue-50 p-4">
													<p className="text-[10px] text-gray-500 font-bold tracking-wider uppercase">Views</p>
													<p className="mt-1 text-2xl font-bold text-blue-600">{material.viewCount || 0}</p>
												</div>
												<div className="rounded-xl bg-emerald-50 p-4">
													<p className="text-[10px] text-gray-500 font-bold tracking-wider uppercase">Saves</p>
													<p className="mt-1 text-2xl font-bold text-emerald-600">{material.saveCount || 0}</p>
												</div>
												<div className="rounded-xl bg-amber-50 p-4">
													<p className="text-[10px] text-gray-500 font-bold tracking-wider uppercase">Requests</p>
													<p className="mt-1 text-2xl font-bold text-amber-600">{material.accessCount || 0}</p>
												</div>
												<div className="rounded-xl bg-pink-50 p-4">
													<p className="text-[10px] text-gray-500 font-bold tracking-wider uppercase">Likes</p>
													<p className="mt-1 text-2xl font-bold text-pink-600">{material.likes || 0}</p>
												</div>
											</div>
										</div>

										{/* Preview blocks */}
										<div className="grid grid-cols-1 md:grid-cols-2 gap-5 lg:gap-6">
											<PreviewBlock
												title="Learning outcomes"
												emptyLabel="The creator has not added learning outcomes yet."
												items={material.learningOutcomes}
												icon={FaBookOpen}
											/>
											<PreviewBlock
												title="Table of contents"
												emptyLabel="The creator has not shared a table of contents yet."
												items={material.tableOfContents}
												icon={FaListUl}
											/>
											<PreviewBlock
												title="Sample notes"
												emptyLabel="No sample notes were shared for this listing."
												items={material.sampleNotes}
												icon={FaStickyNote}
											/>

											{/* On-chain verification */}
											<section className="bg-white border border-gray-200 rounded-2xl p-5 sm:p-6 shadow-sm h-full">
												<h2 className="text-base sm:text-lg font-semibold text-gray-900 mb-3">
													On-chain verification
												</h2>
												<p className="text-sm text-gray-600 leading-relaxed mb-4">
													EduVault publishes marketplace metadata through Soroban contracts so
													buyers can verify authenticity before paying.
												</p>
												<p className="flex items-center gap-2 text-sm">
													<strong className="text-gray-800">Status:</strong>
													{material.verified ? (
														<span className="text-green-700 flex items-center gap-1 text-xs font-semibold">
															<FaCheckCircle aria-hidden="true" />
															Ready for Soroban
														</span>
													) : (
														<span className="text-amber-700 text-xs font-semibold">
															Not verified yet
														</span>
													)}
												</p>
											</section>

											{/* Resource Details */}
											<div className="bg-white border border-gray-200 rounded-2xl p-5 sm:p-6 shadow-sm h-full">
												<h2 className="text-base sm:text-lg font-semibold text-gray-900 mb-3">
													Resource Details
												</h2>
												<dl className="space-y-3 text-sm">
													{material.category && (
														<div className="flex justify-between items-center">
															<dt className="text-gray-500 font-medium">Category</dt>
															<dd className="text-gray-800 font-semibold capitalize">{material.category}</dd>
														</div>
													)}
													{material.subject && (
														<div className="flex justify-between items-center">
															<dt className="text-gray-500 font-medium">Subject</dt>
															<dd className="text-gray-800 font-semibold">{material.subject}</dd>
														</div>
													)}
													{material.level && (
														<div className="flex justify-between items-center">
															<dt className="text-gray-500 font-medium">Level</dt>
															<dd className="text-gray-800 font-semibold capitalize">{material.level}</dd>
														</div>
													)}
													<div className="flex justify-between items-center">
														<dt className="text-gray-500 font-medium">File Type</dt>
														<dd className="text-gray-800 font-semibold uppercase">{material.fileType || "PDF"}</dd>
													</div>
													{material.pages && (
														<div className="flex justify-between items-center">
															<dt className="text-gray-500 font-medium">Pages</dt>
															<dd className="text-gray-800 font-semibold">{material.pages}</dd>
														</div>
													)}
													<div className="flex justify-between items-center">
														<dt className="text-gray-500 font-medium">Visibility</dt>
														<dd className="text-gray-800 font-semibold capitalize">{material.visibility || "Public"}</dd>
													</div>
												</dl>
											</div>
										</div>

										<RevisionHistoryPanel
											history={history}
											currentVersion={material.version}
										/>

										<MaterialReviewPanel
											materialId={id}
											initialReviews={material.reviews || material.reviewHistory || []}
											entitlement={entitlementQuery}
											currentAddress={address}
											creatorAddress={material.userAddress || material.ownerAddress || material.creatorAddress || material.author?.walletAddress}
										/>
									</div>

									{/* RIGHT: sticky purchase card (first on mobile for early CTA visibility) */}
									<div className="order-1 lg:order-2">
										<PurchaseCard
											material={material}
											accessStatus={accessStatus}
											entitlementQuery={entitlementQuery}
											address={address}
											isOwned={isOwned}
											isDownloading={isDownloading}
											downloadError={downloadError}
											onDownload={handleDownload}
											onRequestAccess={() => setShowBuyModal(true)}
											onAddToCart={() => setShowBuyModal(true)}
											onReport={() => setShowReportModal(true)}
										/>
									</div>
								</div>

								{/* Recommendations */}
								{materialQuery.data && (
									<div className="mt-12 sm:mt-14">
										<RecommendedMaterials
											currentId={id}
											subject={materialQuery.data.subject}
											category={materialQuery.data.category}
											creator={materialQuery.data.author || materialQuery.data.creator}
										/>
									</div>
								)}
							</motion.div>
						);
					}}
				</QueryStateProvider>
			</main>

			{materialQuery.data && (
				<Web3ErrorBoundary onRetry={() => setShowBuyModal(false)}>
					<BuyNowModal
						isOpen={showBuyModal}
						onClose={() => setShowBuyModal(false)}
						price={materialQuery.data.price}
						materialId={id}
						materialTitle={materialQuery.data.title}
						materialCreator={
							materialQuery.data.author?.name || materialQuery.data.creator || "Unknown"
						}
						onAccessUpdated={() => entitlementQuery.refetch()}
					/>
				</Web3ErrorBoundary>
			)}

			<ReportModal
				isOpen={showReportModal}
				onClose={() => setShowReportModal(false)}
				materialId={id}
				materialTitle={materialQuery.data?.title || ""}
			/>
		</>
	);
}
