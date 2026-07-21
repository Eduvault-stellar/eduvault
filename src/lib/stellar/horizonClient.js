import { Horizon } from "@stellar/stellar-sdk";
import { HORIZON_URL, isMainnet } from "@/lib/config/chain";

const horizonLogger = {
  warn(data, message) {
    console.warn(message, data);
  },
  info(data, message) {
    console.info(message, data);
  },
  error(data, message) {
    console.error(message, data);
  },
};

// Primary URL from config; fallback list ordered by preference.
const PRIMARY_URL = HORIZON_URL;

const FALLBACK_URLS = isMainnet
  ? [
      "https://horizon.stellar.org",
      "https://horizon.stellar.lobstr.co",
    ]
  : ["https://horizon-testnet.stellar.org"];

// Gather any extra endpoints defined in env (space or comma separated).
const EXTRA_FALLBACKS = (
  process.env.STELLAR_HORIZON_FALLBACKS || ""
)
  .split(/[\s,]+/)
  .map((url) => url.trim())
  .filter(Boolean);

const ALL_ENDPOINTS = [
  PRIMARY_URL,
  ...EXTRA_FALLBACKS,
  ...FALLBACK_URLS,
].filter(
  (url, index, endpoints) =>
    Boolean(url) && endpoints.indexOf(url) === index,
);

const parsedTimeout = Number(
  process.env.STELLAR_HORIZON_TIMEOUT_MS || 8000,
);
const parsedRetries = Number(
  process.env.STELLAR_HORIZON_RETRIES || 2,
);

const DEFAULT_TIMEOUT_MS =
  Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? parsedTimeout
    : 8000;

const DEFAULT_RETRIES =
  Number.isInteger(parsedRetries) && parsedRetries >= 0
    ? parsedRetries
    : 2;

const DEFAULT_FEE_STATS = {
  fee_charged: {
    min: "100",
    p10: "100",
    p20: "100",
    p30: "100",
    p40: "100",
    p50: "100",
    p60: "100",
    p70: "100",
    p80: "100",
    p90: "100",
    p95: "100",
    p99: "100",
    max: "100",
  },
};

const KNOWN_USDC_ISSUERS = {
  testnet:
    "GBBD47IF6LWK7P7MDEVSCWRZDPOVPOFWLYERWFBN4JSE3OUQTISLV5EX",
  mainnet:
    "GA5ZSEJYB37JDD5G3LYVYF77RD7QFGHSXPJNKXJFUMIVYQ33HE6IGM4Y",
};

function buildServer(url) {
  const options = {
    allowHttp: url.startsWith("http://"),
  };

  try {
    return new Horizon.Server(url, options);
  } catch (error) {
    if (
      error instanceof TypeError &&
      String(error.message || "").includes("not a constructor")
    ) {
      return Horizon.Server(url, options);
    }
    throw error;
  }
}

function isTransientError(error) {
  const status = error?.response?.status ?? error?.status;

  if ([429, 502, 503, 504].includes(status)) {
    return true;
  }

  const code = error?.code || "";

  if (
    ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT"].includes(code)
  ) {
    return true;
  }

  const message = String(error?.message || "").toLowerCase();

  return (
    message.includes("timeout") ||
    message.includes("network") ||
    message.includes("socket") ||
    message.includes("fetch failed")
  );
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;

  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `Horizon request timed out (${timeoutMs}ms) for ${label}`,
        ),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Execute `fn(server)` against configured Horizon endpoints.
 *
 * A transient connection error or timeout moves execution to the next
 * configured endpoint. Non-transient Horizon errors are returned immediately.
 *
 * @template T
 * @param {(server: Horizon.Server) => Promise<T>} fn
 * @param {{ timeoutMs?: number, retries?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withFailover(
  fn,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
  } = {},
) {
  if (typeof fn !== "function") {
    throw new TypeError(
      "withFailover requires a function that receives a Horizon server.",
    );
  }

  if (ALL_ENDPOINTS.length === 0) {
    throw new Error(
      "No Horizon endpoints are configured. Set HORIZON_URL or STELLAR_HORIZON_FALLBACKS.",
    );
  }

  const safeTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_TIMEOUT_MS;

  const safeRetries =
    Number.isInteger(retries) && retries >= 0
      ? retries
      : DEFAULT_RETRIES;

  const totalAttempts = safeRetries + 1;
  const errors = [];

  for (let attempt = 0; attempt < totalAttempts; attempt += 1) {
    const endpointIndex = attempt % ALL_ENDPOINTS.length;
    const url = ALL_ENDPOINTS[endpointIndex];
    const server = buildServer(url);

    try {
      const result = await withTimeout(
        fn(server),
        safeTimeoutMs,
        url,
      );

      if (attempt > 0) {
        horizonLogger.info(
          {
            failoverUrl: url,
            attempt: attempt + 1,
          },
          "Horizon failover succeeded",
        );
      }

      return result;
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      errors.push({
        url,
        message,
      });

      if (!isTransientError(error)) {
        horizonLogger.warn(
          {
            url,
            error: message,
          },
          "Horizon non-transient error; failover stopped",
        );

        throw error;
      }

      horizonLogger.warn(
        {
          primaryUrl: ALL_ENDPOINTS[0],
          failedUrl: url,
          nextUrl:
            ALL_ENDPOINTS[
              (endpointIndex + 1) % ALL_ENDPOINTS.length
            ],
          attempt: attempt + 1,
          error: message,
        },
        "Horizon connection error detected; switching endpoint",
      );
    }
  }

  const summary = errors
    .map(({ url, message }) => `${url}: ${message}`)
    .join(" | ");

  throw new Error(
    `All Horizon endpoints failed after ${totalAttempts} attempts. Errors: ${summary}`,
  );
}

/**
 * Load a Stellar account with Horizon failover support.
 *
 * @param {string} publicKey
 * @returns {Promise<Horizon.AccountResponse>}
 */
export async function loadAccount(publicKey) {
  if (!publicKey || typeof publicKey !== "string") {
    throw new TypeError("A valid Stellar public key is required.");
  }

  return withFailover((server) =>
    server.loadAccount(publicKey.trim()),
  );
}

/**
 * Submit a signed transaction with Horizon failover support.
 *
 * @param {import("@stellar/stellar-sdk").Transaction} transaction
 * @returns {Promise<Horizon.HorizonApi.SubmitTransactionResponse>}
 */
export async function submitTransaction(transaction) {
  if (!transaction) {
    throw new TypeError("A signed Stellar transaction is required.");
  }

  return withFailover((server) =>
    server.submitTransaction(transaction),
  );
}

/**
 * Fetch current network fee statistics with failover support.
 *
 * @returns {Promise<Horizon.HorizonApi.FeeStatsResponse>}
 */
export async function fetchFeeStats() {
  return withFailover((server) => server.feeStats());
}

/**
 * Return all configured Horizon endpoints for diagnostics.
 *
 * @returns {string[]}
 */
export function getConfiguredEndpoints() {
  return [...ALL_ENDPOINTS];
}

/**
 * Fetch fee statistics and return safe defaults if every Horizon endpoint
 * fails.
 *
 * @returns {Promise<Horizon.HorizonApi.FeeStatsResponse | typeof DEFAULT_FEE_STATS>}
 */
export async function getFeeStats() {
  try {
    return await fetchFeeStats();
  } catch (error) {
    horizonLogger.error(
      {
        error:
          error instanceof Error
            ? error.message
            : String(error),
      },
      "Unable to fetch Stellar fee statistics; using defaults",
    );

    return DEFAULT_FEE_STATS;
  }
}

/**
 * Calculate fee rates based on network congestion.
 *
 * @param {Object} feeStats
 * @returns {{ low: string, medium: string, high: string }}
 */
export function calculateOptimalFees(feeStats) {
  const p10 = Number.parseInt(
    feeStats?.fee_charged?.p10 || "100",
    10,
  );
  const p50 = Number.parseInt(
    feeStats?.fee_charged?.p50 || "100",
    10,
  );
  const p95 = Number.parseInt(
    feeStats?.fee_charged?.p95 || "100",
    10,
  );

  return {
    low: String(
      Math.max(100, Number.isFinite(p10) ? p10 : 100),
    ),
    medium: String(
      Math.max(100, Number.isFinite(p50) ? p50 : 100),
    ),
    high: String(
      Math.max(100, Number.isFinite(p95) ? p95 : 100),
    ),
  };
}

/**
 * Get the dynamic base fee for a priority tier.
 *
 * @param {"low" | "medium" | "high"} [tier]
 * @returns {Promise<string>}
 */
export async function getDynamicBaseFee(tier = "medium") {
  const feeStats = await getFeeStats();
  const optimalFees = calculateOptimalFees(feeStats);

  return optimalFees[tier] || optimalFees.medium;
}

/**
 * Check whether an account has a trustline for the requested asset.
 *
 * @param {string} publicKey Stellar G-address
 * @param {string} assetCode Asset code, for example USDC
 * @param {string} [issuerAddress] Optional asset issuer
 * @returns {Promise<{
 *   hasTrustline: boolean,
 *   balance?: string,
 *   issuer: string,
 *   instructions?: {
 *     message: string,
 *     steps: string[]
 *   }
 * }>}
 */
export async function checkBuyerTrustline(
  publicKey,
  assetCode,
  issuerAddress,
) {
  if (!publicKey || typeof publicKey !== "string") {
    throw new TypeError("A Stellar public key is required.");
  }

  if (!assetCode || typeof assetCode !== "string") {
    throw new TypeError("An asset code is required.");
  }

  const normalizedAssetCode = assetCode.trim().toUpperCase();

  const issuer =
    issuerAddress?.trim() ||
    process.env.NEXT_PUBLIC_USDC_ISSUER?.trim() ||
    KNOWN_USDC_ISSUERS[isMainnet ? "mainnet" : "testnet"];

  const account = await loadAccount(publicKey.trim());

  const trustline = account.balances.find(
    (balance) =>
      balance.asset_type !== "native" &&
      balance.asset_code === normalizedAssetCode &&
      balance.asset_issuer === issuer,
  );

  if (!trustline) {
    horizonLogger.info(
      {
        publicKey,
        assetCode: normalizedAssetCode,
        issuer,
      },
      "Buyer is missing the required asset trustline",
    );

    return {
      hasTrustline: false,
      issuer,
      instructions: {
        message: `Your wallet does not have an active trustline for ${normalizedAssetCode}.`,
        steps: [
          `Open your Stellar wallet and add ${normalizedAssetCode} issued by ${issuer}.`,
          "Confirm the issuer address before authorizing the asset.",
          `Network tool: ${
            isMainnet
              ? "https://accountviewer.stellar.org/"
              : "https://laboratory.stellar.org/"
          }`,
        ],
      },
    };
  }

  return {
    hasTrustline: true,
    balance: trustline.balance,
    issuer,
  };
}
