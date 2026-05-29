"use client";

import Image from "next/image";
import Link from "next/link";
import { useState } from "react";
import { FaHeart, FaCheckCircle } from "react-icons/fa";
import { motion } from "framer-motion";
import Navbar from "@/components/Navbar";
import BuyNowModal from "./modals/BuyNowModal";
import { useParams } from "next/navigation";
import { useMaterialDetail } from "@/hooks/api/useMaterials";
import { useEntitlement } from "@/hooks/api/useEntitlements";
import { QueryStateProvider } from "@/components/common/QueryStateProvider";
import Web3ErrorBoundary from "@/components/web3/Web3ErrorBoundary";
import SaveMaterialButton from "@/components/materials/SaveMaterialButton";

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

function PreviewBlock({ title, emptyLabel, items }) {
	const hasItems = Array.isArray(items) && items.length > 0;

	return (
		<section className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
			<h2 className="text-lg font-semibold text-gray-900 mb-3">{title}</h2>
			{hasItems ? (
				<ul className="space-y-3">
					{items.map((item) => (
						<li key={item} className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-700">
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

function PreviewStat({ label, value }) {
	return (
		<div className="rounded-xl border border-gray-100 bg-gray-50 px-3 py-3">
			<p className="text-[10px] uppercase tracking-[0.2em] text-gray-400">{label}</p>
			<p className="mt-1 text-sm font-semibold text-gray-800">{value}</p>
		</div>
	);
}

export default function MaterialDetailsPage() {
	const params = useParams();
	const id = String(params.id);
	const [showBuyModal, setShowBuyModal] = useState(false);
	const materialQuery = useMaterialDetail(id);
	const entitlementQuery = useEntitlement(id);

	const isOwned = entitlementQuery.data?.owned || false;

	return (
		<>
			<Navbar />

			<section className="relative bg-[#fffaf6] min-h-screen py-10 px-6 md:px-20">
				{/* 🔹 Background Grid Pattern */}
				<div
					className="absolute inset-0 bg-[linear-gradient(to_right,#f2ede8_1px,transparent_1px),linear-gradient(to_bottom,#f2ede8_1px,transparent_1px)] bg-[size:40px_40px] opacity-70 pointer-events-none -z-10"
					aria-hidden="true"
				></div>

				<QueryStateProvider query={materialQuery}>
					{(material) => (
						<motion.div
							initial={{ opacity: 0, y: 40 }}
							animate={{ opacity: 1, y: 0 }}
							transition={{ duration: 0.6 }}
							className="max-w-6xl mx-auto"
						>
							{/* Breadcrumb */}
							<p className="text-sm text-gray-500 mb-6">
								<Link href="/marketplace" className="text-blue-600 hover:underline">
									Marketplace
								</Link>{" "}
								→ {material.title}
							</p>

							{/* Top Section */}
							<div className="flex flex-col md:flex-row gap-10">
								{/* Image Preview */}
								<div className="flex-1 bg-white rounded-2xl overflow-hidden shadow-sm border border-gray-200">
									<Image
										src={getPreviewImage(material)}
										alt={material.title}
										width={800}
										height={600}
										className="w-full h-[380px] object-cover"
									/>
								</div>

								{/* Info Section */}
								<div className="flex-1 space-y-5">
									<h1 className="text-2xl md:text-3xl font-bold text-gray-900">
										{material.title}
									</h1>
									<p className="text-gray-600 text-sm leading-relaxed">
										{material.shortSummary || material.description || "Creator preview not shared yet."}
									</p>

									<div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
										<PreviewStat
											label="Cover image"
											value={
												material.coverImageUrl || material.thumbnailUrl || material.image
													? "Provided"
													: "Missing"
											}
										/>
										<PreviewStat
											label="Learning outcomes"
											value={`${getPreviewCounts(material).outcomes} shared`}
										/>
										<PreviewStat
											label="Table of contents"
											value={`${getPreviewCounts(material).sections} sections`}
										/>
									</div>

									{/* Price & Rating */}
									<div className="flex items-center gap-4 mt-4">
										<div className="flex items-center gap-2">
											<Image
												src="/images/stellar.png"
												alt="Stellar"
												width={28}
												height={28}
												className="rounded-full"
											/>
											<span className="text-lg font-semibold text-gray-900">
												{material.price} {material.currency || "XLM"}
											</span>
										</div>
										<span className="text-sm text-yellow-500">⭐ {material.rating || 4.8}</span>
										<span className="text-gray-400 text-sm">
											({material.reviewsCount || 0} Reviews)
										</span>
									</div>

									{/* Buttons */}
									<div className="flex flex-wrap items-center gap-3 mt-4">
										<SaveMaterialButton material={material} variant="detail" />
										{isOwned ? (
											<button 
												className="px-8 py-2.5 bg-green-600 hover:bg-green-700 text-white font-semibold rounded-md transition flex items-center gap-2 shadow-sm"
												onClick={() => window.open(material.downloadUrl || '#', '_blank')}
											>
												<FaCheckCircle /> Download Material
											</button>
										) : (
											<>
												<button className="px-6 py-2 border border-gray-300 text-gray-700 font-semibold rounded-md hover:bg-gray-100 transition">
													Add to Cart
												</button>
												<button
													onClick={() => setShowBuyModal(true)}
													className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-md transition"
												>
													Buy Now!
												</button>
											</>
										)}
									</div>

									{/* Likes */}
									<div className="flex items-center gap-2 text-sm text-gray-500 mt-3">
										<FaHeart className="text-pink-500" />
										{material.likes || 0} Likes
									</div>
								</div>
							</div>


							{/* About + Author Info */}
							<div className="grid md:grid-cols-2 gap-6 mt-10">
								{/* About */}
								<div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
									<h2 className="text-lg font-semibold text-gray-900 mb-3">
										About
									</h2>
									<p className="text-sm text-gray-600 mb-4 leading-relaxed">
										{material.shortSummary || material.description}
									</p>
									<div className="flex flex-wrap gap-2 mt-2">
										{material.tags?.map((tag, i) => (
											<span
												key={i}
												className="text-xs bg-gray-100 text-gray-700 px-3 py-1 rounded-full"
											>
												#{tag}
											</span>
										))}
									</div>
								</div>

								{/* Author Info */}
								<div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
									<h2 className="text-lg font-semibold text-gray-900 mb-3">
										Author Info
									</h2>
									<div className="text-sm text-gray-600 space-y-2">
										<p>
											<strong className="text-gray-800">Author:</strong>{" "}
											{material.author?.name || material.creator || "Anonymous"}
										</p>
										<p>
											<strong className="text-gray-800">Institution:</strong>{" "}
											{material.author?.institution || "N/A"}
										</p>
										<p>
											<strong className="text-gray-800">Department:</strong>{" "}
											{material.author?.department || "N/A"}
										</p>
										<p>
											<strong className="text-gray-800">Level:</strong>{" "}
											{material.author?.level || "N/A"}
										</p>
										<p>
											<strong className="text-gray-800">Uploaded:</strong>{" "}
											{material.createdAt ? new Date(material.createdAt).toLocaleDateString() : "N/A"}
										</p>
										<p className="flex items-center gap-2">
											<strong className="text-gray-800">Verification:</strong>
											{material.verified ? (
												<span className="text-green-600 flex items-center gap-1 text-xs font-medium">
													<FaCheckCircle /> Ready for Soroban
												</span>
											) : (
												<span className="text-red-500 text-xs font-medium">
													Not Verified
												</span>
											)}
										</p>
									</div>
								</div>
							</div>

							<div className="grid md:grid-cols-2 gap-6 mt-10">
								<PreviewBlock
									title="Learning Outcomes"
									emptyLabel="The creator has not added learning outcomes yet."
									items={material.learningOutcomes}
								/>
								<PreviewBlock
									title="Table of Contents"
									emptyLabel="The creator has not shared a table of contents yet."
									items={material.tableOfContents}
								/>
								<PreviewBlock
									title="Sample Notes"
									emptyLabel="No sample notes were shared for this listing."
									items={material.sampleNotes}
								/>
								<div className="bg-white border border-gray-200 rounded-2xl p-6 shadow-sm">
									<h2 className="text-lg font-semibold text-gray-900 mb-3">
										Preview Fields
									</h2>
									<p className="text-sm text-gray-600 leading-relaxed mb-4">
										Marketplace listings can expose creator-provided cover images, short
										summaries, learning outcomes, table of contents entries, and sample
										notes. Missing values should stay friendly and non-blocking.
									</p>
									<ul className="space-y-3 text-sm text-gray-700">
										<li className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
											<strong className="text-gray-900">coverImageUrl</strong> or
											thumbnail fallback for the hero image.
										</li>
										<li className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
											<strong className="text-gray-900">shortSummary</strong> for the
											listing teaser.
										</li>
										<li className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3">
											<strong className="text-gray-900">learningOutcomes</strong>,
											<strong className="text-gray-900"> tableOfContents</strong>, and
											<strong className="text-gray-900"> sampleNotes</strong> as arrays
											or newline/comma-separated input from the upload form.
										</li>
									</ul>
								</div>
							</div>

							{/* Related Notes - Placeholder for now */}
							<div className="mt-14">
								<h2 className="text-lg font-semibold text-gray-900 mb-4">
									Discover more Notes
								</h2>

								<div className="grid sm:grid-cols-2 md:grid-cols-4 gap-6">
									{[1, 2, 3, 4].map((_, i) => (
										<div
											key={i}
											className="bg-white border border-gray-200 rounded-xl shadow-sm hover:shadow-md transition overflow-hidden"
										>
											<div className="relative w-full h-40 bg-gray-100">
												{/* Placeholder */}
											</div>
											<div className="p-4">
												<h3 className="text-sm font-semibold text-gray-900 line-clamp-1">
													Related Material
												</h3>
												<p className="text-xs text-gray-500 mb-2">by Author</p>
											</div>
										</div>
									))}
								</div>
							</div>
						</motion.div>
					)}
				</QueryStateProvider>
			</section>

			{materialQuery.data && (
				<Web3ErrorBoundary onRetry={() => setShowBuyModal(false)}>
					<BuyNowModal
						isOpen={showBuyModal}
						onClose={() => setShowBuyModal(false)}
						price={materialQuery.data.price}
						materialId={id}
						materialTitle={materialQuery.data.title}
						materialCreator={materialQuery.data.author?.name || materialQuery.data.creator || "Unknown"}
					/>
				</Web3ErrorBoundary>
			)}
		</>
	);
}
