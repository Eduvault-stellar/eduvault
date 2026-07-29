import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildContentSecurityPolicy,
  createCspNonce,
  normalizeCspReport,
  shouldRecordCspReport,
  STATIC_SECURITY_HEADERS,
} from "../../src/lib/security/csp.js";
import {
  normalizePlainText,
  normalizeExternalUrl,
  normalizeRemoteImageUrl,
  normalizeRedirectPath,
  normalizeDownloadFilename,
  contentDispositionAttachment,
} from "../../src/lib/security/input.js";
import {
  createTrustedHtmlSink,
  TRUSTED_TYPES_SINK_NAME,
} from "../../src/lib/security/trustedTypes.js";

describe("CSP", () => {
  test("buildContentSecurityPolicy generates a valid nonce-based policy", () => {
    const nonce = createCspNonce();
    const csp = buildContentSecurityPolicy(nonce);
    assert.ok(csp.includes(`'nonce-${nonce}'`));
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(csp.includes("base-uri 'none'"));
    assert.ok(csp.includes("object-src 'none'"));
    assert.ok(csp.includes("frame-ancestors 'none'"));
    assert.ok(csp.includes("form-action 'self'"));
    assert.ok(csp.includes("frame-src 'none'"));
  });

  test("CSP eliminates unsafe-eval", () => {
    const nonce = createCspNonce();
    const csp = buildContentSecurityPolicy(nonce);
    assert.ok(!csp.includes("'unsafe-eval'"), "CSP must not contain unsafe-eval");
  });

  test("CSP eliminates unnecessary unsafe-inline in script-src", () => {
    const nonce = createCspNonce();
    const csp = buildContentSecurityPolicy(nonce);
    const scriptSrcMatch = csp.match(/script-src[^;]*/);
    if (scriptSrcMatch) {
      assert.ok(
        !scriptSrcMatch[0].includes("'unsafe-inline'"),
        "script-src must not contain unsafe-inline"
      );
    }
  });

  test("CSP requires trusted-types for script", () => {
    const nonce = createCspNonce();
    const csp = buildContentSecurityPolicy(nonce);
    assert.ok(csp.includes("require-trusted-types-for 'script'"));
  });

  test("CSP includes eduvault-safe-html trusted types policy", () => {
    const nonce = createCspNonce();
    const csp = buildContentSecurityPolicy(nonce);
    assert.ok(csp.includes("trusted-types eduvault-safe-html"));
  });

  test("CSP nonce is 32 hex characters", () => {
    const nonce = createCspNonce();
    assert.ok(/^[a-f0-9]{32}$/i.test(nonce));
  });

  test("CSP nonce is unique per call", () => {
    const nonce1 = createCspNonce();
    const nonce2 = createCspNonce();
    assert.notEqual(nonce1, nonce2);
  });

  test("buildContentSecurityPolicy throws on invalid nonce", () => {
    assert.throws(() => buildContentSecurityPolicy("invalid"), /Invalid CSP nonce/);
  });

  test("CSP report-uri and report-to are configured", () => {
    const nonce = createCspNonce();
    const csp = buildContentSecurityPolicy(nonce);
    assert.ok(csp.includes("report-uri /api/csp-report"));
    assert.ok(csp.includes("report-to csp-endpoint"));
  });
});

describe("STATIC_SECURITY_HEADERS", () => {
  test("includes HSTS with preload", () => {
    assert.ok(
      STATIC_SECURITY_HEADERS["Strict-Transport-Security"].includes("max-age=31536000"),
    );
    assert.ok(
      STATIC_SECURITY_HEADERS["Strict-Transport-Security"].includes("includeSubDomains"),
    );
    assert.ok(
      STATIC_SECURITY_HEADERS["Strict-Transport-Security"].includes("preload"),
    );
  });

  test("includes X-Frame-Options DENY", () => {
    assert.equal(STATIC_SECURITY_HEADERS["X-Frame-Options"], "DENY");
  });

  test("includes X-Content-Type-Options nosniff", () => {
    assert.equal(STATIC_SECURITY_HEADERS["X-Content-Type-Options"], "nosniff");
  });

  test("includes Referrer-Policy strict-origin-when-cross-origin", () => {
    assert.equal(STATIC_SECURITY_HEADERS["Referrer-Policy"], "strict-origin-when-cross-origin");
  });

  test("includes COOP/COEP/CORP", () => {
    assert.equal(STATIC_SECURITY_HEADERS["Cross-Origin-Opener-Policy"], "same-origin-allow-popups");
    assert.equal(STATIC_SECURITY_HEADERS["Cross-Origin-Embedder-Policy"], "credentialless");
    assert.equal(STATIC_SECURITY_HEADERS["Cross-Origin-Resource-Policy"], "same-origin");
  });

  test("includes Permissions-Policy with restrictive defaults", () => {
    const pp = STATIC_SECURITY_HEADERS["Permissions-Policy"];
    assert.ok(pp.includes("camera=()"));
    assert.ok(pp.includes("microphone=()"));
    assert.ok(pp.includes("geolocation=()"));
    assert.ok(pp.includes("payment=()"));
    assert.ok(pp.includes("usb=()"));
  });
});

describe("normalizePlainText", () => {
  test("strips control characters and BIDI marks", () => {
    const result = normalizePlainText("hello\u0000world\u202E");
    assert.ok(!result.includes("\u0000"));
    assert.ok(!result.includes("\u202E"));
  });

  test("escapes HTML angle brackets", () => {
    const result = normalizePlainText("<script>alert(1)</script>");
    assert.ok(!result.includes("<script>"));
    assert.ok(result.includes("＜script＞"));
  });

  test("normalizes Unicode NFKC", () => {
    const result = normalizePlainText("café");
    assert.ok(result.includes("café"));
  });

  test("truncates to maxLength", () => {
    const long = "a".repeat(10000);
    const result = normalizePlainText(long, { maxLength: 100 });
    assert.equal(result.length, 100);
  });

  test("returns empty string for null/undefined", () => {
    assert.equal(normalizePlainText(null), "");
    assert.equal(normalizePlainText(undefined), "");
  });
});

describe("normalizeExternalUrl", () => {
  test("accepts valid HTTPS URLs", () => {
    const result = normalizeExternalUrl("https://example.com/path", {
      allowedHosts: ["example.com"],
    });
    assert.equal(result, "https://example.com/path");
  });

  test("rejects HTTP URLs", () => {
    assert.throws(() => normalizeExternalUrl("http://example.com"), /URL must use public HTTPS/);
  });

  test("rejects URLs with credentials", () => {
    assert.throws(() => normalizeExternalUrl("https://user:pass@example.com"), /credentials/);
  });

  test("rejects non-allowlisted hosts", () => {
    assert.throws(() => normalizeExternalUrl("https://evil.com", { allowedHosts: ["example.com"] }), /not allowlisted/);
  });

  test("strips hash fragments", () => {
    const result = normalizeExternalUrl("https://example.com/path#fragment", {
      allowedHosts: ["example.com"],
    });
    assert.equal(result, "https://example.com/path");
  });

  test("rejects relative URLs", () => {
    assert.throws(() => normalizeExternalUrl("/path"), /URL must be absolute/);
  });
});

describe("normalizeRemoteImageUrl", () => {
  test("rejects SVG files", () => {
    assert.throws(() => normalizeRemoteImageUrl("https://gateway.pinata.cloud/image.svg"), /SVG is not accepted/);
  });

  test("rejects SVG with query params", () => {
    assert.throws(() => normalizeRemoteImageUrl("https://gateway.pinata.cloud/image.svg?size=large"), /SVG is not accepted/);
  });

  test("accepts PNG from allowlisted hosts", () => {
    const result = normalizeRemoteImageUrl("https://gateway.pinata.cloud/image.png");
    assert.ok(result.includes("gateway.pinata.cloud"));
  });

  test("accepts relative paths for same-origin images", () => {
    const result = normalizeRemoteImageUrl("/images/photo.png");
    assert.equal(result, "/images/photo.png");
  });
});

describe("normalizeRedirectPath", () => {
  test("accepts valid relative paths", () => {
    assert.equal(normalizeRedirectPath("/dashboard"), "/dashboard");
  });

  test("rejects protocol-relative URLs", () => {
    assert.equal(normalizeRedirectPath("//evil.com"), "/");
  });

  test("rejects absolute URLs", () => {
    assert.equal(normalizeRedirectPath("https://evil.com"), "/");
  });

  test("rejects paths with backslashes", () => {
    assert.equal(normalizeRedirectPath("/path\\evil"), "/");
  });

  test("falls back to default for invalid input", () => {
    assert.equal(normalizeRedirectPath("javascript:alert(1)"), "/");
  });
});

describe("normalizeDownloadFilename", () => {
  test("sanitizes dangerous characters", () => {
    const result = normalizeDownloadFilename("file<script>.exe");
    assert.ok(!result.includes("<script>"));
  });

  test("strips path traversal", () => {
    const result = normalizeDownloadFilename("../../etc/passwd");
    assert.equal(result, "passwd");
  });

  test("truncates to maxLength", () => {
    const long = "a".repeat(200);
    const result = normalizeDownloadFilename(long, { maxLength: 50 });
    assert.ok(result.length <= 50);
  });

  test("falls back to default for empty result", () => {
    const result = normalizeDownloadFilename("");
    assert.equal(result, "download");
  });
});

describe("contentDispositionAttachment", () => {
  test("generates safe Content-Disposition header", () => {
    const result = contentDispositionAttachment("report.pdf");
    assert.ok(result.includes('filename="report.pdf"'));
  });

  test("escapes non-ASCII characters", () => {
    const result = contentDispositionAttachment("café.pdf");
    assert.ok(result.includes("caf_"));
    assert.ok(result.includes("UTF-8"));
  });
});

describe("Trusted Types sink", () => {
  test("createTrustedHtmlSink returns a policy object", () => {
    const sink = createTrustedHtmlSink();
    assert.ok(sink);
    assert.ok(typeof sink.createHTML === "function");
    assert.ok(typeof sink.createScriptURL === "function");
  });

  test("createHTML strips disallowed tags", () => {
    const sink = createTrustedHtmlSink();
    const result = sink.createHTML('<b>safe</b><script>alert(1)</script>');
    assert.ok(result.includes("<b>safe</b>"));
    assert.ok(!result.includes("<script>"));
  });

  test("createHTML preserves allowed tags", () => {
    const sink = createTrustedHtmlSink();
    const result = sink.createHTML("<p>Hello <strong>world</strong></p>");
    assert.ok(result.includes("<p>"));
    assert.ok(result.includes("<strong>"));
  });

  test("createScriptURL blocks unsafe URLs", () => {
    const sink = createTrustedHtmlSink();
    assert.throws(() => sink.createScriptURL("javascript:alert(1)"), /Blocked unsafe/);
  });

  test("createScriptURL allows safe URLs", () => {
    const sink = createTrustedHtmlSink();
    const result = sink.createScriptURL("https://example.com/script.js");
    assert.equal(result, "https://example.com/script.js");
  });

  test("createScript throws", () => {
    const sink = createTrustedHtmlSink();
    assert.throws(() => sink.createScript(), /Script creation blocked/);
  });

  test("TRUSTED_TYPES_SINK_NAME is exported", () => {
    assert.equal(TRUSTED_TYPES_SINK_NAME, "eduvault-safe-html");
  });
});

describe("CSP report normalization", () => {
  test("normalizes a standard CSP violation report", () => {
    const report = normalizeCspReport({
      "csp-report": {
        "effective-directive": "script-src",
        "blocked-uri": "https://evil.com/script.js",
        "document-uri": "https://eduvault.app/page",
        "source-file": "https://evil.com/script.js",
        disposition: "enforce",
        "status-code": 200,
      },
    });
    assert.equal(report.effectiveDirective, "script-src");
    assert.equal(report.blockedUrl, "https://evil.com/script.js");
    assert.equal(report.disposition, "enforce");
  });

  test("redacts private URL details", () => {
    const report = normalizeCspReport({
      "csp-report": {
        "blocked-uri": "https://user:secret@example.com/script.js",
      },
    });
    assert.ok(!report.blockedUrl.includes("secret"));
  });

  test("returns null for invalid payload", () => {
    assert.equal(normalizeCspReport(null), null);
    assert.equal(normalizeCspReport("not-an-object"), null);
  });
});

describe("CSP report sampling", () => {
  test("shouldRecordCspReport returns true for new unique reports", () => {
    const report = {
      effectiveDirective: "script-src",
      blockedUrl: "https://evil.com/script.js",
      documentUrl: "https://eduvault.app/page",
      sourceUrl: "https://evil.com/script.js",
      disposition: "enforce",
    };
    assert.ok(shouldRecordCspReport(report, { sampleRate: 1.0 }));
  });

  test("shouldRecordCspReport returns false for duplicate reports within window", () => {
    const report = {
      effectiveDirective: "script-src",
      blockedUrl: "https://evil.com/script.js",
      documentUrl: "https://eduvault.app/page",
      sourceUrl: "https://evil.com/script.js",
      disposition: "enforce",
    };
    shouldRecordCspReport(report, { sampleRate: 1.0 });
    assert.ok(!shouldRecordCspReport(report, { sampleRate: 1.0 }));
  });

  test("shouldRecordCspReport respects sampleRate", () => {
    const report = {
      effectiveDirective: "script-src",
      blockedUrl: "https://evil.com/script.js",
      documentUrl: "https://eduvault.app/page",
      sourceUrl: "https://evil.com/script.js",
      disposition: "enforce",
    };
    assert.ok(!shouldRecordCspReport(report, { sampleRate: 0.0 }));
  });
});