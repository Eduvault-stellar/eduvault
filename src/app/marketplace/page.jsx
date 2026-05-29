// Marketplace page: supports search, filters, sorting, pagination, and empty/loading/error states.
// State is reflected in the URL for shareability.

"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import {
	FaHeart,
	FaSearch,
	FaFilter,
	FaStar,
	FaFilePdf,
	FaFileWord,
	FaFilePowerpoint,
	FaRegClock,
	FaExchangeAlt,
	FaShoppingCart,
} from "react-icons/fa";
import { motion } from "framer-motion";

import Navbar from "@/components/Navbar";
import SaveMaterialButton from "@/components/materials/SaveMaterialButton";



import { useRouter } from "next/navigation";
import { useMarketplaceMaterials } from "@/hooks/api/useMaterials";
import { useCart } from "@/hooks/useCart";
import { useComparison } from "@/hooks/useComparison";

export const dynamic = "force-dynamic";

function getPreviewImage(material) {
	return (
		material.coverImageUrl ||
		material.thumbnailUrl ||
		material.image ||
		"/images/image1.jpg"
	);
}

function getPreviewCounts(material) {
	return {
		outcomes: Array.isArray(material.learningOutcomes)
			? material.learningOutcomes.length
			: 0,

		sections: Array.isArray(material.tableOfContents)
			? material.tableOfContents.length
			: 0,

		notes: Array.isArray(material.sampleNotes)
			? material.sampleNotes.length
			: 0,
	};
}

export default function MarketPage() {
	const { addToCart, cartItems } = useCart();
	const { addToComparison, comparedItems } = useComparison();

	const router = useRouter();

	const [searchQuery, setSearchQuery] = useState("");
	const [activeSubject, setActiveSubject] = useState("All");
	const [sortBy, setSortBy] = useState("Popular");

	const [minPrice, setMinPrice] = useState("");
	const [maxPrice, setMaxPrice] = useState("");

	const [creator, setCreator] = useState("");
	const [usageRights, setUsageRights] = useState("");

	const [currentPage, setCurrentPage] = useState(1);

	const [hydrated, setHydrated] = useState(false);

	const [subjects, setSubjects] = useState(["All"]);
	const [subjectsLoading, setSubjectsLoading] = useState(true);

	const itemsPerPage = 12;

	// Hydrate filters from URL
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);

		setSearchQuery(params.get("search") || "");
		setActiveSubject(params.get("subject") || "All");
		setSortBy(params.get("sortBy") || "Popular");

		setMinPrice(params.get("minPrice") || "");
		setMaxPrice(params.get("maxPrice") || "");

		setCreator(params.get("creator") || "");
		setUsageRights(params.get("usageRights") || "");

		setCurrentPage(Number(params.get("page") || 1));

		setHydrated(true);
	}, []);

	// Load subjects
	useEffect(() => {
		async function loadSubjects() {
			try {
				setSubjectsLoading(true);

				const res = await fetch("/api/subjects");

				if (res.ok) {
					const data = await res.json();

					setSubjects(data.subjects || ["All"]);
				}
			} catch (err) {
				console.error("Failed to load subjects:", err);

				setSubjects([
					"All",
					"Math",
					"Science",
					"Law",
					"Technology",
					"Business",
					"Medicine",
					"Arts",
				]);
			} finally {
				setSubjectsLoading(false);
			}
		}

		loadSubjects();
	}, []);

	// Sync filters to URL
	useEffect(() => {
		if (!hydrated) return;

		const params = new URLSearchParams();

		if (searchQuery) params.set("search", searchQuery);

		if (activeSubject !== "All") {
			params.set("subject", activeSubject);
		}

		if (sortBy !== "Popular") {
			params.set("sortBy", sortBy);
		}

		if (minPrice) params.set("minPrice", minPrice);

		if (maxPrice) params.set("maxPrice", maxPrice);

		if (creator) params.set("creator", creator);

		if (usageRights) params.set("usageRights", usageRights);

		if (currentPage > 1) {
			params.set("page", String(currentPage));
		}

		router.replace(`/marketplace?${params.toString()}`);
	}, [
		hydrated,
		searchQuery,
		activeSubject,
		sortBy,
		minPrice,
		maxPrice,
		creator,
		usageRights,
		currentPage,
		router,
	]);

	const { data, isLoading, isError, error } =
		useMarketplaceMaterials({
			search: searchQuery,

			subject:
				activeSubject !== "All"
					? activeSubject
					: undefined,

			sortBy:
				sortBy === "Popular"
					? "popular"
					: sortBy === "Price: Low to High"
					? "price_asc"
					: sortBy === "Price: High to Low"
					? "price_desc"
					: undefined,

			minPrice: minPrice || undefined,
			maxPrice: maxPrice || undefined,

			creator: creator || undefined,

			usageRights: usageRights || undefined,

			page: currentPage,
			pageSize: itemsPerPage,
		});

	const materials = data?.items || [];
	const totalPages = data?.totalPages || 1;

	const getFileIcon = (type) => {
		switch (type) {
			case "pdf":
				return <FaFilePdf className="text-red-500" />;

			case "doc":
				return <FaFileWord className="text-blue-500" />;

			case "ppt":
				return (
					<FaFilePowerpoint className="text-orange-500" />
				);

			default:
				return <FaFilePdf className="text-gray-500" />;
		}
	};

	const resetFilters = () => {
		setSearchQuery("");
		setActiveSubject("All");
		setSortBy("Popular");

		setMinPrice("");
		setMaxPrice("");

		setCreator("");
		setUsageRights("");

		setCurrentPage(1);
	};

	return (
		<>
			<Navbar />

			<section className="flex flex-col lg:flex-row min-h-screen bg-[#fffaf6]">
				{/* Mobile Subjects */}
				<div className="lg:hidden w-full overflow-x-auto bg-white border-b border-gray-200 px-4 py-3 hide-scrollbar flex gap-2">
					{subjectsLoading ? (
						<div className="px-4 py-1.5 text-sm text-gray-500">
							Loading subjects...
						</div>
					) : (
						subjects.map((subject) => (
							<button
								key={subject}
								onClick={() => {
									setActiveSubject(subject);
									setCurrentPage(1);
								}}
								className={`whitespace-nowrap px-4 py-1.5 rounded-full text-sm transition-all ${
									activeSubject === subject
										? "bg-blue-600 text-white font-medium shadow-sm"
										: "bg-gray-100 text-gray-600 hover:bg-gray-200"
								}`}
							>
								{subject}
							</button>
						))
					)}
				</div>

				{/* Sidebar */}
				<aside className="hidden lg:block w-72 bg-white border-r border-gray-200 px-6 py-10 sticky top-0 h-screen overflow-y-auto">
					<h3 className="text-sm font-bold text-gray-900 mb-6 uppercase tracking-wider">
						Subjects
					</h3>

					<ul className="space-y-1">
						{subjectsLoading ? (
							<li>
								<div className="px-3 py-2 text-sm text-gray-500">
									Loading subjects...
								</div>
							</li>
						) : (
							subjects.map((subject) => (
								<li key={subject}>
									<button
										onClick={() => {
											setActiveSubject(subject);
											setCurrentPage(1);
										}}
										className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-all ${
											activeSubject === subject
												? "bg-blue-50 text-blue-700 font-semibold"
												: "text-gray-600 hover:bg-gray-50 hover:text-gray-900"
										}`}
									>
										{subject}
									</button>
								</li>
							))
						)}
					</ul>
				</aside>

				{/* Main */}
				<main className="flex-1 px-4 md:px-8 py-8 md:py-10 overflow-x-hidden">
					{/* Hero */}
					<motion.div
						initial={{ opacity: 0, y: 10 }}
						animate={{ opacity: 1, y: 0 }}
						transition={{ duration: 0.4 }}
						className="bg-linear-to-r from-blue-50 to-indigo-50 border border-blue-100 rounded-2xl p-6 mb-8"
					>
						<h1 className="text-xl md:text-2xl font-bold text-gray-900 mb-2">
							Academic Marketplace
						</h1>

						<p className="text-gray-600 text-sm mb-4">
							Search by title, description,
							and author.
						</p>

						<button className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg text-sm font-semibold transition-all shadow-sm">
							Share Your Notes
						</button>
					</motion.div>

					{/* Filters */}
					<div className="bg-white p-4 rounded-xl border border-gray-200 shadow-sm mb-8 flex flex-col md:flex-row gap-4 items-center justify-between">
						<div className="relative w-full md:max-w-md">
							<FaSearch className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />

							<input
								type="text"
								placeholder="Search materials..."
								value={searchQuery}
								onChange={(e) => {
									setSearchQuery(e.target.value);
									setCurrentPage(1);
								}}
								className="w-full pl-10 pr-4 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm"
							/>
						</div>

						<div className="flex items-center gap-3 overflow-x-auto">
							<div className="flex items-center bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
								<FaFilter className="text-gray-400 mr-2 text-xs" />

								<select
									value={activeSubject}
									onChange={(e) => {
										setActiveSubject(
											e.target.value
										);

										setCurrentPage(1);
									}}
									className="bg-transparent text-sm"
								>
									<option value="All">
										All Subjects
									</option>

									{subjects.slice(1).map(
										(subject) => (
											<option
												key={subject}
												value={subject}
											>
												{subject}
											</option>
										)
									)}
								</select>
							</div>

							<div className="flex items-center bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
								<span className="text-gray-500 text-sm mr-2">
									Sort:
								</span>

								<select
									value={sortBy}
									onChange={(e) =>
										setSortBy(
											e.target.value
										)
									}
									className="bg-transparent text-sm"
								>
									<option>Popular</option>
									<option>
										Price: Low to High
									</option>
									<option>
										Price: High to Low
									</option>
								</select>
							</div>
						</div>
					</div>

					{/* Loading */}
					{isLoading ? (
						<div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5">
							{Array.from({
								length: itemsPerPage,
							}).map((_, i) => (
								<div
									key={i}
									className="bg-white rounded-xl border border-gray-200 p-5 animate-pulse h-56"
								/>
							))}
						</div>
					) : isError ? (
						<div className="bg-white rounded-2xl border border-gray-200 py-20 px-6 text-center shadow-sm">
							<h3 className="text-lg font-bold text-red-600 mb-2">
								Error loading materials
							</h3>

							<p className="text-gray-500 mb-4">
								{error?.message ||
									"Something went wrong."}
							</p>
						</div>
					) : materials.length === 0 ? (
						<div className="bg-white rounded-2xl border border-gray-200 py-20 px-6 text-center shadow-sm">
							<h3 className="text-lg font-bold text-gray-900 mb-2">
								No materials found
							</h3>

							<button
								onClick={resetFilters}
								className="text-blue-600 font-medium text-sm hover:underline"
							>
								Clear all filters
							</button>
						</div>
					) : (
						<>
							<div className="flex justify-between items-end mb-4 px-1">
								<h2 className="text-lg font-bold text-gray-800">
									{activeSubject === "All"
										? "All Materials"
										: `${activeSubject} Materials`}
								</h2>

								<span className="text-sm text-gray-500">
									{data?.total || 0} results
								</span>
							</div>

							<motion.div
								initial={{ opacity: 0 }}
								animate={{ opacity: 1 }}
								transition={{
									duration: 0.4,
								}}
								className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5"
							>
								{materials.map((material) => {
									const materialId =
										material._id ||
										material.id;

									const isAlreadyInCart =
										cartItems.some(
											(item) =>
												(item._id ||
													item.id) ===
												materialId
										);

									const isAlreadyInComp =
										comparedItems.some(
											(item) =>
												(item._id ||
													item.id) ===
												materialId
										);

									const creatorAddress =
										material.userAddress ||
										material.ownerAddress ||
										"default";

									return (
										<article
											key={materialId}
											className="relative bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md hover:border-blue-300 transition-all duration-300 flex flex-col group"
										>
											<SaveMaterialButton
												material={
													material
												}
											/>

											<Link
												href={`/marketplace/${materialId}`}
												className="relative w-full h-28 bg-gray-100 overflow-hidden block"
											>
												<Image
													src={getPreviewImage(
														material
													)}
													alt={
														material.title
													}
													fill
													className="object-cover group-hover:scale-105 transition-transform duration-500"
												/>
											</Link>

											<div className="p-4 flex-1 flex flex-col">
												<Link
													href={`/marketplace/${materialId}`}
												>
													<h3 className="text-sm font-bold text-gray-900 mb-1 line-clamp-2">
														{
															material.title
														}
													</h3>
												</Link>

												<p className="text-xs text-gray-500 mb-1">
													by{" "}
													<Link
														href={`/creator/${creatorAddress}`}
														className="font-semibold text-blue-600 hover:underline"
													>
														{material.author ||
															"Anonymous"}
													</Link>
												</p>

												<p className="text-xs text-gray-500 mb-3 line-clamp-2">
													{material.shortSummary ||
														material.description ||
														"No description"}
												</p>

												<div className="mt-auto pt-3 border-t border-gray-100 flex justify-between items-center">
													<div className="flex items-center text-xs text-gray-500 gap-3">
														<span className="flex items-center gap-1">
															{getFileIcon(
																material.fileType
															)}

															<span className="uppercase">
																{material.fileType ||
																	"pdf"}
															</span>
														</span>

														<div className="flex items-center gap-1">
															<FaHeart className="text-gray-400" />

															<span>
																{material.likes ||
																	0}
															</span>
														</div>

														{material.pages && (
															<div className="flex items-center gap-1">
																<FaRegClock className="text-gray-400" />

																<span>
																	{
																		material.pages
																	}{" "}
																	pgs
																</span>
															</div>
														)}
													</div>

													<div className="bg-blue-50 text-blue-700 px-2.5 py-1 rounded-md text-sm font-bold border border-blue-100">
														{
															material.price
														}

														<span className="text-[10px] font-medium text-blue-500 ml-1">
															XLM
														</span>
													</div>
												</div>

												<div className="mt-2 flex justify-between text-xs text-gray-500 pb-3 border-b border-gray-100">
													<span>
														{
															material.subject
														}
													</span>

													<span>
														<FaStar className="inline text-yellow-500 mr-0.5" />

														{material.rating ||
															4.8}
													</span>
												</div>

												<div className="grid grid-cols-2 gap-2 mt-3">
													<button
														onClick={() =>
															addToComparison(
																material
															)
														}
														className={`flex items-center justify-center gap-1 py-1.5 rounded-lg font-bold text-[10px] border ${
															isAlreadyInComp
																? "bg-amber-500 border-amber-600 text-white"
																: "bg-white border-gray-200 text-gray-600 hover:bg-gray-50"
														}`}
													>
														<FaExchangeAlt className="w-2.5 h-2.5" />

														{isAlreadyInComp
															? "Contrasted"
															: "Contrast"}
													</button>

													<button
														onClick={() =>
															addToCart(
																material
															)
														}
														className={`flex items-center justify-center gap-1 py-1.5 rounded-lg font-bold text-[10px] border ${
															isAlreadyInCart
																? "bg-emerald-600 border-emerald-700 text-white"
																: "bg-blue-600 hover:bg-blue-700 border-blue-700 text-white"
														}`}
													>
														<FaShoppingCart className="w-2.5 h-2.5" />

														{isAlreadyInCart
															? "In Cart"
															: "Add to Cart"}
													</button>
												</div>
											</div>
										</article>
									);
								})}

							<motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-5 relative z-10">
{materials.map((material) => {
	const materialId = material._id || material.id;
	const isAlreadyInCart = cartItems.some(
		(item) => (item._id || item.id) === materialId
	);
	const isAlreadyInComp = comparedItems.some(
		(item) => (item._id || item.id) === materialId
	);

	const creatorAddress =
		material.userAddress ||
		material.ownerAddress ||
		"GCS7TA6CS7TA6CS7TA6CS7TA6CS7TA6CS7TA6CS7TA6CS7TA";

	return (
		<article
			key={materialId}
			className="relative bg-white border border-gray-200 rounded-xl overflow-hidden shadow-sm hover:shadow-md hover:border-blue-300 transition-all duration-300 flex flex-col group"
		>
			<SaveMaterialButton material={material} />

			<Link
				href={`/marketplace/${materialId}`}
				className="relative w-full h-28 bg-gray-100 overflow-hidden block"
			>
				<Image
					src={
						material.image ||
						material.thumbnailUrl ||
						getPreviewImage(material) ||
						"/images/image1.jpg"
					}
					alt={material.title}
					fill
					className="object-cover group-hover:scale-105 transition-transform duration-500"
				/>
			</Link>

			<div className="p-4 flex-1 flex flex-col">
				<Link href={`/marketplace/${materialId}`}>
					<h3 className="text-sm font-bold text-gray-900 mb-1 line-clamp-2 leading-tight group-hover:text-blue-600 transition-colors">
						{material.title}
					</h3>
				</Link>

				<p className="text-xs text-gray-500 mb-1">
					by{" "}
					<Link
						href={`/creator/${creatorAddress}`}
						className="font-semibold text-blue-600 hover:underline transition-colors"
					>
						{material.author || "Anonymous"}
					</Link>
				</p>

				<p className="text-xs text-gray-500 mb-3 line-clamp-2">
					{material.shortSummary ||
						material.description ||
						"Creator preview not shared yet."}
				</p>

				<div className="mb-3 grid grid-cols-3 gap-2">
					<div className="rounded-lg border border-gray-100 bg-gray-50 px-2 py-2">
						<p className="text-[10px] uppercase tracking-wide text-gray-400">
							Cover
						</p>
						<p className="mt-1 text-[11px] font-semibold text-gray-700">
							{material.coverImageUrl ||
							material.thumbnailUrl ||
							material.image
								? "Available"
								: "Missing"}
						</p>
					</div>

					<div className="rounded-lg border border-gray-100 bg-gray-50 px-2 py-2">
						<p className="text-[10px] uppercase tracking-wide text-gray-400">
							Outcomes
						</p>
						<p className="mt-1 text-[11px] font-semibold text-gray-700">
							{getPreviewCounts(material).outcomes || "None"}
						</p>
					</div>

					<div className="rounded-lg border border-gray-100 bg-gray-50 px-2 py-2">
						<p className="text-[10px] uppercase tracking-wide text-gray-400">
							TOC
						</p>
						<p className="mt-1 text-[11px] font-semibold text-gray-700">
							{getPreviewCounts(material).sections || "None"}
						</p>
					</div>
				</div>

				<div className="mt-auto pt-3 border-t border-gray-100 flex justify-between items-center">
					<div className="flex items-center text-xs text-gray-500 gap-3">
						<span className="flex items-center gap-1">
							<FaFilePdf className="text-red-500" />
							<span className="uppercase">
								{material.fileType || "PDF"}
							</span>
						</span>

						<div className="flex items-center gap-1">
							<FaHeart className="text-gray-400" />
							<span>{material.likes || 0}</span>
						</div>

						{material.pages && (
							<div className="flex items-center gap-1">
								<FaRegClock className="text-gray-400" />
								<span>{material.pages} pgs</span>
							</div>
						)}
					</div>

					<div className="bg-blue-50 text-blue-700 px-2.5 py-1 rounded-md text-sm font-bold shadow-sm border border-blue-100">
						{material.price}{" "}
						<span className="text-[10px] font-medium text-blue-500">
							XLM
						</span>
					</div>
				</div>

				<div className="mt-2 flex justify-between text-xs text-gray-500 pb-3 border-b border-gray-100">
					<span>{material.subject}</span>

					<span>
						<FaStar className="inline text-yellow-500 mr-0.5" />{" "}
						{material.rating || 4.8}
					</span>
				</div>

				<div className="grid grid-cols-2 gap-2 mt-3">
					<button
						onClick={() => addToComparison(material)}
						className={`flex items-center justify-center gap-1 py-1.5 rounded-lg font-bold text-[10px] transition-all border cursor-pointer ${
							isAlreadyInComp
								? "bg-amber-500 border-amber-600 text-white shadow-xs"
								: "bg-white hover:bg-gray-50 border-gray-200 text-gray-600"
						}`}
					>
						<FaExchangeAlt className="w-2.5 h-2.5" />

						{isAlreadyInComp ? "Contrasted" : "Contrast"}
					</button>

					<button
						onClick={() => addToCart(material)}
						className={`flex items-center justify-center gap-1 py-1.5 rounded-lg font-bold text-[10px] transition-all border cursor-pointer ${
							isAlreadyInCart
								? "bg-emerald-600 border-emerald-700 text-white shadow-xs"
								: "bg-blue-600 hover:bg-blue-700 border-blue-700 text-white shadow-xs"
						}`}
					>
						<FaShoppingCart className="w-2.5 h-2.5" />

						{isAlreadyInCart ? "In Cart" : "Add to Cart"}
					</button>
				</div>
			</div>
		</article>
	);
})}

							</motion.div>

							{/* Pagination */}
							{totalPages > 1 && (
								<div className="flex justify-center mt-8 gap-2">
									{Array.from({
										length: totalPages,
									}).map((_, i) => (
										<button
											key={i}
											onClick={() =>
												setCurrentPage(
													i + 1
												)
											}
											className={`px-3 py-1.5 rounded ${
												currentPage ===
												i + 1
													? "bg-blue-600 text-white"
													: "bg-gray-100 text-gray-700 hover:bg-gray-200"
											}`}
										>
											{i + 1}
										</button>
									))}
								</div>
							)}
						</>
					)}
				</main>
			</section>
		</>
	);
}