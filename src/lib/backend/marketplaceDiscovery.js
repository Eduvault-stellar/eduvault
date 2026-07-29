import { MATERIAL_STATUS } from "../materials/materialLifecycleConstants.js";

export const LICENSE_OPTIONS = [
  { id: "standard", label: "Standard License (download only)", value: "Standard License (download only)" },
  { id: "creative-commons", label: "Creative Commons", value: "Creative Commons" },
  { id: "private-use", label: "Private Use Only", value: "Private Use Only" },
];

export const CONTENT_TYPE_OPTIONS = [
  { id: "pdf", label: "PDF" },
  { id: "word", label: "Word" },
  { id: "presentation", label: "Presentation" },
  { id: "spreadsheet", label: "Spreadsheet" },
  { id: "text", label: "Text" },
  { id: "zip", label: "ZIP" },
];

export const NEWEST_OPTIONS = [
  { id: "7d", label: "Last 7 days", days: 7 },
  { id: "30d", label: "Last 30 days", days: 30 },
  { id: "90d", label: "Last 90 days", days: 90 },
];

export const CURSOR_VERSION = 1;
export const MAX_SEARCH_LENGTH = 120;
export const MAX_CLAUSES = 10;
export const MAX_RESULT_WINDOW = 100;
export const MAX_PAGE_SIZE = 50;
export const MIN_PAGE_SIZE = 1;
export const MAX_REGEX_LENGTH = 50;
export const VALID_SORT_FIELDS = new Set([
  "newest",
  "popular",
  "rating_desc",
  "price_asc",
  "price_desc",
  "relevance_desc",
]);

const CONTENT_TYPE_PATTERNS = {
  pdf: ["pdf", "application/pdf"],
  word: ["doc", "docx", "word", "msword", "officedocument.wordprocessingml"],
  presentation: ["ppt", "pptx", "powerpoint", "presentationml"],
  spreadsheet: ["xls", "xlsx", "excel", "spreadsheetml"],
  text: ["txt", "text/plain"],
  zip: ["zip", "application/zip", "x-zip-compressed"],
};

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function sanitizeString(value, { maxLength = 5000 } = {}) {
  if (value === undefined || value === null) return "";
  return String(value).replace(CONTROL_CHARS, "").trim().slice(0, maxLength);
}

function escapeRegExp(value) {
  return sanitizeString(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function numberParam(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getLicenseValue(value) {
  const clean = sanitizeString(value, { maxLength: 120 });
  if (!clean) return null;
  return LICENSE_OPTIONS.find((option) => option.id === clean || option.value === clean)?.value || clean;
}

function getNewestDate(value, now = new Date()) {
  const clean = sanitizeString(value, { maxLength: 20 });
  const option = NEWEST_OPTIONS.find((item) => item.id === clean);
  if (!option) return null;

  const date = new Date(now);
  date.setDate(date.getDate() - option.days);
  return date;
}

function buildContentTypeQuery(value) {
  const clean = sanitizeString(value, { maxLength: 60 }).toLowerCase();
  const patterns = CONTENT_TYPE_PATTERNS[clean];
  if (!patterns) return null;

  const regex = new RegExp(patterns.map(escapeRegExp).join("|"), "i");
  return {
    $or: [
      { fileType: regex },
      { contentType: regex },
      { mimeType: regex },
      { fileName: regex },
      { storageKey: regex },
    ],
  };
}

export function encodeCursor(createdAt, id) {
  const payload = `${CURSOR_VERSION}|${createdAt.toISOString()}|${id}`;
  return Buffer.from(payload).toString("base64");
}

export function decodeCursor(cursor) {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf-8");
    const parts = decoded.split("|");
    if (parts.length !== 3) throw new Error("Invalid cursor format");
    const version = Number(parts[0]);
    if (version !== CURSOR_VERSION) throw new Error(`Incompatible cursor version: ${version}`);
    const createdAt = new Date(parts[1]);
    if (Number.isNaN(createdAt.getTime())) throw new Error("Invalid cursor date");
    return { createdAt, id: parts[2] };
  } catch (err) {
    if (err.message.startsWith("Invalid cursor") || err.message.startsWith("Incompatible cursor")) throw err;
    throw new Error(`Invalid cursor: ${err.message}`);
  }
}

export function buildMarketplaceDiscoveryQuery(searchParams, { now = new Date(), maxClauses = MAX_CLAUSES } = {}) {
  const query = {
    visibility: "public",
    status: MATERIAL_STATUS.PUBLISHED,
    $or: [
      { relevanceStatus: { $exists: false } },
      { relevanceStatus: { $ne: "low" } },
    ],
  };
  const andClauses = [];

  const search = sanitizeString(searchParams.get("search"), { maxLength: MAX_SEARCH_LENGTH });
  if (search) {
    const cleaned = search.replace(/[*[\]{}()\\^$|?]/g, "");
    if (cleaned.length > MAX_REGEX_LENGTH) {
      throw new Error(`Search term too long for regex matching (max ${MAX_REGEX_LENGTH} characters after sanitization)`);
    }
    const regex = new RegExp(escapeRegExp(cleaned), "i");
    andClauses.push({
      $or: [
        { title: regex },
        { description: regex },
        { shortSummary: regex },
        { author: regex },
        { subject: regex },
      ],
    });
  }

  const subject = sanitizeString(searchParams.get("subject"), { maxLength: 80 });
  const category = sanitizeString(searchParams.get("category"), { maxLength: 80 });
  const level = sanitizeString(searchParams.get("level"), { maxLength: 80 });
  const creator = sanitizeString(searchParams.get("creator"), { maxLength: 120 });
  const licenseType = getLicenseValue(searchParams.get("licenseType") || searchParams.get("usageRights"));
  const contentTypeQuery = buildContentTypeQuery(searchParams.get("contentType"));
  const minPrice = numberParam(searchParams.get("minPrice"));
  const maxPrice = numberParam(searchParams.get("maxPrice"));
  const minRating = numberParam(searchParams.get("minRating"));
  const newestDate = getNewestDate(searchParams.get("newest"), now);

  if (subject) query.subject = subject;
  if (category) query.category = category;
  if (level) query.level = level;
  if (creator) query.author = creator;
  if (licenseType) query.usageRights = licenseType;
  if (contentTypeQuery) andClauses.push(contentTypeQuery);

  if (minPrice !== null || maxPrice !== null) {
    query.price = {};
    if (minPrice !== null) query.price.$gte = minPrice;
    if (maxPrice !== null) query.price.$lte = maxPrice;
  }

  if (minRating !== null) {
    query.rating = { $gte: minRating };
  }

  if (newestDate) {
    query.createdAt = { $gte: newestDate };
  }

  if (andClauses.length > 0) {
    if (andClauses.length > maxClauses) {
      throw new Error(`Query exceeds maximum clause limit of ${maxClauses}`);
    }
    query.$and = andClauses;
  }

  return query;
}

export function buildMarketplaceSort(sortBy) {
  switch (sortBy) {
    case "price_asc":
      return { price: 1, createdAt: -1, _id: 1 };
    case "price_desc":
      return { price: -1, createdAt: -1, _id: 1 };
    case "rating_desc":
      return { rating: -1, createdAt: -1, _id: 1 };
    case "popular":
      return { likes: -1, rating: -1, createdAt: -1, _id: 1 };
    case "relevance_desc":
      return { relevanceScore: -1, createdAt: -1, _id: 1 };
    case "newest":
    default:
      return { createdAt: -1, _id: 1 };
  }
}

export function computeRelevanceScore(material, searchTerm) {
  if (!searchTerm) return 0;
  const term = searchTerm.toLowerCase();
  let score = 0;

  const title = (material.title || "").toLowerCase();
  const description = (material.description || "").toLowerCase();
  const shortSummary = (material.shortSummary || "").toLowerCase();
  const subject = (material.subject || "").toLowerCase();

  if (title.includes(term)) score += 10;
  if (shortSummary.includes(term)) score += 5;
  if (description.includes(term)) score += 2;
  if (subject === term) score += 8;

  const tagMatches = (material.tags || []).filter((tag) => tag.toLowerCase().includes(term));
  score += tagMatches.length * 3;

  const rating = Number(material.averageScore ?? material.rating ?? 0);
  score += Math.min(rating, 5) * 0.5;

  const likes = Number(material.likes ?? 0);
  score += Math.min(likes, 100) * 0.01;

  return Math.round(score * 100) / 100;
}

export function validateSortField(sortBy) {
  if (!sortBy || VALID_SORT_FIELDS.has(sortBy)) return sortBy || "newest";
  throw new Error(`Invalid sort field: "${sortBy}". Allowed: ${[...VALID_SORT_FIELDS].join(", ")}`);
}

export function clampResultWindow(page, pageSize) {
  const safePageSize = Math.max(MIN_PAGE_SIZE, Math.min(MAX_PAGE_SIZE, pageSize));
  const safePage = Math.max(1, page);
  if ((safePage - 1) * safePageSize > MAX_RESULT_WINDOW) {
    throw new Error(`Result window exceeds maximum of ${MAX_RESULT_WINDOW}`);
  }
  return { page: safePage, pageSize: safePageSize };
}
