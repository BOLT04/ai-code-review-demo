import assert from "node:assert/strict";
import { test } from "node:test";
import { applyValidationResult, filterDiffByPathPrefix, isPlaceable, parseReviewerFindings, parseValidationResult } from "../src/application/findings.ts";
import type { FindingCandidate } from "../src/application/types.ts";

const candidate: FindingCandidate = {
  id: "F001",
  agent: "code",
  severity: "major",
  file: "src/example.ts",
  startLine: null,
  line: 12,
  body: "🟠 **Incorrect result**\n\nThe changed branch returns the wrong value.",
};

test("filterDiffByPathPrefix_ShouldRetainOnlyChangesTouchingTheRequestedPath", () => {
  const diff = [
    "diff --git a/README.md b/README.md",
    "index 1234567..abcdefg 100644",
    "--- a/README.md",
    "+++ b/README.md",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/src/js-codebase/domain/cache.ts b/src/js-codebase/domain/cache.ts",
    "index 1234567..abcdefg 100644",
    "--- a/src/js-codebase/domain/cache.ts",
    "+++ b/src/js-codebase/domain/cache.ts",
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "diff --git a/src/js-codebase/domain/removed.ts b/src/js-codebase/domain/removed.ts",
    "deleted file mode 100644",
    "--- a/src/js-codebase/domain/removed.ts",
    "+++ /dev/null",
    "diff --git a/src/copilot-review/tests/runner.test.ts b/src/copilot-review/tests/runner.test.ts",
    "index 1234567..abcdefg 100644",
    "--- a/src/copilot-review/tests/runner.test.ts",
    "+++ b/src/copilot-review/tests/runner.test.ts",
  ].join("\n");

  const scopedDiff = filterDiffByPathPrefix(diff, "src/js-codebase/");

  assert.match(scopedDiff, /src\/js-codebase\/domain\/cache\.ts/);
  assert.match(scopedDiff, /src\/js-codebase\/domain\/removed\.ts/);
  assert.doesNotMatch(scopedDiff, /README\.md|src\/copilot-review/);
});

test("parseReviewerFindings_ShouldUseTrustedReviewerIdentity", () => {
  const findings = parseReviewerFindings(JSON.stringify([{
    severity: "major",
    file: "src/example.ts",
    startLine: null,
    line: 12,
    body: candidate.body,
  }]), "code");

  assert.equal(findings.length, 1);
  assert.equal(findings[0].agent, "code");
});

test("parseReviewerFindings_ShouldSupportOnlyContiguousCommentableSuggestionRanges", () => {
  const [finding] = parseReviewerFindings(JSON.stringify([{
    severity: "major",
    file: "src/example.ts",
    startLine: 10,
    line: 12,
    body: "🟠 **Incorrect result**\n\n```suggestion\nreplacement\n```",
  }]), "code");

  assert.equal(finding?.startLine, 10);
  assert.equal(isPlaceable(finding!, new Map([["src/example.ts", new Set([10, 11, 12])]])), true);
  assert.equal(isPlaceable(finding!, new Map([["src/example.ts", new Set([10, 12])]])), false);
  assert.throws(() => parseReviewerFindings(JSON.stringify([{
    severity: "major",
    file: "src/example.ts",
    startLine: 13,
    line: 12,
    body: candidate.body,
  }]), "code"), /invalid line range/);
});

test("parseReviewerFindings_ShouldRejectMalformedOrNonArrayOutput", () => {
  assert.throws(() => parseReviewerFindings("not JSON", "code"), /returned invalid JSON/);
  assert.throws(() => parseReviewerFindings("{}", "code"), /must return a JSON array/);
  assert.throws(() => parseReviewerFindings(JSON.stringify([{
    agent: "untrusted-agent",
    severity: "major",
    file: "src/example.ts",
    line: 12,
    body: candidate.body,
  }]), "code"), /unexpected: agent/);
});

test("parseReviewerFindings_ShouldEnforceExactSchemaKeysAndRequiredNullableFields", () => {
  assert.throws(() => parseReviewerFindings(JSON.stringify([{
    severity: "major",
    file: "src/example.ts",
    line: 12,
    body: candidate.body,
    explanation: "extra key",
  }]), "code"), /unexpected: explanation/);
  assert.throws(() => parseReviewerFindings(JSON.stringify([{
    severity: "major",
    body: candidate.body,
  }]), "code"), /missing: file, startLine, line/);
});

test("applyValidationResult_ShouldKeepConfirmedAndAnnotateRevisedFindings", () => {
  const candidates = [
    candidate,
    { ...candidate, id: "F002", severity: "major" as const, body: "🟠 **Slow path**\n\nThis is slower than necessary." },
  ];
  const validation = parseValidationResult(JSON.stringify({
    summary: "Two issues are supported by the diff.",
    decisions: [
      {
        id: "F001",
        status: "confirmed",
        severity: "major",
        rationale: "The changed return is inconsistent with the caller contract.",
        body: candidate.body,
        startLine: null,
        line: 12,
      },
      {
        id: "F002",
        status: "revised",
        severity: "minor",
        rationale: "The impact is limited to a non-critical path.",
        body: "🟡 **Potentially slow path**\n\nThe new work is repeated unnecessarily.",
        startLine: 10,
        line: 12,
      },
    ],
  }), candidates);

  const applied = applyValidationResult(candidates, validation);

  assert.equal(applied.result.findings.length, 2);
  assert.equal(applied.result.findings[0].body.startsWith("_(Final validator: confirmed.)_"), true);
  assert.equal(applied.result.findings[1].severity, "minor");
  assert.equal(applied.result.findings[1].startLine, 10);
  assert.equal(applied.result.findings[1].line, 12);
  assert.match(applied.result.findings[1].body, /severity revised from major to minor/);
  assert.match(applied.result.summary, /retained 2, revised 1/);
});

test("applyValidationResult_ShouldDiscardFalsePositivesAndUnverifiedFindings", () => {
  const candidates = [
    candidate,
    { ...candidate, id: "F002" },
  ];
  const validation = parseValidationResult(JSON.stringify({
    summary: "Only unsupported candidates were found.",
    decisions: [
      { id: "F001", status: "false_positive", severity: "major", rationale: "The unchanged caller already handles this case.", body: null, startLine: null, line: null },
      { id: "F002", status: "unverified", severity: "major", rationale: "The relevant runtime behavior is not in the diff or checkout.", body: null, startLine: null, line: null },
    ],
  }), candidates);

  const applied = applyValidationResult(candidates, validation);

  assert.deepEqual(applied.result.findings, []);
  assert.equal(applied.falsePositives, 1);
  assert.equal(applied.unverified, 1);
  assert.match(applied.result.summary, /discarded 1 false positive and 1 unverified finding/);
});

test("parseValidationResult_ShouldRejectMissingAndDuplicateDecisionsAndRestoreAlteredConfirmedDecisions", () => {
  const base = { summary: "Checked.", decisions: [] };
  assert.throws(() => parseValidationResult(JSON.stringify(base), [candidate]), /omitted candidate decisions/);
  assert.throws(() => parseValidationResult(JSON.stringify({
    summary: "Checked.",
    decisions: [
      { id: "F001", status: "false_positive", severity: "major", rationale: "False.", body: null, startLine: null, line: null },
      { id: "F001", status: "false_positive", severity: "major", rationale: "False.", body: null, startLine: null, line: null },
    ],
  }), [candidate]), /more than once/);
  const validation = parseValidationResult(JSON.stringify({
    summary: "Checked.",
    decisions: [{
      id: "F001",
      status: "confirmed",
      severity: "minor",
      rationale: "The issue is confirmed.",
      body: "🟡 **Changed title**\n\nChanged body.",
      startLine: null,
      line: 12,
    }],
  }), [candidate]);
  const decision = validation.decisions[0]!;

  assert.equal(decision.severity, candidate.severity);
  assert.equal(decision.body, candidate.body);
});

test("parseValidationResult_ShouldRejectPropertiesOutsideTheSchema", () => {
  assert.throws(() => parseValidationResult(JSON.stringify({
    summary: "Checked.",
    extra: "not allowed",
    decisions: [],
  }), []), /unexpected: extra/);

  assert.throws(() => parseValidationResult(JSON.stringify({
    summary: "Checked.",
    decisions: [{
      id: candidate.id,
      status: "confirmed",
      severity: candidate.severity,
      rationale: "Supported by the diff.",
      body: candidate.body,
      startLine: null,
      line: 12,
      decision: "accept",
    }],
  }), [candidate]), /unexpected: decision/);
});
