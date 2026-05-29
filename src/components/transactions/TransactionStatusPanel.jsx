"use client";

import { FaCheckCircle, FaClock, FaExclamationTriangle, FaRedoAlt } from "react-icons/fa";
import {
  TransactionStatus,
  TransactionTone,
  getTransactionStepLabel,
} from "@/lib/transactions/transaction";

function toneClasses(tone) {
  switch (tone) {
    case TransactionTone.Success:
      return "border-emerald-200 bg-emerald-50 text-emerald-900";
    case TransactionTone.Warning:
      return "border-amber-200 bg-amber-50 text-amber-900";
    case TransactionTone.Danger:
      return "border-rose-200 bg-rose-50 text-rose-900";
    default:
      return "border-slate-200 bg-slate-50 text-slate-900";
  }
}

function statusIcon(status) {
  switch (status) {
    case TransactionStatus.Confirmed:
      return <FaCheckCircle className="text-base" />;
    case TransactionStatus.Failed:
    case TransactionStatus.NeedsRetry:
      return <FaExclamationTriangle className="text-base" />;
    default:
      return <FaClock className="text-base" />;
  }
}

export default function TransactionStatusPanel({
  transaction,
  onRetry,
  onClear,
  compact = false,
}) {
  if (!transaction || transaction.status === TransactionStatus.Idle) return null;

  const canRetry = transaction.retryable && typeof onRetry === "function";

  return (
    <section className={`rounded-2xl border p-4 ${toneClasses(transaction.tone)}`}>
      <div className="flex items-start gap-3">
        <div className="mt-1 rounded-full bg-white/70 p-2">
          {statusIcon(transaction.status)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{transaction.title || getTransactionStepLabel(transaction.status)}</h3>
            <span className="rounded-full bg-white/70 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-current/70">
              {transaction.scope}
            </span>
          </div>
          {transaction.message ? (
            <p className={`mt-1 text-sm leading-6 ${compact ? "" : "max-w-2xl"}`}>
              {transaction.message}
            </p>
          ) : null}
          {transaction.detail ? (
            <p className="mt-2 text-xs leading-5 text-current/75">{transaction.detail}</p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-3 text-xs font-medium">
            <span className="rounded-full bg-white/70 px-2.5 py-1">
              {getTransactionStepLabel(transaction.status)}
            </span>
            {transaction.txHash ? (
              <span className="rounded-full bg-white/70 px-2.5 py-1 font-mono">
                {transaction.txHash.slice(0, 8)}...{transaction.txHash.slice(-6)}
              </span>
            ) : null}
            {transaction.explorerUrl ? (
              <a
                href={transaction.explorerUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-full bg-white/70 px-2.5 py-1 text-blue-700 hover:text-blue-800"
              >
                View explorer
              </a>
            ) : null}
            {canRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1 rounded-full bg-white/70 px-2.5 py-1 text-slate-900 hover:bg-white"
              >
                <FaRedoAlt className="text-[10px]" />
                Retry
              </button>
            ) : null}
            {typeof onClear === "function" ? (
              <button
                type="button"
                onClick={onClear}
                className="rounded-full bg-white/70 px-2.5 py-1 text-slate-900 hover:bg-white"
              >
                Clear
              </button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
