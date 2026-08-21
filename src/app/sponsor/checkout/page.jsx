"use client";

import React, { useMemo, useState, useCallback } from 'react';
import BulkAddressInput from './BulkAddressInput';
import GasEstimator from './GasEstimator';
import './checkout.css';
import { useWallet } from '@/hooks/useWallet';
import { useStellarTransaction } from '@/hooks/useStellarTransaction';
import { getExplorerTxUrl } from '@/lib/config/chain';
import { buildSingleChunkTransaction } from '@/lib/stellar/bulkFundingXdr';
import {
  createBulkFundingPlan,
  createChunkRunState,
  applyChunkResult,
  getResumableChunkIds,
  summarizeRunState,
  isRunComplete,
  ChunkStatus,
} from '@/lib/stellar/bulkFunding';

const BASE_FEE_XLM = 0.00001;

/**
 * SponsorCheckout - page component for sponsoring students.
 *
 * Bulk recipient funding (Issue #158): a sponsor can list hundreds of
 * recipient wallets, but a single Stellar transaction can hold at most 100
 * operations. Recipients are chunked accordingly and each chunk is
 * submitted as its own transaction. Per-chunk status is tracked so that if
 * a chunk fails (or the sponsor's wallet rejects it) partway through a
 * large run, only the unresolved chunks need to be retried - chunks that
 * already succeeded are never re-sent.
 */
export default function SponsorCheckout() {
  const { address: walletAddress, isConnected } = useWallet();
  const { execute } = useStellarTransaction();

  const [addresses, setAddresses] = useState([]);
  const [amountPerRecipient, setAmountPerRecipient] = useState('1');
  const [runState, setRunState] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [submitError, setSubmitError] = useState(null);

  const plan = useMemo(() => createBulkFundingPlan(addresses), [addresses]);

  const amountValid = Number(amountPerRecipient) > 0;
  const valid =
    plan.totalRecipients > 0 &&
    plan.invalidAddresses.length === 0 &&
    amountValid;

  const gasInfo = {
    totalTx: plan.totalChunks,
    gasCost: (plan.totalRecipients * BASE_FEE_XLM).toFixed(5),
  };

  const handleAddressesChange = useCallback((list) => {
    setAddresses(list);
    setRunState(null);
    setSubmitError(null);
  }, []);

  const runChunks = useCallback(
    async (chunkIds, currentRunState) => {
      setIsRunning(true);
      setSubmitError(null);
      let nextRunState = currentRunState;

      try {
        for (const chunkId of chunkIds) {
          const chunk = plan.chunks.find((c) => c.id === chunkId);
          if (!chunk) continue;

          nextRunState = applyChunkResult(nextRunState, chunkId, {
            status: ChunkStatus.Submitting,
          });
          setRunState(nextRunState);

          try {
            const built = await buildSingleChunkTransaction({
              sourcePublicKey: walletAddress,
              addresses: chunk.addresses,
              amountPerRecipient,
            });

            const { hash } = await execute(built.xdr, {
              description: `Sponsorship funding (chunk ${chunk.index + 1}/${plan.totalChunks})`,
              explorerBaseUrl: getExplorerTxUrl(''),
            });

            nextRunState = applyChunkResult(nextRunState, chunkId, {
              status: ChunkStatus.Success,
              txHash: hash,
              error: null,
              attempts: (nextRunState[chunkId]?.attempts ?? 0) + 1,
            });
            setRunState(nextRunState);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            nextRunState = applyChunkResult(nextRunState, chunkId, {
              status: ChunkStatus.Failed,
              error: message,
              attempts: (nextRunState[chunkId]?.attempts ?? 0) + 1,
            });
            setRunState(nextRunState);
            // Stop at the first failure: later chunks were built against a
            // sequence number that assumed earlier ones landed first, so we
            // surface the failure and let the sponsor retry just the
            // unresolved chunks instead of racing ahead.
            setSubmitError(
              `Chunk ${chunk.index + 1} of ${plan.totalChunks} failed: ${message}`,
            );
            return;
          }
        }
      } finally {
        setIsRunning(false);
      }
    },
    [amountPerRecipient, execute, plan.chunks, plan.totalChunks, walletAddress],
  );

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!valid || isRunning) return;

    if (!isConnected || !walletAddress) {
      setSubmitError('Connect your Stellar wallet before sponsoring.');
      return;
    }

    const freshRunState = createChunkRunState(plan.chunks);
    setRunState(freshRunState);
    runChunks(
      plan.chunks.map((c) => c.id),
      freshRunState,
    );
  };

  const handleRetry = () => {
    if (!runState || isRunning) return;
    const resumable = getResumableChunkIds(runState);
    if (resumable.length === 0) return;
    runChunks(resumable, runState);
  };

  const summary = runState ? summarizeRunState(runState) : null;
  const complete = runState ? isRunComplete(runState) : false;

  return (
    <section className="sponsor-checkout">
      <h2 className="title">Sponsor a Student – Scholarship Checkout</h2>
      <form onSubmit={handleSubmit} className="checkout-form">
        <BulkAddressInput onChange={handleAddressesChange} />

        {plan.invalidAddresses.length > 0 && (
          <p className="error-msg">
            {plan.invalidAddresses.length} address(es) are not valid Stellar addresses and must
            be removed before you can continue.
          </p>
        )}
        {plan.duplicateAddresses.length > 0 && (
          <p className="warning-msg">
            {plan.duplicateAddresses.length} duplicate address(es) were ignored.
          </p>
        )}

        <label className="input-label" htmlFor="amount-per-recipient">
          Amount per recipient (XLM):
        </label>
        <input
          id="amount-per-recipient"
          type="number"
          min="0"
          step="0.0000001"
          value={amountPerRecipient}
          onChange={(e) => setAmountPerRecipient(e.target.value)}
          className="manual-textarea"
        />

        <GasEstimator totalTx={gasInfo.totalTx} gasCost={gasInfo.gasCost} />
        {plan.totalChunks > 1 && (
          <p className="chunk-info">
            {plan.totalRecipients} recipients will be sponsored across {plan.totalChunks}{' '}
            transactions (max 100 recipients per transaction).
          </p>
        )}

        <button type="submit" className="submit-btn" disabled={!valid || isRunning}>
          {isRunning ? 'Submitting…' : 'Confirm Sponsorship'}
        </button>

        {submitError && <p className="error-msg">{submitError}</p>}

        {summary && (
          <div className="chunk-run-summary">
            <p>
              {summary.success}/{summary.total} transactions confirmed
              {summary.failed > 0 ? `, ${summary.failed} failed` : ''}.
            </p>
            {!complete && !isRunning && summary.failed > 0 && (
              <button type="button" className="submit-btn" onClick={handleRetry}>
                Retry remaining chunks
              </button>
            )}
            {complete && <p>All chunks confirmed.</p>}
          </div>
        )}
      </form>
    </section>
  );
}
