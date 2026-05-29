"use client";

/**
 * Interactive API documentation page (#83).
 *
 * Renders the OpenAPI spec at /docs/openapi.yaml using swagger-ui-react.
 * Route: /api-docs
 *
 * Install the peer dependency if it is not already present:
 *   npm install swagger-ui-react
 */

import dynamic from "next/dynamic";
import "swagger-ui-react/swagger-ui.css";

// Lazy-load SwaggerUI — it is large and only needed on this page.
const SwaggerUI = dynamic(() => import("swagger-ui-react"), { ssr: false });

export default function ApiDocsPage() {
  return (
    <div style={{ padding: "1rem", maxWidth: "1400px", margin: "0 auto" }}>
      <div style={{ marginBottom: "1rem" }}>
        <h1 style={{ fontSize: "2rem", fontWeight: 700, marginBottom: "0.35rem" }}>EduVault API docs</h1>
        <p style={{ color: "#475569" }}>
          Canonical reference for creator materials, purchase history, entitlements, and profile update flows.
        </p>
      </div>
      <SwaggerUI url="/openapi.yaml" docExpansion="list" />
    </div>
  );
}
