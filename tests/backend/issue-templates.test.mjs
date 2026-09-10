import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

import { validateTemplates } from "../../scripts/check-issue-templates.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("validateTemplates passes without any errors on repository", () => {
  const errors = validateTemplates(repoRoot);
  assert.deepEqual(errors, []);
});

test("issue template config disables blank issues and provides required links", () => {
  const configPath = resolve(repoRoot, ".github/ISSUE_TEMPLATE/config.yml");
  assert.ok(existsSync(configPath));

  const config = YAML.parse(readFileSync(configPath, "utf-8"));
  assert.equal(config.blank_issues_enabled, false);
  assert.ok(Array.isArray(config.contact_links));
  assert.ok(config.contact_links.some((link) => link.name.includes("GrantFox")));
});

test("grantfox-reward-task.yml defines all required fields and domain options", () => {
  const formPath = resolve(repoRoot, ".github/ISSUE_TEMPLATE/grantfox-reward-task.yml");
  assert.ok(existsSync(formPath));

  const form = YAML.parse(readFileSync(formPath, "utf-8"));
  assert.equal(form.name, "GrantFox Reward Task");
  assert.ok(form.labels.includes("GrantFox OSS"));

  const fieldIds = form.body.map((item) => item.id).filter(Boolean);
  const requiredIds = [
    "domain",
    "complexity",
    "problem",
    "scope",
    "eligibility",
    "deliverables",
    "test_plan",
    "security_notes",
    "maintainer_review"
  ];

  for (const id of requiredIds) {
    assert.ok(fieldIds.includes(id), `Missing form field id: ${id}`);
  }

  const domainField = form.body.find((item) => item.id === "domain");
  assert.ok(domainField);
  const domainOptions = domainField.attributes.options.join(" ");
  assert.match(domainOptions, /Frontend/);
  assert.match(domainOptions, /Backend API/);
  assert.match(domainOptions, /Soroban Smart Contracts/);
  assert.match(domainOptions, /Documentation/);
  assert.match(domainOptions, /Testing/);
});

test("grantfox-reward-task.md contains all structured headings", () => {
  const mdPath = resolve(repoRoot, ".github/ISSUE_TEMPLATE/grantfox-reward-task.md");
  assert.ok(existsSync(mdPath));

  const content = readFileSync(mdPath, "utf-8");
  assert.match(content, /## Problem/);
  assert.match(content, /## Domain & Complexity/);
  assert.match(content, /## Scope/);
  assert.match(content, /## Reward Eligibility Pre-Flight Checklist/);
  assert.match(content, /## Domain Deliverable Matrix/);
  assert.match(content, /## Verification Artifacts & Test Plan/);
  assert.match(content, /## Security & Privacy Notes/);
  assert.match(content, /## Maintainer Review & Acceptance Expectations/);
});

test("pull request template contains deliverable checklist and payout routing", () => {
  const prPath = resolve(repoRoot, ".github/PULL_REQUEST_TEMPLATE.md");
  assert.ok(existsSync(prPath));

  const prContent = readFileSync(prPath, "utf-8");
  assert.match(prContent, /## Deliverable Matrix Checklist/);
  assert.match(prContent, /## Verification Artifacts/);
  assert.match(prContent, /## Security & Privacy Considerations/);
  assert.match(prContent, /## Payout Routing/);
  assert.match(prContent, /0xF46C9F6d70C50BF81ef3588AB523a90a594a2F89/);
  assert.match(prContent, /GCL6OXAMLD75BMTINA6EMRUDWK5THQUSHMYNLSNBCJAPZJHNYJTUNIBC/);
});

test("grantfox-reward-deliverables.md defines stack requirements and maintainer review gates", () => {
  const docPath = resolve(repoRoot, "docs/grantfox-reward-deliverables.md");
  assert.ok(existsSync(docPath));

  const content = readFileSync(docPath, "utf-8");
  assert.match(content, /### 3\.1 Frontend/);
  assert.match(content, /### 3\.2 Backend API/);
  assert.match(content, /### 3\.3 Soroban Smart Contracts/);
  assert.match(content, /### 3\.4 Documentation & Infrastructure/);
  assert.match(content, /### 3\.5 Testing & Quality Assurance/);
  assert.match(content, /## 4\. Required Verification Artifacts/);
  assert.match(content, /## 5\. Security & Privacy Review Gates/);
  assert.match(content, /## 6\. Maintainer Review & Settlement Workflow/);
});
