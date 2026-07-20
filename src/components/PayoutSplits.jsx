"use client";

import { useEffect, useMemo, useState } from "react";
import { FaPlus, FaTrash } from "react-icons/fa";

const DEFAULT_SPLITS = [{ address: "", percentage: 100 }];

function validateWalletAddress(address) {
  const stellarRegex = /^G[A-Z2-7]{55}$/;
  return stellarRegex.test(address);
}

function validateSplits(splits) {
  const validationErrors = {};
  let totalPercentage = 0;

  splits.forEach((split, index) => {
    const normalizedAddress = split.address.trim().toUpperCase();

    if (normalizedAddress && !validateWalletAddress(normalizedAddress)) {
      validationErrors[`address_${index}`] =
        "Invalid Stellar wallet address";
    }

    const duplicateIndex = splits.findIndex((candidate, candidateIndex) => {
      if (candidateIndex === index) {
        return false;
      }

      const candidateAddress = candidate.address.trim().toUpperCase();

      return (
        normalizedAddress &&
        candidateAddress &&
        candidateAddress === normalizedAddress
      );
    });

    if (duplicateIndex !== -1) {
      validationErrors[`address_${index}`] =
        "Duplicate wallet address";
    }

    const percentage = Number.parseFloat(split.percentage);

    if (!Number.isFinite(percentage) || percentage <= 0) {
      validationErrors[`percentage_${index}`] =
        "Percentage must be greater than 0";
    } else if (percentage > 100) {
      validationErrors[`percentage_${index}`] =
        "Percentage cannot exceed 100";
    }

    totalPercentage += Number.isFinite(percentage) ? percentage : 0;
  });

  if (Math.abs(totalPercentage - 100) > 0.01) {
    validationErrors.total = `Total must equal 100% (currently ${totalPercentage.toFixed(
      2,
    )}%)`;
  }

  return {
    errors: validationErrors,
    totalPercentage,
    isValid: Object.keys(validationErrors).length === 0,
  };
}

function normalizeInitialSplits(initialSplits) {
  if (!Array.isArray(initialSplits) || initialSplits.length === 0) {
    return DEFAULT_SPLITS;
  }

  return initialSplits.map((split) => ({
    address: split?.address || "",
    percentage:
      split?.percentage === undefined ||
      split?.percentage === null ||
      split?.percentage === ""
        ? 0
        : split.percentage,
  }));
}

export default function PayoutSplits({
  onChange,
  initialSplits = [],
}) {
  const [splits, setSplits] = useState(() =>
    normalizeInitialSplits(initialSplits),
  );

  const validation = useMemo(
    () => validateSplits(splits),
    [splits],
  );

  useEffect(() => {
    onChange(
      validation.isValid
        ? splits.map((split) => ({
            address: split.address.trim().toUpperCase(),
            percentage: Number.parseFloat(split.percentage),
          }))
        : null,
      validation.isValid,
    );
  }, [onChange, splits, validation.isValid]);

  const handleAddSplit = () => {
    setSplits((currentSplits) => {
      const currentTotal = currentSplits.reduce((sum, split) => {
        const percentage = Number.parseFloat(split.percentage);
        return sum + (Number.isFinite(percentage) ? percentage : 0);
      }, 0);

      const remaining = Math.max(0, 100 - currentTotal);

      return [
        ...currentSplits,
        {
          address: "",
          percentage: Number(remaining.toFixed(2)),
        },
      ];
    });
  };

  const handleRemoveSplit = (index) => {
    setSplits((currentSplits) => {
      if (currentSplits.length === 1) {
        return currentSplits;
      }

      const nextSplits = currentSplits
        .filter((_, splitIndex) => splitIndex !== index)
        .map((split) => ({ ...split }));

      const total = nextSplits.reduce((sum, split) => {
        const percentage = Number.parseFloat(split.percentage);
        return sum + (Number.isFinite(percentage) ? percentage : 0);
      }, 0);

      if (total === 0 && nextSplits.length > 0) {
        nextSplits[0].percentage = 100;
      }

      return nextSplits;
    });
  };

  const handleAddressChange = (index, value) => {
    const normalizedValue = value
      .replace(/\s+/g, "")
      .toUpperCase();

    setSplits((currentSplits) =>
      currentSplits.map((split, splitIndex) =>
        splitIndex === index
          ? {
              ...split,
              address: normalizedValue,
            }
          : split,
      ),
    );
  };

  const handlePercentageChange = (index, value) => {
    setSplits((currentSplits) =>
      currentSplits.map((split, splitIndex) =>
        splitIndex === index
          ? {
              ...split,
              percentage: value,
            }
          : split,
      ),
    );
  };

  const handlePercentageBlur = (index) => {
    setSplits((currentSplits) =>
      currentSplits.map((split, splitIndex) => {
        if (splitIndex !== index) {
          return split;
        }

        const parsedValue = Number.parseFloat(split.percentage);
        const safeValue = Number.isFinite(parsedValue)
          ? Math.min(100, Math.max(0, parsedValue))
          : 0;

        return {
          ...split,
          percentage: Number(safeValue.toFixed(2)),
        };
      }),
    );
  };

  const distributeEvenly = () => {
    setSplits((currentSplits) => {
      if (currentSplits.length === 0) {
        return currentSplits;
      }

      const basePercentage =
        Math.floor((100 / currentSplits.length) * 100) / 100;

      const distributedTotal =
        basePercentage * currentSplits.length;

      const remainder = Number(
        (100 - distributedTotal).toFixed(2),
      );

      return currentSplits.map((split, index) => ({
        ...split,
        percentage: Number(
          (
            basePercentage +
            (index === 0 ? remainder : 0)
          ).toFixed(2),
        ),
      }));
    });
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold">
            Payout Split Configuration
          </h3>

          <p className="mt-1 text-xs text-gray-600">
            Configure revenue sharing with co-authors. Total must
            equal 100%.
          </p>
        </div>

        {splits.length > 1 ? (
          <button
            type="button"
            onClick={distributeEvenly}
            className="shrink-0 text-xs font-medium text-blue-600 hover:text-blue-700"
          >
            Distribute Evenly
          </button>
        ) : null}
      </div>

      <div className="space-y-3">
        {splits.map((split, index) => {
          const addressError =
            validation.errors[`address_${index}`];

          const percentageError =
            validation.errors[`percentage_${index}`];

          return (
            <div
              key={`payout-split-${index}`}
              className="flex items-start gap-2"
            >
              <div className="min-w-0 flex-1">
                <label
                  htmlFor={`split-address-${index}`}
                  className="sr-only"
                >
                  Stellar wallet address for recipient {index + 1}
                </label>

                <input
                  id={`split-address-${index}`}
                  type="text"
                  value={split.address}
                  onChange={(event) =>
                    handleAddressChange(index, event.target.value)
                  }
                  placeholder="Stellar wallet address (G...)"
                  maxLength={56}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(addressError)}
                  aria-describedby={
                    addressError
                      ? `split-address-error-${index}`
                      : undefined
                  }
                  className={`w-full rounded-md border px-3 py-2 font-mono text-sm uppercase focus:border-blue-500 focus:ring-2 focus:ring-blue-100 ${
                    addressError
                      ? "border-red-500"
                      : "border-gray-300"
                  }`}
                />

                {addressError ? (
                  <p
                    id={`split-address-error-${index}`}
                    className="mt-1 text-xs text-red-600"
                    role="alert"
                  >
                    {addressError}
                  </p>
                ) : null}
              </div>

              <div className="w-28 shrink-0">
                <label
                  htmlFor={`split-percentage-${index}`}
                  className="sr-only"
                >
                  Payout percentage for recipient {index + 1}
                </label>

                <div className="relative">
                  <input
                    id={`split-percentage-${index}`}
                    type="number"
                    value={split.percentage}
                    onChange={(event) =>
                      handlePercentageChange(
                        index,
                        event.target.value,
                      )
                    }
                    onBlur={() => handlePercentageBlur(index)}
                    min="0"
                    max="100"
                    step="0.01"
                    inputMode="decimal"
                    aria-invalid={Boolean(percentageError)}
                    aria-describedby={
                      percentageError
                        ? `split-percentage-error-${index}`
                        : undefined
                    }
                    className={`w-full rounded-md border px-3 py-2 pr-7 text-sm focus:border-blue-500 focus:ring-2 focus:ring-blue-100 ${
                      percentageError
                        ? "border-red-500"
                        : "border-gray-300"
                    }`}
                  />

                  <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-500">
                    %
                  </span>
                </div>

                {percentageError ? (
                  <p
                    id={`split-percentage-error-${index}`}
                    className="mt-1 text-xs text-red-600"
                    role="alert"
                  >
                    {percentageError}
                  </p>
                ) : null}
              </div>

              <button
                type="button"
                onClick={() => handleRemoveSplit(index)}
                disabled={splits.length === 1}
                className="mt-1 rounded-md p-2 text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-30"
                aria-label={`Remove payout recipient ${index + 1}`}
              >
                <FaTrash className="text-sm" />
              </button>
            </div>
          );
        })}
      </div>

      <div className="mt-3 border-t border-gray-200 pt-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Total:</span>

            <span
              className={`text-sm font-bold ${
                Math.abs(validation.totalPercentage - 100) <= 0.01
                  ? "text-green-600"
                  : "text-red-600"
              }`}
            >
              {validation.totalPercentage.toFixed(2)}%
            </span>
          </div>

          <button
            type="button"
            onClick={handleAddSplit}
            className="flex items-center gap-2 text-sm font-medium text-blue-600 hover:text-blue-700"
          >
            <FaPlus className="text-xs" />
            Add Co-Author
          </button>
        </div>

        {validation.errors.total ? (
          <p className="mt-2 text-xs text-red-600" role="alert">
            {validation.errors.total}
          </p>
        ) : null}
      </div>
    </div>
  );
}