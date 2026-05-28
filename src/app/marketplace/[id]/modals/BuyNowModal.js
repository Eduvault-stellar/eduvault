"use client";

import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { FaTimes, FaCheckCircle, FaSpinner, FaExclamationTriangle, FaExternalLinkAlt, FaShoppingBag } from "react-icons/fa";
import Web3TransactionFallback from "@/components/web3/Web3TransactionFallback";
import ConnectWalletModal from "./ConnectWalletModal";
import { useCreatePurchase } from "@/hooks/api/usePurchases";
import { useAccount } from "wagmi";

const SUPPORTED_ASSETS = [
    { code: "XLM", issuer: null, label: "Stellar XLM" },
    { code: "USDC", issuer: "G...USDCISSUER", label: "USDC (Stellar)" },
];

function useQuote(materialId, asset, price) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(null);
    const [quote, setQuote] = useState(null);

    useEffect(() => {
        if (!materialId || !asset) return;
        setLoading(true);
        setError(null);
        setTimeout(() => {
            if (asset.code === "XLM") setQuote({ amount: price, asset: "XLM", fee: 0.1 });
            else if (asset.code === "USDC") setQuote({ amount: (parseFloat(price) * 0.5).toFixed(2), asset: "USDC", fee: 0.05 });
            else setQuote(null);
            setLoading(false);
        }, 700);
    }, [materialId, asset, price]);

    return { loading, error, quote, refresh: () => setQuote(null) };
}

export default function BuyNowModal({ isOpen, onClose, price, materialId, materialTitle, materialCreator }) {
    const { address } = useAccount();
    const createPurchaseMutation = useCreatePurchase();
    const [showWallet, setShowWallet] = useState(false);
    const [email, setEmail] = useState("");
    const [purchaseStatus, setPurchaseStatus] = useState("idle"); // idle | pending | success | failed
    const [web3Error, setWeb3Error] = useState(null);
    const [selectedAsset, setSelectedAsset] = useState(SUPPORTED_ASSETS[0]);
    const [purchaseResult, setPurchaseResult] = useState(null);
    const { loading: quoteLoading, error: quoteError, quote, refresh } = useQuote(materialId, selectedAsset, price);

    const handlePay = async () => {
        if (!address) {
            setShowWallet(true);
            return;
        }

        setPurchaseStatus("pending");
        setWeb3Error(null);

        try {
            const simulatedHash = "simulated_hash_" + Math.random().toString(36).substring(7);

            const result = await createPurchaseMutation.mutateAsync({
                buyerAddress: address,
                materialId,
                transactionHash: simulatedHash,
                email,
            });

            setPurchaseResult({
                materialId,
                transactionHash: simulatedHash,
                amount: quote?.amount || price,
                asset: quote?.asset || "XLM",
                purchasedAt: new Date().toISOString(),
                title: materialTitle || `Material #${materialId}`,
                creator: materialCreator || "Unknown",
            });

            setPurchaseStatus("success");
        } catch (err) {
            console.error("Purchase failed:", err);
            setPurchaseStatus("failed");
            setWeb3Error(err instanceof Error ? err : new Error("Purchase failed. Please try again."));
        }
    };

    const handleRetry = () => {
        setPurchaseStatus("idle");
        setWeb3Error(null);
        setPurchaseResult(null);
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <>
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 0.5 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black backdrop-blur-sm z-40"
                        onClick={onClose}
                    />

                    <motion.div
                        initial={{ opacity: 0, scale: 0.9, y: 50 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.9, y: 50 }}
                        className="fixed inset-0 flex items-center justify-center z-50"
                    >
                        <div className="bg-white rounded-2xl shadow-lg w-[90%] max-w-sm p-6 relative">
                            <button
                                onClick={onClose}
                                className="absolute top-4 right-4 text-gray-400 hover:text-gray-600"
                            >
                                <FaTimes />
                            </button>

                            {/* Pending State */}
                            {purchaseStatus === "pending" && (
                                <div className="py-8 text-center">
                                    <div className="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4">
                                        <FaSpinner className="text-blue-500 text-3xl animate-spin" />
                                    </div>
                                    <h2 className="text-xl font-bold text-gray-900 mb-2">Processing Purchase</h2>
                                    <div className="space-y-2 mb-6">
                                        <p className="text-sm text-gray-500">
                                            Confirming your transaction on the Stellar network...
                                        </p>
                                        {materialTitle && (
                                            <p className="text-xs text-gray-400 font-medium">
                                                {materialTitle}
                                            </p>
                                        )}
                                        {quote && (
                                            <p className="text-sm font-semibold text-gray-700">
                                                {quote.amount} {quote.asset}
                                            </p>
                                        )}
                                    </div>
                                    <div className="flex justify-center gap-1">
                                        <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: "0s" }} />
                                        <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: "0.15s" }} />
                                        <div className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: "0.3s" }} />
                                    </div>
                                </div>
                            )}

                            {/* Success State */}
                            {purchaseStatus === "success" && purchaseResult && (
                                <div className="py-4">
                                    <div className="text-center mb-5">
                                        <div className="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-3">
                                            <FaCheckCircle className="text-green-500 text-3xl" />
                                        </div>
                                        <h2 className="text-xl font-bold text-gray-900 mb-1">Purchase Successful!</h2>
                                        <p className="text-sm text-gray-500">
                                            Your material has been added to your library.
                                        </p>
                                    </div>

                                    <div className="bg-green-50 border border-green-200 rounded-xl p-4 space-y-3 mb-5">
                                        <div className="flex justify-between items-center">
                                            <span className="text-xs text-gray-500">Material</span>
                                            <span className="text-sm font-medium text-gray-900 text-right max-w-[60%] truncate">
                                                {purchaseResult.title}
                                            </span>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <span className="text-xs text-gray-500">Creator</span>
                                            <span className="text-sm text-gray-700">{purchaseResult.creator}</span>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <span className="text-xs text-gray-500">Amount</span>
                                            <span className="text-sm font-semibold text-gray-900">
                                                {purchaseResult.amount} {purchaseResult.asset}
                                            </span>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <span className="text-xs text-gray-500">Status</span>
                                            <span className="text-xs font-medium text-green-700 flex items-center gap-1">
                                                <FaCheckCircle size={10} /> Confirmed
                                            </span>
                                        </div>
                                        <div className="flex justify-between items-center">
                                            <span className="text-xs text-gray-500">Date</span>
                                            <span className="text-xs text-gray-600">
                                                {new Date(purchaseResult.purchasedAt).toLocaleDateString()}
                                            </span>
                                        </div>
                                        {purchaseResult.transactionHash && (
                                            <div className="pt-2 border-t border-green-200">
                                                <div className="flex justify-between items-center">
                                                    <span className="text-xs text-gray-500">Transaction</span>
                                                    <a
                                                        href={`https://stellar.expert/explorer/testnet/tx/${purchaseResult.transactionHash}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="text-xs text-blue-600 hover:text-blue-800 flex items-center gap-1"
                                                    >
                                                        View on Explorer <FaExternalLinkAlt size={10} />
                                                    </a>
                                                </div>
                                            </div>
                                        )}
                                    </div>

                                    <div className="flex flex-col gap-2">
                                        <a
                                            href="/dashboard/purchases"
                                            className="w-full flex items-center justify-center gap-2 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold text-sm transition-all"
                                        >
                                            <FaShoppingBag size={14} />
                                            Go to My Purchases
                                        </a>
                                        <a
                                            href={`/marketplace/${materialId}`}
                                            className="w-full text-center py-2 text-sm text-blue-600 hover:text-blue-800 font-medium"
                                        >
                                            View Material Details
                                        </a>
                                    </div>
                                </div>
                            )}

                            {/* Failed State */}
                            {purchaseStatus === "failed" && (
                                <div className="py-6 text-center">
                                    <div className="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4">
                                        <FaExclamationTriangle className="text-red-500 text-3xl" />
                                    </div>
                                    <h2 className="text-xl font-bold text-gray-900 mb-2">Purchase Failed</h2>
                                    <p className="text-sm text-gray-500 mb-6">
                                        We couldn&apos;t complete your purchase. Please try again.
                                    </p>

                                    {web3Error && (
                                        <Web3TransactionFallback
                                            error={web3Error}
                                            compact
                                            onRetry={() => {
                                                setWeb3Error(null);
                                                handlePay();
                                            }}
                                        />
                                    )}

                                    <div className="flex gap-3 mt-4">
                                        <button
                                            onClick={handleRetry}
                                            className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-semibold text-sm transition-all"
                                        >
                                            Try Again
                                        </button>
                                        <button
                                            onClick={onClose}
                                            className="flex-1 py-2.5 border border-gray-300 text-gray-700 rounded-lg font-semibold text-sm hover:bg-gray-50 transition-all"
                                        >
                                            Close
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* Idle State - Payment Form */}
                            {purchaseStatus === "idle" && (
                                <>
                                    <h2 className="text-lg font-bold text-gray-900 mb-1 text-center">
                                        Buy Now
                                    </h2>
                                    <p className="text-sm text-gray-500 mb-6 text-center">
                                        We&apos;ll send the document to your email.
                                    </p>

                                    {materialTitle && (
                                        <div className="mb-4 p-3 bg-gray-50 border border-gray-200 rounded-lg">
                                            <p className="text-xs text-gray-500 mb-1">Material</p>
                                            <p className="text-sm font-medium text-gray-900">{materialTitle}</p>
                                            {materialCreator && (
                                                <p className="text-xs text-gray-400 mt-1">by {materialCreator}</p>
                                            )}
                                        </div>
                                    )}

                                    <div className="mb-4">
                                        <label className="block text-xs font-semibold text-gray-600 mb-2">
                                            EMAIL ADDRESS
                                        </label>
                                        <input
                                            type="email"
                                            value={email}
                                            onChange={(e) => setEmail(e.target.value)}
                                            placeholder="Enter your email"
                                            className="w-full border border-gray-300 rounded-lg py-2 px-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
                                        />
                                    </div>

                                    <div className="mb-4">
                                        <label className="block text-xs font-semibold text-gray-600 mb-2">PAYMENT ASSET</label>
                                        <select
                                            value={selectedAsset.code}
                                            onChange={e => setSelectedAsset(SUPPORTED_ASSETS.find(a => a.code === e.target.value))}
                                            className="w-full border border-gray-300 rounded-lg py-2 px-3 text-sm focus:outline-none"
                                        >
                                            {SUPPORTED_ASSETS.map(asset => (
                                                <option key={asset.code} value={asset.code}>{asset.label}</option>
                                            ))}
                                        </select>
                                    </div>

                                    <div className="flex justify-between items-center mb-5 text-sm">
                                        <span className="text-gray-600">You will pay</span>
                                        {quoteLoading ? (
                                            <span className="text-gray-400">Loading quote...</span>
                                        ) : quoteError ? (
                                            <span className="text-red-500">Error loading quote</span>
                                        ) : quote ? (
                                            <div className="flex items-center gap-2 font-semibold text-gray-800">
                                                {quote.amount} {quote.asset}
                                                {quote.fee && <span className="text-xs text-gray-400">+{quote.fee} fee</span>}
                                            </div>
                                        ) : (
                                            <span className="text-gray-400">No quote available</span>
                                        )}
                                        <button onClick={refresh} className="ml-2 text-xs text-blue-600 underline">Refresh</button>
                                    </div>

                                    {web3Error && (
                                        <Web3TransactionFallback
                                            error={web3Error}
                                            compact
                                            onRetry={handlePay}
                                        />
                                    )}

                                    <button
                                        onClick={handlePay}
                                        disabled={createPurchaseMutation.isPending || quoteLoading || !quote}
                                        className="w-full bg-blue-600 hover:bg-blue-700 text-white py-2.5 rounded-lg font-semibold text-sm transition-all disabled:opacity-60"
                                    >
                                        {createPurchaseMutation.isPending ? "Processing..." : "Pay with Wallet"}
                                    </button>
                                </>
                            )}
                        </div>
                    </motion.div>

                    <ConnectWalletModal
                        isOpen={showWallet}
                        onClose={() => setShowWallet(false)}
                    />
                </>
            )}
        </AnimatePresence>
    );
}
