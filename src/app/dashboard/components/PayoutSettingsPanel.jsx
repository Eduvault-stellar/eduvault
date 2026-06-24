"use client";

import { useEffect, useState } from "react";
import {
  FaCheckCircle,
  FaExclamationTriangle,
  FaGlobe,
  FaInfoCircle,
  FaShieldAlt,
  FaWallet,
} from "react-icons/fa";
import { useUpdateProfile } from "@/hooks/api/useProfile";

function fieldValue(value, fallback = "Not set yet") {
  return value && String(value).trim().length > 0 ? value : fallback;
}

export default function PayoutSettingsPanel({ initialUser }) {
  const { mutateAsync: updateProfile, isPending } = useUpdateProfile();
  const [form, setForm] = useState(() => ({
    payoutWalletAddress: initialUser?.payoutWalletAddress || "",
    preferredPayoutCurrency: initialUser?.preferredPayoutCurrency || "XLM",
    payoutNotes: initialUser?.payoutNotes || "",
  }));
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setForm({
      payoutWalletAddress: initialUser?.payoutWalletAddress || "",
      preferredPayoutCurrency: initialUser?.preferredPayoutCurrency || "XLM",
      payoutNotes: initialUser?.payoutNotes || "",
    });
  }, [initialUser]);

  const onSubmit = async (event) => {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    try {
      await updateProfile({
        payoutWalletAddress: form.payoutWalletAddress.trim() || null,
        preferredPayoutCurrency: form.preferredPayoutCurrency.trim() || null,
        payoutNotes: form.payoutNotes.trim() || null,
      });
      setSuccess("Payout settings updated.");
    } catch (err) {
      setError(err?.message || "Unable to save payout settings.");
    }
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[1.6fr_1fr]">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
        <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-700">
              <FaShieldAlt />
              Creator payout settings
            </div>
            <h1 className="mt-4 text-3xl font-semibold tracking-tight text-slate-950">
              Configure where settlement metadata points.
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-slate-600">
              Keep payout routing and display metadata in one place. This page does not request private keys or secret credentials.
            </p>
          </div>
          <div className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            <div className="mb-1 flex items-center gap-2 font-semibold">
              <FaExclamationTriangle />
              Sensitive values are excluded
            </div>
            <p>Only the payout wallet, preferred currency, and notes are stored.</p>
          </div>
        </div>

        {error ? (
          <div className="mb-6 rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {error}
          </div>
        ) : null}

        {success ? (
          <div className="mb-6 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {success}
          </div>
        ) : null}

        <form onSubmit={onSubmit} className="space-y-6">
          <div className="grid gap-5 md:grid-cols-2">
            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-700">Payout wallet address</span>
              <div className="relative">
                <FaWallet className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={form.payoutWalletAddress}
                  onChange={(event) => setForm((current) => ({ ...current, payoutWalletAddress: event.target.value }))}
                  placeholder="G..."
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-3 pl-11 pr-4 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:bg-white"
                />
              </div>
              <span className="mt-2 block text-xs text-slate-500">
                Use the creator settlement wallet only. Do not enter seed phrases or private keys.
              </span>
            </label>

            <label className="block">
              <span className="mb-2 block text-sm font-medium text-slate-700">Preferred display currency</span>
              <div className="relative">
                <FaGlobe className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={form.preferredPayoutCurrency}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      preferredPayoutCurrency: event.target.value.toUpperCase(),
                    }))
                  }
                  placeholder="XLM"
                  className="w-full rounded-2xl border border-slate-200 bg-slate-50 py-3 pl-11 pr-4 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:bg-white"
                />
              </div>
              <span className="mt-2 block text-xs text-slate-500">
                Examples: XLM, USD, USDC, EURC.
              </span>
            </label>
          </div>

          <label className="block">
            <span className="mb-2 block text-sm font-medium text-slate-700">Payout notes</span>
            <textarea
              rows={5}
              value={form.payoutNotes}
              onChange={(event) => setForm((current) => ({ ...current, payoutNotes: event.target.value }))}
              placeholder="Optional notes for finance and operations, such as settlement preferences or recipient naming conventions."
              className="w-full rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-900 outline-none transition focus:border-slate-400 focus:bg-white"
            />
          </label>

          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="submit"
              disabled={isPending}
              className="inline-flex items-center justify-center gap-2 rounded-2xl bg-slate-950 px-5 py-3 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <FaCheckCircle />
              {isPending ? "Saving..." : "Save payout settings"}
            </button>
          </div>
        </form>
      </section>

      <aside className="space-y-6">
        <div className="rounded-3xl border border-slate-200 bg-slate-950 p-6 text-white shadow-sm">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-slate-400">
            Current profile
          </p>
          <div className="mt-5 space-y-4">
            <div>
              <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Creator</div>
              <div className="mt-1 text-sm font-medium text-white">
                {fieldValue(initialUser?.fullName, initialUser?.email || "Unnamed creator")}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Wallet</div>
              <div className="mt-1 break-all text-sm font-medium text-white">
                {fieldValue(initialUser?.walletAddress, "Not linked")}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase tracking-[0.16em] text-slate-400">Payout wallet</div>
              <div className="mt-1 break-all text-sm font-medium text-white">
                {fieldValue(initialUser?.payoutWalletAddress, "Not set yet")}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-2xl bg-white/5 p-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Currency</div>
                <div className="mt-1 text-sm font-semibold">{fieldValue(initialUser?.preferredPayoutCurrency, "XLM")}</div>
              </div>
              <div className="rounded-2xl bg-white/5 p-3">
                <div className="text-[11px] uppercase tracking-[0.16em] text-slate-400">Notes</div>
                <div className="mt-1 text-sm font-semibold">{initialUser?.payoutNotes ? "Saved" : "Empty"}</div>
              </div>
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <FaInfoCircle className="text-slate-500" />
            What this page does
          </div>
          <ul className="mt-4 space-y-3 text-sm leading-6 text-slate-600">
            <li>Stores payout wallet, preferred currency, and payout notes on your creator profile.</li>
            <li>Leaves secret credentials untouched and never requests a private key.</li>
            <li>Feeds the same profile record used by dashboard and future settlement flows.</li>
          </ul>
        </div>
      </aside>
    </div>
  );
}
