"use client";

import { useState } from "react";
import StudentVerificationForm from "@/components/StudentVerificationForm";
import { useWallet } from "@/hooks/useWallet";
import { WalletStatus } from "@/providers/WalletProvider";

export default function StudentVerificationPage() {
  const { state, connect } = useWallet();
  const [verificationStatus, setVerificationStatus] = useState(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [connectionError, setConnectionError] = useState(null);

  const isConnected = state.status === WalletStatus.Connected;
  const userAddress = state.session?.address;

  const handleConnectWallet = async () => {
    setConnectionError(null);
    setIsConnecting(true);

    try {
      await connect();
    } catch (error) {
      console.error("Failed to connect wallet:", error);
      setConnectionError(
        error?.message || "Unable to connect your wallet. Please try again."
      );
    } finally {
      setIsConnecting(false);
    }
  };

  const handleVerificationSuccess = () => {
    setVerificationStatus("submitted");
  };

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-12 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-lg bg-white shadow">
          <div className="px-6 py-8 sm:p-10">
            <div className="mb-8">
              <h1 className="mb-2 text-3xl font-bold text-gray-900">
                Student Verification
              </h1>

              <p className="text-gray-600">
                Verify your student status to unlock exclusive pricing and
                benefits.
              </p>
            </div>

            {!isConnected ? (
              <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-6 text-center">
                <svg
                  className="mx-auto mb-4 h-12 w-12 text-yellow-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>

                <h3 className="mb-2 text-lg font-medium text-yellow-900">
                  Wallet Connection Required
                </h3>

                <p className="mb-4 text-sm text-yellow-700">
                  Please connect your wallet to submit a verification
                  application.
                </p>

                {connectionError ? (
                  <div
                    className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
                    role="alert"
                  >
                    {connectionError}
                  </div>
                ) : null}

                <button
                  type="button"
                  onClick={handleConnectWallet}
                  disabled={isConnecting}
                  className="inline-flex items-center rounded-md border border-transparent bg-yellow-100 px-4 py-2 text-sm font-medium text-yellow-700 hover:bg-yellow-200 focus:outline-none focus:ring-2 focus:ring-yellow-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isConnecting ? "Connecting..." : "Connect Wallet"}
                </button>
              </div>
            ) : verificationStatus === "submitted" ? (
              <div className="rounded-lg border border-green-200 bg-green-50 p-6 text-center">
                <svg
                  className="mx-auto mb-4 h-12 w-12 text-green-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>

                <h3 className="mb-2 text-lg font-medium text-green-900">
                  Application Submitted Successfully
                </h3>

                <p className="mb-4 text-sm text-green-700">
                  Your student verification application is under review. We
                  will notify you once the verification is complete, typically
                  within 1–3 business days.
                </p>

                <div className="text-xs text-green-600">
                  <p>What happens next:</p>

                  <ul className="mx-auto mt-2 max-w-md space-y-1 text-left">
                    <li>• Our team reviews your submitted documents.</li>
                    <li>
                      • You&apos;ll receive an email notification with the
                      decision.
                    </li>
                    <li>
                      • Once approved, student pricing will automatically apply.
                    </li>
                  </ul>
                </div>
              </div>
            ) : (
              <>
                <div className="mb-6 rounded-lg border border-blue-200 bg-blue-50 p-4">
                  <h3 className="mb-2 text-sm font-semibold text-blue-900">
                    Benefits of Student Verification
                  </h3>

                  <ul className="space-y-1 text-sm text-blue-800">
                    <li>
                      • Access to exclusive student pricing, up to 50% off.
                    </li>
                    <li>• Priority access to educational materials.</li>
                    <li>• Eligibility for student-only promotions.</li>
                    <li>• Free access to select community resources.</li>
                  </ul>
                </div>

                <StudentVerificationForm
                  onSuccess={handleVerificationSuccess}
                  userAddress={userAddress}
                />
              </>
            )}
          </div>
        </div>

        <div className="mt-6 rounded-lg bg-white px-6 py-4 shadow">
          <h3 className="mb-3 text-sm font-semibold text-gray-900">
            Acceptable Documents
          </h3>

          <div className="grid gap-4 text-sm text-gray-600 sm:grid-cols-2">
            <div>
              <h4 className="mb-1 font-medium text-gray-900">
                Valid Documents:
              </h4>

              <ul className="space-y-1">
                <li>• Current student ID card.</li>
                <li>• Enrollment verification letter.</li>
                <li>• Current semester schedule.</li>
                <li>• Transcript with current dates.</li>
              </ul>
            </div>

            <div>
              <h4 className="mb-1 font-medium text-gray-900">
                Requirements:
              </h4>

              <ul className="space-y-1">
                <li>• Documents must be current.</li>
                <li>• Scans must be clear and legible.</li>
                <li>• Maximum file size: 5MB.</li>
                <li>• Supported formats: JPG, PNG, or PDF.</li>
              </ul>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}