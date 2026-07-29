const SINK_NAME = "eduvault-safe-html";

const ALLOWED_TAGS = new Set([
  "b", "i", "em", "strong", "a", "p", "br", "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "code",
  "pre", "span", "div", "table", "thead", "tbody", "tr", "th", "td",
  "hr", "details", "summary", "mark", "small", "sub", "sup",
]);

const ALLOWED_ATTRIBUTES = new Set([
  "href", "title", "alt", "class", "id", "role", "aria-label",
  "aria-describedby", "data-testid",
]);

const ALLOWED_URL_PROTOCOLS = new Set(["https:", "mailto:", "#"]);

function sanitizeHtml(value) {
  if (value === undefined || value === null) return "";
  const cleaned = String(value).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return cleaned;
}

function stripDisallowedTags(html) {
  return html.replace(/<\/?(\w+)[^>]*>/g, (match, tagName) => {
    const lower = tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(lower)) return "";
    return match;
  });
}

function isSafeUrl(url) {
  try {
    const parsed = new URL(url, "https://eduvault.invalid");
    return ALLOWED_URL_PROTOCOLS.has(parsed.protocol);
  } catch {
    return false;
  }
}

export function createTrustedHtmlSink() {
  if (typeof trustedTypes === "undefined" || !trustedTypes.createPolicy) {
    return {
      createHTML: (html) => stripDisallowedTags(sanitizeHtml(html)),
      createScriptURL: (url) => {
        if (!isSafeUrl(url)) throw new TypeError("Blocked unsafe script URL");
        return url;
      },
      createScript: () => { throw new TypeError("Script creation blocked"); },
    };
  }

  try {
    return trustedTypes.createPolicy(SINK_NAME, {
      createHTML: (html) => stripDisallowedTags(sanitizeHtml(html)),
      createScriptURL: (url) => {
        if (!isSafeUrl(url)) throw new TypeError("Blocked unsafe script URL");
        return url;
      },
      createScript: () => { throw new TypeError("Script creation blocked by Trusted Types"); },
    });
  } catch {
    return getTrustedTypesPolicy() || {
      createHTML: (html) => stripDisallowedTags(sanitizeHtml(html)),
      createScriptURL: (url) => {
        if (!isSafeUrl(url)) throw new TypeError("Blocked unsafe script URL");
        return url;
      },
      createScript: () => { throw new TypeError("Script creation blocked"); },
    };
  }
}

export function getTrustedTypesPolicy() {
  if (typeof trustedTypes === "undefined") return null;
  try {
    return trustedTypes.getPolicy(SINK_NAME);
  } catch {
    return null;
  }
}

export const TRUSTED_TYPES_SINK_NAME = SINK_NAME;