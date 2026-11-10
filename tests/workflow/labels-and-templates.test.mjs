import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

describe('EduVault Contributor Reward & Issue Workflow (Issue #210)', () => {
  const labelsFile = path.join(projectRoot, '.github/labels.yml');
  const templateDir = path.join(projectRoot, '.github/ISSUE_TEMPLATE');
  const rewardTemplateFile = path.join(templateDir, 'reward-task.yml');
  const configTemplateFile = path.join(templateDir, 'config.yml');
  const contributingFile = path.join(projectRoot, 'CONTRIBUTING.md');

  test('.github/labels.yml exists and defines complete taxonomy', () => {
    assert.ok(fs.existsSync(labelsFile), 'labels.yml should exist');
    const content = fs.readFileSync(labelsFile, 'utf8');

    // Parse items by regex
    const nameMatches = [...content.matchAll(/- name:\s*"([^"]+)"/g)].map(m => m[1]);
    const colorMatches = [...content.matchAll(/color:\s*"([^"]+)"/g)].map(m => m[1]);
    const descMatches = [...content.matchAll(/description:\s*"([^"]+)"/g)].map(m => m[1]);

    assert.ok(nameMatches.length >= 15, `Expected at least 15 labels, found ${nameMatches.length}`);
    assert.equal(nameMatches.length, colorMatches.length, 'Every label must have a color');
    assert.equal(nameMatches.length, descMatches.length, 'Every label must have a description');

    // Verify hex colors
    for (const color of colorMatches) {
      assert.match(color, /^[0-9a-fA-F]{6}$/, `Color ${color} must be 6-digit hex`);
    }

    // Verify uniqueness
    const uniqueNames = new Set(nameMatches);
    assert.equal(uniqueNames.size, nameMatches.length, 'All label names must be unique');

    // Verify required categories
    const requiredLabels = [
      'reward: eligible',
      'reward: claimed',
      'reward: in-review',
      'reward: verified',
      'reward: completed',
      'difficulty: easy (50 pts)',
      'difficulty: medium (100 pts)',
      'difficulty: hard (200 pts)',
      'review: smart-contract',
      'review: frontend',
      'review: backend',
      'review: security',
      'review: documentation',
      'proof: automated-tests',
      'proof: ui-recording',
      'proof: stellar-tx-hash'
    ];

    for (const req of requiredLabels) {
      assert.ok(uniqueNames.has(req), `Missing required label: ${req}`);
    }
  });

  test('.github/ISSUE_TEMPLATE forms are configured correctly', () => {
    assert.ok(fs.existsSync(configTemplateFile), 'config.yml should exist');
    const configContent = fs.readFileSync(configTemplateFile, 'utf8');
    assert.match(configContent, /blank_issues_enabled:\s*false/, 'Blank issues should be disabled');
    assert.match(configContent, /GrantFox Campaign & Stellar Wave/, 'Contact link to GrantFox should exist');

    assert.ok(fs.existsSync(rewardTemplateFile), 'reward-task.yml should exist');
    const rewardContent = fs.readFileSync(rewardTemplateFile, 'utf8');
    assert.match(rewardContent, /name:\s*"GrantFox \/ Stellar Reward Task"/, 'Template name must be defined');
    assert.match(rewardContent, /id:\s*difficulty/, 'Template must have difficulty selector');
    assert.match(rewardContent, /id:\s*review_path/, 'Template must have review_path selector');
    assert.match(rewardContent, /id:\s*proof_requirements/, 'Template must have proof_requirements selector');
    assert.match(rewardContent, /id:\s*acceptance_criteria/, 'Template must have acceptance criteria');
  });

  test('CONTRIBUTING.md documents taxonomy, triage SLA, and proof criteria', () => {
    assert.ok(fs.existsSync(contributingFile), 'CONTRIBUTING.md should exist');
    const contributingContent = fs.readFileSync(contributingFile, 'utf8');

    // Section presence
    assert.match(contributingContent, /## Contributor Reward & Issue Workflow/, 'Workflow section required');
    assert.match(contributingContent, /### Label Taxonomy & Difficulty Tiers/, 'Taxonomy section required');
    assert.match(contributingContent, /### Review Paths & Domain Specialization/, 'Review path section required');
    assert.match(contributingContent, /### Required Verification Proofs/, 'Proof section required');
    assert.match(contributingContent, /### Claim & Assignment Protocol/, 'Claim protocol required');
    assert.match(contributingContent, /### Maintainer Triage & Lifecycle Rules/, 'Triage rules required');

    // Key labels documented
    assert.match(contributingContent, /difficulty: easy \(50 pts\)/);
    assert.match(contributingContent, /difficulty: medium \(100 pts\)/);
    assert.match(contributingContent, /difficulty: hard \(200 pts\)/);
    assert.match(contributingContent, /review: smart-contract/);
    assert.match(contributingContent, /review: frontend/);
    assert.match(contributingContent, /review: backend/);
    assert.match(contributingContent, /review: security/);
    assert.match(contributingContent, /review: documentation/);
    assert.match(contributingContent, /proof: automated-tests/);
    assert.match(contributingContent, /proof: ui-recording/);
    assert.match(contributingContent, /proof: stellar-tx-hash/);
  });
});
