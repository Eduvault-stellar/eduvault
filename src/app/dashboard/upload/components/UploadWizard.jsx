"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
  FaArrowLeft,
  FaArrowRight,
  FaCheck,
  FaCloudUploadAlt,
  FaDollarSign,
  FaExclamationTriangle,
  FaExternalLinkAlt,
  FaEye,
  FaFileAlt,
  FaSpinner,
  FaTags,
} from "react-icons/fa";
import {
  useAccount,
  useSwitchChain,
  useWaitForTransactionReceipt,
  useWriteContract,
} from "wagmi";
import { celoSepolia } from "wagmi/chains";
import { decodeEventLog, parseAbiItem } from "viem";

import { abi } from "../../../../../contracts/EduVaultAbi.js";
import {
  useCreateMaterial,
  useUploadFile,
} from "@/hooks/api/useMaterials";
import TransactionStatusPanel from "@/components/transactions/TransactionStatusPanel";
import { useTransactionCenter } from "@/providers/TransactionProvider";
import { TransactionStatus } from "@/lib/transactions/transaction";
import { isUploadChain } from "@/lib/web3/chains";

const contractAddress =
  process.env.NEXT_PUBLIC_UPLOAD_CONTRACT_ADDRESS ??
  "0x3f48520ca0d8d51345b416b5a3e083dac8790f55";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
);

const STEPS = [
  {
    id: 1,
    title: "Upload Files",
    icon: FaFileAlt,
    description: "Add your document and thumbnail",
  },
  {
    id: 2,
    title: "Details",
    icon: FaTags,
    description: "Title and description",
  },
  {
    id: 3,
    title: "Pricing & Rights",
    icon: FaDollarSign,
    description: "Set price and usage rights",
  },
  {
    id: 4,
    title: "Review & Mint",
    icon: FaEye,
    description: "Review and publish to blockchain",
  },
];

const ALLOWED_DOC_EXTENSIONS = [
  ".pdf",
  ".doc",
  ".docx",
  ".xls",
  ".xlsx",
  ".ppt",
  ".pptx",
  ".txt",
  ".zip",
];

const ALLOWED_THUMB_EXTENSIONS = [".jpg", ".jpeg", ".png", ".webp"];

function getFileExtension(filename) {
  const dotIndex = filename.lastIndexOf(".");
  return dotIndex >= 0 ? filename.slice(dotIndex).toLowerCase() : "";
}

function getFriendlyUploadError(error) {
  const message = error?.message || "Upload failed. Please try again.";
  const normalized = message.toLowerCase();

  if (message.includes("exceeds the 10MB limit")) {
    return "The selected document exceeds the 10MB limit. Please choose a smaller file.";
  }

  if (message.includes("exceeds the 5MB limit")) {
    return "The selected thumbnail exceeds the 5MB limit. Please choose a smaller image.";
  }

  if (
    message.includes("Unsupported file type") ||
    message.includes("Unsupported file format")
  ) {
    return "The file type is not supported. Please upload a PDF, Word document, Excel sheet, PowerPoint presentation, text file, or ZIP archive.";
  }

  if (message.includes("Unsupported thumbnail type")) {
    return "The thumbnail image format is not supported. Please use JPG, PNG, or WEBP.";
  }

  if (
    normalized.includes("failed to fetch") ||
    normalized.includes("network")
  ) {
    return "Network error: Could not reach the upload server. Please check your internet connection.";
  }

  if (
    normalized.includes("too many requests") ||
    normalized.includes("rate limit") ||
    message.includes("429")
  ) {
    return "Rate limit exceeded. Please wait a moment and try again.";
  }

  return message;
}

export default function UploadWizard() {
  const { address, chainId } = useAccount();

  const {
    writeContract,
    data: txHash,
    error: writeError,
    isPending,
  } = useWriteContract();

  const {
    data: receipt,
    isLoading: isWaiting,
    isSuccess: isConfirmed,
    isError: isFailed,
  } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  const {
    switchChainAsync,
    isPending: switchingChain,
  } = useSwitchChain();

  const {
    activeTransaction,
    beginTransaction,
    markStatus,
    confirmTransaction,
    failTransaction,
    clearTransaction,
  } = useTransactionCenter();

  const uploadFileMutation = useUploadFile();
  const createMaterialMutation = useCreateMaterial();

  const [currentStep, setCurrentStep] = useState(1);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("");
  const [subject, setSubject] = useState("");
  const [price, setPrice] = useState("");
  const [usageRights, setUsageRights] = useState(
    "Standard License (download only)"
  );
  const [visibility, setVisibility] = useState("public");
  const [docFile, setDocFile] = useState(null);
  const [docFileName, setDocFileName] = useState("");
  const [thumbFile, setThumbFile] = useState(null);
  const [thumbPreview, setThumbPreview] = useState(null);

  const [categories, setCategories] = useState([]);
  const [taxonomySubjects, setTaxonomySubjects] = useState([]);

  const [workflowState, setWorkflowState] = useState("idle");
  const [error, setError] = useState(null);
  const [errorType, setErrorType] = useState(null);
  const [mintResult, setMintResult] = useState(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadResult, setUploadResult] = useState(null);

  const chainMismatch = Boolean(
    address && chainId && !isUploadChain(chainId)
  );

  const filteredSubjects = useMemo(
    () =>
      taxonomySubjects.filter(
        (taxonomySubject) =>
          !category || taxonomySubject.categoryId === category
      ),
    [category, taxonomySubjects]
  );

  useEffect(() => {
    const controller = new AbortController();

    async function loadTaxonomy() {
      try {
        const response = await fetch("/api/subjects", {
          signal: controller.signal,
        });

        if (!response.ok) {
          return;
        }

        const data = await response.json();

        if (!controller.signal.aborted) {
          setCategories(
            Array.isArray(data?.categories) ? data.categories : []
          );
          setTaxonomySubjects(
            Array.isArray(data?.subjects) ? data.subjects : []
          );
        }
      } catch (taxonomyError) {
        if (taxonomyError?.name !== "AbortError") {
          console.error("Failed to load taxonomy:", taxonomyError);
        }
      }
    }

    loadTaxonomy();

    return () => {
      controller.abort();
    };
  }, []);

  useEffect(() => {
    return () => {
      if (thumbPreview) {
        URL.revokeObjectURL(thumbPreview);
      }
    };
  }, [thumbPreview]);

  useEffect(() => {
    if (!writeError) {
      return;
    }

    let friendlyError =
      writeError.message || "Transaction failed. Please try again.";

    if (
      writeError.code === "ACTION_REJECTED" ||
      writeError.message?.includes("User rejected")
    ) {
      friendlyError = "Transaction rejected by user. Please try again.";
      setErrorType("wallet");
    } else if (
      writeError.message?.toLowerCase().includes("insufficient funds")
    ) {
      friendlyError =
        "Insufficient funds for transaction fees. Please add CELO to your wallet.";
      setErrorType("wallet");
    } else {
      setErrorType("chain");
    }

    setError(friendlyError);
    setWorkflowState("failed");

    failTransaction(writeError, {
      title: "Transaction failed",
      message: friendlyError,
      retryable: true,
    });
  }, [failTransaction, writeError]);

  useEffect(() => {
    if (!txHash || isConfirmed) {
      return;
    }

    markStatus(TransactionStatus.PendingConfirmation, {
      txHash,
      title: "Awaiting confirmation",
      message:
        "The transaction was broadcast. Waiting for network confirmation.",
    });
  }, [isConfirmed, markStatus, txHash]);

  useEffect(() => {
    if (isFailed) {
      const transactionError = new Error(
        "Transaction failed on-chain. Please try again."
      );

      setError(transactionError.message);
      setErrorType("chain");
      setWorkflowState("failed");

      failTransaction(transactionError, {
        title: "Transaction failed",
        message: transactionError.message,
        retryable: true,
      });

      return;
    }

    if (!isConfirmed || !receipt || !uploadResult) {
      return;
    }

    let cancelled = false;

    async function saveConfirmedMaterial() {
      try {
        const transferLog = receipt.logs.find((log) => {
          try {
            const decoded = decodeEventLog({
              abi: [TRANSFER_EVENT],
              data: log.data,
              topics: log.topics,
            });

            return decoded.eventName === "Transfer";
          } catch {
            return false;
          }
        });

        if (!transferLog) {
          throw new Error(
            "Transfer event not found in transaction receipt."
          );
        }

        const decodedTransfer = decodeEventLog({
          abi: [TRANSFER_EVENT],
          data: transferLog.data,
          topics: transferLog.topics,
        });

        const tokenId = decodedTransfer.args.tokenId.toString();

        const savedData = await createMaterialMutation.mutateAsync({
          title,
          description,
          category: category || undefined,
          subject: subject || undefined,
          price: price ? Number(price) : 0,
          usageRights,
          visibility,
          storageKey: uploadResult.storageKey,
          thumbnail: uploadResult.image || null,
          metadataUrl: uploadResult.metadata,
          creator: address,
          txHash: receipt.transactionHash,
          tokenId,
        });

        if (cancelled) {
          return;
        }

        setMintResult({
          tokenId,
          txHash: receipt.transactionHash,
          receipt,
          id: savedData?.id || savedData?._id,
        });

        setWorkflowState("success");

        confirmTransaction({
          txHash: receipt.transactionHash,
          title: "Material published",
          message: "Your material is now available in the marketplace.",
        });
      } catch (saveError) {
        if (cancelled) {
          return;
        }

        const message =
          saveError?.message ||
          "Mint completed but database registration failed.";

        console.error("Material persistence error:", saveError);
        setError(message);
        setErrorType("database");
        setWorkflowState("failed");

        failTransaction(
          saveError instanceof Error
            ? saveError
            : new Error(String(saveError)),
          {
            title: "Database sync failed",
            message,
            retryable: true,
          }
        );
      }
    }

    saveConfirmedMaterial();

    return () => {
      cancelled = true;
    };
  }, [
    address,
    category,
    confirmTransaction,
    createMaterialMutation,
    description,
    failTransaction,
    isConfirmed,
    isFailed,
    price,
    receipt,
    subject,
    title,
    uploadResult,
    usageRights,
    visibility,
  ]);

  const handleDocChange = (event) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setDocFile(file);
    setDocFileName(file.name);
    setError(null);
  };

  const handleThumbChange = (event) => {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setThumbFile(file);
    setThumbPreview(URL.createObjectURL(file));
    setError(null);
  };

  const handleSwitchChain = async () => {
    setError(null);

    try {
      await switchChainAsync({
        chainId: celoSepolia.id,
      });
    } catch (switchError) {
      const message = switchError?.message || "";

      if (
        switchError?.code === "ACTION_REJECTED" ||
        message.includes("User rejected")
      ) {
        setError(
          "Network switch was rejected. Please switch to Celo Sepolia to publish."
        );
      } else if (message.includes("does not support")) {
        setError(
          "Your wallet does not support automatic network switching. Please switch to Celo Sepolia manually."
        );
      } else {
        setError(
          message || "Failed to switch network. Please switch manually."
        );
      }

      setErrorType("chain");
    }
  };

  const validateStep = (step) => {
    if (step === 1) {
      if (!docFile) {
        setError("Please upload a document file.");
        return false;
      }

      if (docFile.size > 10 * 1024 * 1024) {
        setError(
          "Document file size exceeds the 10MB limit. Please select a smaller file."
        );
        return false;
      }

      const documentExtension = getFileExtension(docFile.name);

      if (!ALLOWED_DOC_EXTENSIONS.includes(documentExtension)) {
        setError(
          "Unsupported file format. Please upload a PDF, Word, Excel, PowerPoint, Text, or ZIP file."
        );
        return false;
      }

      if (thumbFile) {
        if (thumbFile.size > 5 * 1024 * 1024) {
          setError(
            "Thumbnail size exceeds the 5MB limit. Please select a smaller image."
          );
          return false;
        }

        const thumbnailExtension = getFileExtension(thumbFile.name);

        if (!ALLOWED_THUMB_EXTENSIONS.includes(thumbnailExtension)) {
          setError(
            "Unsupported thumbnail type. Please upload a JPG, PNG, or WEBP image."
          );
          return false;
        }
      }
    }

    if (step === 2 && !title.trim()) {
      setError("Please enter a document title.");
      return false;
    }

    return true;
  };

  const handleNext = () => {
    setError(null);
    setErrorType(null);

    if (validateStep(currentStep) && currentStep < STEPS.length) {
      setCurrentStep((step) => step + 1);
    }
  };

  const handlePrevious = () => {
    setError(null);

    if (currentStep > 1) {
      setCurrentStep((step) => step - 1);
    }
  };

  const handleSubmit = async () => {
    setError(null);
    setErrorType(null);

    if (!address) {
      setError("Please connect your wallet to mint an NFT.");
      setErrorType("wallet");
      return;
    }

    if (chainMismatch) {
      setError("Please switch to Celo Sepolia before publishing.");
      setErrorType("chain");
      return;
    }

    if (!validateStep(1) || !validateStep(2)) {
      return;
    }

    setWorkflowState("uploading");
    setUploadProgress(0);

    beginTransaction({
      scope: "publish",
      title: "Publishing material",
      message: "Uploading files and preparing the mint request.",
    });

    let progressInterval;

    try {
      progressInterval = window.setInterval(() => {
        setUploadProgress((current) => Math.min(current + 20, 80));
      }, 300);

      const formData = new FormData();
      formData.append("file", docFile);

      if (thumbFile) {
        formData.append("thumbnail", thumbFile);
      }

      formData.append("name", title.trim());
      formData.append("description", description.trim());
      formData.append("price", price);
      formData.append("usageRights", usageRights);
      formData.append("visibility", visibility);
      formData.append("owner", address);

      if (category) {
        formData.append("category", category);
      }

      if (subject) {
        formData.append("subject", subject);
      }

      let uploadData;
      const maxAttempts = 3;

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          uploadData = await uploadFileMutation.mutateAsync(formData);

          if (!uploadData?.metadata) {
            throw new Error(
              "File upload failed: No metadata returned."
            );
          }

          break;
        } catch (uploadError) {
          const isRetriable =
            !uploadError?.status ||
            [429, 500, 502, 503, 504].includes(uploadError.status);

          if (attempt === maxAttempts || !isRetriable) {
            throw uploadError;
          }

          const delay = 1000 * 2 ** (attempt - 1);

          setError(
            `Upload attempt ${attempt} failed. Retrying...`
          );

          await new Promise((resolve) => {
            window.setTimeout(resolve, delay);
          });

          setError(null);
        }
      }

      window.clearInterval(progressInterval);
      progressInterval = undefined;

      setUploadProgress(100);
      setUploadResult(uploadData);
      setWorkflowState("minting");

      markStatus(TransactionStatus.Signing, {
        title: "Approve mint",
        message:
          "Open your wallet and approve the mint transaction.",
      });

      writeContract({
        address: contractAddress,
        abi,
        functionName: "mint",
        args: [uploadData.metadata],
        chain: celoSepolia,
      });
    } catch (submitError) {
      if (progressInterval) {
        window.clearInterval(progressInterval);
      }

      const friendlyError = getFriendlyUploadError(submitError);

      console.error("Upload error:", submitError);
      setError(friendlyError);
      setErrorType("upload");
      setWorkflowState("failed");

      failTransaction(
        submitError instanceof Error
          ? submitError
          : new Error(String(submitError)),
        {
          title: "Publish failed",
          message: friendlyError,
          retryable: true,
        }
      );
    }
  };

  const handleReset = () => {
    setTitle("");
    setDescription("");
    setCategory("");
    setSubject("");
    setPrice("");
    setUsageRights("Standard License (download only)");
    setVisibility("public");
    setDocFile(null);
    setDocFileName("");
    setThumbFile(null);
    setThumbPreview(null);
    setCurrentStep(1);
    setWorkflowState("idle");
    setError(null);
    setErrorType(null);
    setMintResult(null);
    setUploadProgress(0);
    setUploadResult(null);
    clearTransaction();
  };

  const isSubmitting =
    workflowState === "uploading" ||
    workflowState === "minting" ||
    isPending ||
    isWaiting;

  if (workflowState === "success" && mintResult) {
    return (
      <div className="mx-auto my-4 max-w-xl rounded-xl border border-gray-200 bg-white p-8 text-center shadow-sm">
        <div className="mx-auto mb-4 flex h-16 w-16 animate-bounce items-center justify-center rounded-full bg-green-100">
          <FaCheck className="text-2xl text-green-600" />
        </div>

        <h2 className="mb-2 text-2xl font-bold text-gray-900">
          Successfully Published!
        </h2>

        <p className="mb-6 text-sm text-gray-600">
          Your educational material has been minted and registered in
          the marketplace.
        </p>

        <div className="mb-6 flex items-center gap-4 rounded-xl border border-gray-200 bg-gray-50 p-4 text-left">
          {thumbPreview ? (
            <Image
              src={thumbPreview}
              alt="Published material"
              width={64}
              height={64}
              unoptimized
              className="rounded-lg border border-gray-200 object-cover"
            />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-lg border border-gray-200 bg-blue-50 text-blue-500">
              <FaFileAlt className="text-2xl" />
            </div>
          )}

          <div className="min-w-0 flex-1">
            <h4 className="truncate text-base font-semibold text-gray-800">
              {title}
            </h4>

            <p className="mt-0.5 line-clamp-1 text-xs text-gray-500">
              {description || "No description provided."}
            </p>

            <div className="mt-2 flex gap-4 text-xs font-semibold text-gray-700">
              <span>Price: {price ? `${price} CELO` : "Free"}</span>
              <span>Rights: {usageRights}</span>
            </div>
          </div>
        </div>

        <div className="mb-8 space-y-2 rounded-lg border border-green-200 bg-green-50 p-4 text-left">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium text-green-800">
              Token ID
            </span>

            <span className="rounded bg-green-100 px-2 py-0.5 font-mono text-xs font-semibold text-green-800">
              #{mintResult.tokenId}
            </span>
          </div>

          <div className="text-sm">
            <span className="mb-1 block font-medium text-green-800">
              Transaction Hash
            </span>

            <div className="flex items-center justify-between gap-2">
              <span className="line-clamp-1 break-all font-mono text-xs text-green-700">
                {mintResult.txHash}
              </span>

              <a
                href={`https://sepolia.celoscan.io/tx/${mintResult.txHash}`}
                target="_blank"
                rel="noopener noreferrer"
                className="flex shrink-0 items-center gap-1 text-xs font-semibold text-green-800 underline hover:text-green-900"
              >
                Explorer
                <FaExternalLinkAlt className="text-[10px]" />
              </a>
            </div>
          </div>
        </div>

        <div className="flex flex-col justify-center gap-3 sm:flex-row">
          <Link
            href="/dashboard/my-materials"
            className="rounded-lg bg-blue-600 px-6 py-2.5 text-center text-sm font-medium text-white shadow-sm transition hover:bg-blue-700"
          >
            View My Materials
          </Link>

          <button
            type="button"
            onClick={handleReset}
            className="rounded-lg border border-gray-300 px-6 py-2.5 text-sm font-medium text-gray-700 transition hover:bg-gray-50"
          >
            Upload Another
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-200 p-6">
        <h2 className="mb-4 text-xl font-bold">
          Publish Educational Material
        </h2>

        <div className="mb-2 flex items-center justify-between">
          {STEPS.map((step, index) => {
            const Icon = step.icon;
            const isActive = step.id === currentStep;
            const isCompleted = step.id < currentStep;

            return (
              <div key={step.id} className="flex flex-1 items-center">
                <div className="flex flex-col items-center">
                  <div
                    className={`flex h-10 w-10 items-center justify-center rounded-full transition ${
                      isCompleted
                        ? "bg-green-600 text-white"
                        : isActive
                          ? "bg-blue-600 text-white"
                          : "bg-gray-200 text-gray-600"
                    }`}
                    title={step.description}
                  >
                    {isCompleted ? (
                      <FaCheck />
                    ) : (
                      <Icon className="text-sm" />
                    )}
                  </div>

                  <p
                    className={`mt-2 text-xs font-medium ${
                      isActive
                        ? "text-blue-600"
                        : isCompleted
                          ? "text-green-600"
                          : "text-gray-500"
                    }`}
                  >
                    {step.title}
                  </p>
                </div>

                {index < STEPS.length - 1 ? (
                  <div
                    className={`mx-2 h-0.5 flex-1 ${
                      step.id < currentStep
                        ? "bg-green-600"
                        : "bg-gray-200"
                    }`}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      {error && !chainMismatch ? (
        <div className="mx-6 mt-4 rounded-md border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-600">{error}</p>
          {errorType ? (
            <p className="mt-1 text-xs text-red-500">
              Error type: {errorType}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="mx-6 mt-4">
        <TransactionStatusPanel
          transaction={activeTransaction}
          onRetry={handleSubmit}
          onClear={clearTransaction}
        />
      </div>

      {chainMismatch ? (
        <div className="mx-6 mt-4 rounded-md border border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-3">
            <FaExclamationTriangle className="mt-0.5 shrink-0 text-amber-500" />

            <div className="flex-1">
              <p className="mb-1 text-sm font-medium text-amber-800">
                Wrong Network Detected
              </p>

              <p className="mb-3 text-xs text-amber-700">
                Publishing requires the{" "}
                <strong>Celo Sepolia</strong> network.
              </p>

              <button
                type="button"
                onClick={handleSwitchChain}
                disabled={switchingChain}
                className="rounded-md bg-amber-600 px-4 py-1.5 text-xs font-medium text-white transition hover:bg-amber-700 disabled:opacity-60"
              >
                {switchingChain
                  ? "Switching..."
                  : "Switch to Celo Sepolia"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div
        className={`min-h-[400px] p-6 ${
          isSubmitting
            ? "flex flex-col items-center justify-center"
            : ""
        }`}
      >
        {workflowState === "uploading" ? (
          <div className="w-full max-w-md space-y-6 py-8 text-center">
            <div className="relative flex items-center justify-center">
              <div className="mx-auto flex h-24 w-24 animate-pulse items-center justify-center rounded-full bg-blue-50 text-blue-600">
                <FaCloudUploadAlt className="animate-bounce text-4xl" />
              </div>

              <div className="absolute inset-0 mx-auto h-24 w-24 animate-spin rounded-full border-4 border-blue-100 border-t-blue-600" />
            </div>

            <div className="space-y-2">
              <h3 className="text-xl font-bold text-gray-900">
                Uploading Material
              </h3>

              <p className="text-sm text-gray-600">
                Uploading your document and thumbnail...
              </p>
            </div>

            <div className="w-full space-y-1">
              <div className="h-3 w-full overflow-hidden rounded-full border border-gray-200 bg-gray-100 shadow-inner">
                <div
                  className="h-full rounded-full bg-blue-600 transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>

              <div className="flex justify-between px-1 text-xs font-semibold text-gray-500">
                <span>Storing files...</span>
                <span>{uploadProgress}%</span>
              </div>
            </div>
          </div>
        ) : null}

        {workflowState === "minting" ? (
          <div className="w-full max-w-md space-y-6 py-8 text-center">
            <div className="relative flex items-center justify-center">
              <div className="mx-auto flex h-24 w-24 animate-pulse items-center justify-center rounded-full bg-purple-50 text-purple-600">
                <FaSpinner className="animate-spin text-4xl" />
              </div>
            </div>

            <div className="space-y-2">
              <h3 className="text-xl font-bold text-gray-900">
                Minting NFT on Celo
              </h3>

              <p className="text-sm text-gray-600">
                Confirm the transaction in your connected wallet.
              </p>
            </div>
          </div>
        ) : null}

        {!isSubmitting ? (
          <>
            {currentStep === 1 ? (
              <div className="space-y-6">
                <div>
                  <h3 className="mb-2 text-lg font-semibold">
                    Upload Your Document
                  </h3>

                  <p className="mb-4 text-sm text-gray-600">
                    Supported formats: PDF, DOCX, PPTX, XLSX, TXT, and
                    ZIP. Maximum size: 10MB.
                  </p>
                </div>

                <div className="rounded-lg border-2 border-dashed border-gray-300 p-8 text-center transition hover:border-blue-400">
                  <input
                    type="file"
                    id="file-upload"
                    className="hidden"
                    onChange={handleDocChange}
                    accept={ALLOWED_DOC_EXTENSIONS.join(",")}
                  />

                  <label
                    htmlFor="file-upload"
                    className="flex cursor-pointer flex-col items-center"
                  >
                    <FaCloudUploadAlt className="mb-3 text-5xl text-blue-500" />

                    <p className="mb-1 text-base font-medium text-gray-800">
                      {docFileName || "Tap to Upload Document"}
                    </p>

                    <p className="mb-4 text-sm text-gray-500">
                      {docFileName
                        ? "Click to change file"
                        : "Maximum file size: 10MB"}
                    </p>

                    <span className="rounded-md bg-blue-600 px-6 py-2 text-white hover:bg-blue-700">
                      Choose File
                    </span>
                  </label>
                </div>

                <div>
                  <label
                    htmlFor="thumbnail-upload"
                    className="mb-2 block text-sm font-medium"
                  >
                    Thumbnail Image (Optional)
                  </label>

                  <div className="flex items-center gap-4">
                    <input
                      id="thumbnail-upload"
                      type="file"
                      accept={ALLOWED_THUMB_EXTENSIONS.join(",")}
                      onChange={handleThumbChange}
                      className="text-sm"
                    />

                    {thumbPreview ? (
                      <Image
                        src={thumbPreview}
                        alt="Thumbnail preview"
                        width={64}
                        height={64}
                        unoptimized
                        className="rounded border object-cover"
                      />
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}

            {currentStep === 2 ? (
              <div className="space-y-5">
                <div>
                  <h3 className="mb-2 text-lg font-semibold">
                    Material Details
                  </h3>

                  <p className="mb-4 text-sm text-gray-600">
                    Provide information that helps students discover
                    your material.
                  </p>
                </div>

                <div>
                  <label
                    htmlFor="material-title"
                    className="mb-2 block text-sm font-medium"
                  >
                    Document Title *
                  </label>

                  <input
                    id="material-title"
                    type="text"
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder="e.g. Development Economics Lecture Notes"
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                </div>

                <div>
                  <label
                    htmlFor="material-description"
                    className="mb-2 block text-sm font-medium"
                  >
                    Short Description
                  </label>

                  <textarea
                    id="material-description"
                    value={description}
                    onChange={(event) =>
                      setDescription(event.target.value)
                    }
                    placeholder="Describe the material..."
                    rows={4}
                    className="w-full resize-none rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  />
                </div>

                <div>
                  <label
                    htmlFor="material-category"
                    className="mb-2 block text-sm font-medium"
                  >
                    Category
                  </label>

                  <select
                    id="material-category"
                    value={category}
                    onChange={(event) => {
                      setCategory(event.target.value);
                      setSubject("");
                    }}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                  >
                    <option value="">Select a category</option>

                    {categories.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="material-subject"
                    className="mb-2 block text-sm font-medium"
                  >
                    Subject
                  </label>

                  <select
                    id="material-subject"
                    value={subject}
                    onChange={(event) =>
                      setSubject(event.target.value)
                    }
                    disabled={!category}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="">Select a subject</option>

                    {filteredSubjects.map((item) => (
                      <option key={item.id} value={item.label}>
                        {item.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            ) : null}

            {currentStep === 3 ? (
              <div className="space-y-5">
                <div>
                  <h3 className="mb-2 text-lg font-semibold">
                    Pricing & Usage Rights
                  </h3>

                  <p className="mb-4 text-sm text-gray-600">
                    Set your price and define how others can use your
                    material.
                  </p>
                </div>

                <div className="grid gap-3 md:grid-cols-2">
                  <div>
                    <label
                      htmlFor="material-price"
                      className="mb-2 block text-sm font-medium"
                    >
                      Price (CELO) - Optional
                    </label>

                    <input
                      id="material-price"
                      type="number"
                      min="0"
                      step="0.01"
                      value={price}
                      onChange={(event) =>
                        setPrice(event.target.value)
                      }
                      placeholder="0.00"
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    />
                  </div>

                  <div>
                    <label
                      htmlFor="usage-rights"
                      className="mb-2 block text-sm font-medium"
                    >
                      Usage Rights
                    </label>

                    <select
                      id="usage-rights"
                      value={usageRights}
                      onChange={(event) =>
                        setUsageRights(event.target.value)
                      }
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
                    >
                      <option>
                        Standard License (download only)
                      </option>
                      <option>Creative Commons</option>
                      <option>Private Use Only</option>
                    </select>
                  </div>
                </div>

                <fieldset>
                  <legend className="mb-2 block text-sm font-medium">
                    Visibility
                  </legend>

                  <div className="space-y-2">
                    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-gray-200 p-3 hover:bg-gray-50">
                      <input
                        type="radio"
                        name="visibility"
                        checked={visibility === "public"}
                        onChange={() => setVisibility("public")}
                        className="mt-0.5 accent-blue-600"
                      />

                      <span>
                        <span className="block text-sm font-medium">
                          Public
                        </span>
                        <span className="block text-xs text-gray-600">
                          Anyone can view or download.
                        </span>
                      </span>
                    </label>

                    <label className="flex cursor-pointer items-start gap-2 rounded-md border border-gray-200 p-3 hover:bg-gray-50">
                      <input
                        type="radio"
                        name="visibility"
                        checked={visibility === "private"}
                        onChange={() => setVisibility("private")}
                        className="mt-0.5 accent-blue-600"
                      />

                      <span>
                        <span className="block text-sm font-medium">
                          Private
                        </span>
                        <span className="block text-xs text-gray-600">
                          Only you and invited users can access it.
                        </span>
                      </span>
                    </label>
                  </div>
                </fieldset>
              </div>
            ) : null}

            {currentStep === 4 ? (
              <div className="space-y-5">
                <div>
                  <h3 className="mb-2 text-lg font-semibold">
                    Review & Publish
                  </h3>

                  <p className="mb-4 text-sm text-gray-600">
                    Review the material before publishing it.
                  </p>
                </div>

                <div className="space-y-3 rounded-lg border border-gray-200 bg-gray-50 p-4">
                  <div>
                    <p className="mb-1 text-xs text-gray-500">
                      Document
                    </p>
                    <p className="text-sm font-medium">
                      {docFileName}
                    </p>
                  </div>

                  <div>
                    <p className="mb-1 text-xs text-gray-500">
                      Title
                    </p>
                    <p className="text-sm font-medium">{title}</p>
                  </div>

                  {description ? (
                    <div>
                      <p className="mb-1 text-xs text-gray-500">
                        Description
                      </p>
                      <p className="text-sm text-gray-700">
                        {description}
                      </p>
                    </div>
                  ) : null}

                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="mb-1 text-xs text-gray-500">
                        Price
                      </p>
                      <p className="text-sm font-medium">
                        {price ? `${price} CELO` : "Free"}
                      </p>
                    </div>

                    <div>
                      <p className="mb-1 text-xs text-gray-500">
                        Usage Rights
                      </p>
                      <p className="text-sm font-medium">
                        {usageRights}
                      </p>
                    </div>
                  </div>

                  <div>
                    <p className="mb-1 text-xs text-gray-500">
                      Visibility
                    </p>
                    <p className="text-sm font-medium capitalize">
                      {visibility}
                    </p>
                  </div>
                </div>

                <div className="rounded-lg border border-blue-200 bg-blue-50 p-4">
                  <p className="text-sm text-blue-800">
                    <strong>Note:</strong> Publishing will mint your
                    material as an NFT. Network transaction fees will
                    apply.
                  </p>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </div>

      {!isSubmitting ? (
        <div className="flex justify-between border-t border-gray-200 p-6">
          <button
            type="button"
            onClick={handlePrevious}
            disabled={currentStep === 1}
            className="flex items-center gap-2 rounded-md border border-gray-300 px-5 py-2 text-sm font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <FaArrowLeft className="text-xs" />
            Previous
          </button>

          {currentStep < STEPS.length ? (
            <button
              type="button"
              onClick={handleNext}
              className="flex items-center gap-2 rounded-md bg-blue-600 px-5 py-2 text-sm font-medium text-white transition hover:bg-blue-700"
            >
              Next
              <FaArrowRight className="text-xs" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!address || chainMismatch}
              className="flex items-center gap-2 rounded-md bg-green-600 px-6 py-2 text-sm font-medium text-white transition hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Publish & Mint NFT
              <FaArrowRight className="text-xs" />
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}