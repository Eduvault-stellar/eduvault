#!/usr/bin/env node

/**
 * Validates GitHub issue and pull request templates, deliverable matrices,
 * and contributor documentation for GrantFox reward compliance.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Validates all issue templates, PR templates, and deliverable documentation.
 *
 * @param {string} root - Path to repository root.
 * @returns {Array<{ file: string, message: string }>} - List of validation errors found.
 */
export function validateTemplates(root = repoRoot) {
  const errors = [];

  const configPath = resolve(root, ".github/ISSUE_TEMPLATE/config.yml");
  if (!existsSync(configPath)) {
    errors.push({ file: ".github/ISSUE_TEMPLATE/config.yml", message: "Missing issue template config file" });
  } else {
    try {
      const config = YAML.parse(readFileSync(configPath, "utf-8"));
      if (config.blank_issues_enabled !== false) {
        errors.push({ file: ".github/ISSUE_TEMPLATE/config.yml", message: "blank_issues_enabled must be false" });
      }
      if (!Array.isArray(config.contact_links) || config.contact_links.length === 0) {
        errors.push({ file: ".github/ISSUE_TEMPLATE/config.yml", message: "contact_links array must be populated" });
      }
    } catch (parseError) {
      errors.push({ file: ".github/ISSUE_TEMPLATE/config.yml", message: `YAML parse error: ${parseError.message}` });
    }
  }

  const rewardFormPath = resolve(root, ".github/ISSUE_TEMPLATE/grantfox-reward-task.yml");
  if (!existsSync(rewardFormPath)) {
    errors.push({ file: ".github/ISSUE_TEMPLATE/grantfox-reward-task.yml", message: "Missing GrantFox reward YAML template" });
  } else {
    try {
      const form = YAML.parse(readFileSync(rewardFormPath, "utf-8"));
      if (!form.name || !form.description || !form.title) {
        errors.push({ file: ".github/ISSUE_TEMPLATE/grantfox-reward-task.yml", message: "Form missing required top-level metadata (name, description, title)" });
      }
      if (!Array.isArray(form.labels) || !form.labels.includes("GrantFox OSS")) {
        errors.push({ file: ".github/ISSUE_TEMPLATE/grantfox-reward-task.yml", message: "Form labels must include GrantFox OSS" });
      }
      if (!Array.isArray(form.body)) {
        errors.push({ file: ".github/ISSUE_TEMPLATE/grantfox-reward-task.yml", message: "Form body must be an array of fields" });
      } else {
        const fieldIds = new Set(form.body.map((item) => item.id).filter(Boolean));
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
        for (const reqId of requiredIds) {
          if (!fieldIds.has(reqId)) {
            errors.push({ file: ".github/ISSUE_TEMPLATE/grantfox-reward-task.yml", message: `Form missing required field ID: ${reqId}` });
          }
        }
      }
    } catch (parseError) {
      errors.push({ file: ".github/ISSUE_TEMPLATE/grantfox-reward-task.yml", message: `YAML parse error: ${parseError.message}` });
    }
  }

  const rewardMdPath = resolve(root, ".github/ISSUE_TEMPLATE/grantfox-reward-task.md");
  if (!existsSync(rewardMdPath)) {
    errors.push({ file: ".github/ISSUE_TEMPLATE/grantfox-reward-task.md", message: "Missing GrantFox reward markdown template" });
  } else {
    const content = readFileSync(rewardMdPath, "utf-8");
    const requiredSections = [
      "## Problem",
      "## Domain & Complexity",
      "## Scope",
      "## Reward Eligibility Pre-Flight Checklist",
      "## Domain Deliverable Matrix",
      "## Verification Artifacts & Test Plan",
      "## Security & Privacy Notes",
      "## Maintainer Review & Acceptance Expectations"
    ];
    for (const section of requiredSections) {
      if (!content.includes(section)) {
        errors.push({ file: ".github/ISSUE_TEMPLATE/grantfox-reward-task.md", message: `Missing required section: ${section}` });
      }
    }
  }

  const bugReportPath = resolve(root, ".github/ISSUE_TEMPLATE/bug_report.yml");
  if (!existsSync(bugReportPath)) {
    errors.push({ file: ".github/ISSUE_TEMPLATE/bug_report.yml", message: "Missing bug report form template" });
  } else {
    try {
      YAML.parse(readFileSync(bugReportPath, "utf-8"));
    } catch (parseError) {
      errors.push({ file: ".github/ISSUE_TEMPLATE/bug_report.yml", message: `YAML parse error: ${parseError.message}` });
    }
  }

  const featureRequestPath = resolve(root, ".github/ISSUE_TEMPLATE/feature_request.yml");
  if (!existsSync(featureRequestPath)) {
    errors.push({ file: ".github/ISSUE_TEMPLATE/feature_request.yml", message: "Missing feature request form template" });
  } else {
    try {
      YAML.parse(readFileSync(featureRequestPath, "utf-8"));
    } catch (parseError) {
      errors.push({ file: ".github/ISSUE_TEMPLATE/feature_request.yml", message: `YAML parse error: ${parseError.message}` });
    }
  }

  const prTemplatePath = resolve(root, ".github/PULL_REQUEST_TEMPLATE.md");
  if (!existsSync(prTemplatePath)) {
    errors.push({ file: ".github/PULL_REQUEST_TEMPLATE.md", message: "Missing pull request template" });
  } else {
    const prContent = readFileSync(prTemplatePath, "utf-8");
    const requiredPrSections = [
      "## Summary",
      "## Deliverable Matrix Checklist",
      "## Verification Artifacts",
      "## Security & Privacy Considerations",
      "## Payout Routing"
    ];
    for (const prSection of requiredPrSections) {
      if (!prContent.includes(prSection)) {
        errors.push({ file: ".github/PULL_REQUEST_TEMPLATE.md", message: `Missing required PR section: ${prSection}` });
      }
    }
  }

  const matrixDocPath = resolve(root, "docs/grantfox-reward-deliverables.md");
  if (!existsSync(matrixDocPath)) {
    errors.push({ file: "docs/grantfox-reward-deliverables.md", message: "Missing GrantFox deliverables documentation" });
  } else {
    const docContent = readFileSync(matrixDocPath, "utf-8");
    const requiredSubstrings = [
      "Frontend",
      "Backend API",
      "Soroban Smart Contracts",
      "Documentation",
      "Testing & Quality Assurance",
      "Maintainer Review"
    ];
    for (const sub of requiredSubstrings) {
      if (!docContent.includes(sub)) {
        errors.push({ file: "docs/grantfox-reward-deliverables.md", message: `Documentation missing section for: ${sub}` });
      }
    }
  }

  const contributingPath = resolve(root, "CONTRIBUTING.md");
  if (existsSync(contributingPath)) {
    const contributingContent = readFileSync(contributingPath, "utf-8");
    if (!contributingContent.includes("grantfox-reward-deliverables.md")) {
      errors.push({ file: "CONTRIBUTING.md", message: "CONTRIBUTING.md must reference grantfox-reward-deliverables.md" });
    }
  }

  return errors;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const errors = validateTemplates();
  if (errors.length > 0) {
    console.error("Template validation failed:");
    for (const err of errors) {
      console.error(`- [${err.file}] ${err.message}`);
    }
    process.exit(1);
  }
  console.log("Template validation passed: all issue templates, PR templates, and docs are compliant.");
  process.exit(0);
}
