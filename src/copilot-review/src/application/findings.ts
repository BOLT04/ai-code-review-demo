import type { Finding, FindingCandidate, FindingDecision, ReviewResult, ValidationResult } from "./types.ts";

const DIFF_HUNK_HEADER_PATTERN = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DIFF_NEW_SIDE_PATH_PREFIX_PATTERN = /^b\//;
const LEADING_PATH_SEPARATOR_PATTERN = /^\.?\//;
const SENTENCE_BOUNDARY_PATTERN = /(?<=[.!?])\s+/;

export function filterDiffByPathPrefix(diff: string, pathPrefix: string): string {
  const sections: string[] = [];
  let section: string[] = [];

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      if (section.length) sections.push(section.join("\n"));
      section = [line];
    } else if (section.length) {
      section.push(line);
    }
  }
  if (section.length) sections.push(section.join("\n"));

  return sections.filter((candidate) => {
    const diffHeader = candidate.split("\n", 1)[0]!;
    if (diffHeader.startsWith(`diff --git a/${pathPrefix}`) && diffHeader.includes(` b/${pathPrefix}`)) {
      return true;
    }
    return candidate.split("\n").some((line) =>
      (line.startsWith("--- a/") && line.slice(6).startsWith(pathPrefix)) ||
      (line.startsWith("+++ b/") && line.slice(6).startsWith(pathPrefix)),
    );
  }).join("\n");
}

export function commentableLines(diff: string): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  let file: string | null = null;
  let inHunk = false;
  let newLine = 0;

  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      file = null;
      continue;
    }
    const header = DIFF_HUNK_HEADER_PATTERN.exec(line);
    if (header) {
      newLine = Number(header[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      if (line.startsWith("+++ ")) {
        const path = line.slice(4).split("\t")[0];
        file = path === "/dev/null" ? null : path.replace(DIFF_NEW_SIDE_PATH_PREFIX_PATTERN, "");
        if (file && !map.has(file)) map.set(file, new Set());
      }
      continue;
    }
    if (!file) continue;
    if (line.startsWith("+") || line.startsWith(" ")) {
      map.get(file)!.add(newLine);
      newLine++;
    }
  }
  return map;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const keys = Object.keys(value);
  const unexpected = keys.filter((key) => !expected.includes(key));
  const missing = expected.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length || missing.length) {
    const details = [
      ...(missing.length ? [`missing: ${missing.join(", ")}`] : []),
      ...(unexpected.length ? [`unexpected: ${unexpected.join(", ")}`] : []),
    ];
    throw new Error(`${label} does not match its JSON schema (${details.join("; ")}).`);
  }
}

function normalizeFindings(raw: unknown[], agent?: string): Finding[] {
  return raw.map((finding, index): Finding => {
    if (!isRecord(finding)) {
      throw new Error(`Finding ${index + 1} must be a JSON object.`);
    }
    assertExactKeys(finding, ["severity", "file", "startLine", "line", "body"], `Finding ${index + 1}`);
    if (typeof finding.body !== "string" || !finding.body.trim()) {
      throw new Error(`Finding ${index + 1} must contain a non-empty Markdown body.`);
    }
    if (finding.severity !== "critical" && finding.severity !== "major" && finding.severity !== "minor") {
      throw new Error(`Finding ${index + 1} has an invalid severity.`);
    }
    if (finding.file !== null && (typeof finding.file !== "string" || !finding.file.trim())) {
      throw new Error(`Finding ${index + 1} has an invalid file.`);
    }
    if (finding.line !== null && (typeof finding.line !== "number" || !Number.isSafeInteger(finding.line) || finding.line <= 0)) {
      throw new Error(`Finding ${index + 1} has an invalid line.`);
    }
    if (finding.startLine !== null && (typeof finding.startLine !== "number" || !Number.isSafeInteger(finding.startLine) || finding.startLine <= 0)) {
      throw new Error(`Finding ${index + 1} has an invalid startLine.`);
    }
    if (typeof finding.startLine === "number" && (typeof finding.line !== "number" || finding.startLine > finding.line)) {
      throw new Error(`Finding ${index + 1} has an invalid line range.`);
    }
    return {
      agent,
      severity: finding.severity,
      file: typeof finding.file === "string" ? finding.file.replace(LEADING_PATH_SEPARATOR_PATTERN, "") : undefined,
      startLine: typeof finding.startLine === "number" ? finding.startLine : null,
      line: typeof finding.line === "number" ? finding.line : null,
      body: finding.body,
    };
  });
}

export function parseReviewerFindings(raw: string, agent: string): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim()) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${agent} returned invalid JSON: ${message}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${agent} must return a JSON array of findings.`);
  return normalizeFindings(parsed, agent);
}

function architectureMarkdown(value: unknown): string {
  if (typeof value !== "string" || !value.trim().startsWith("### Architecture review\n")) {
    throw new Error("Architecture review must contain a Markdown Architecture review section.");
  }
  const rows = value.split("\n").filter((line) => line.trim().startsWith("|")).map((line) =>
    line.trim().split("|").slice(1, -1).map((cell) => cell.trim()),
  );
  const requirements = ["Scalability", "Observability", "Regulatory & Compliance"];
  const results = ["❌ Not compliant", "✅ Compliant", "➖ Not assessed"];
  if (
    rows.length !== 5 ||
    rows[0]?.join("|") !== "Requirement|Result" ||
    !rows[1]?.every((cell) => /^:?-{3,}:?$/.test(cell)) || rows[1]?.length !== 2 ||
    requirements.some((requirement, index) =>
      rows[index + 2]?.length !== 2 || rows[index + 2][0] !== requirement || !results.includes(rows[index + 2][1]),
    )
  ) {
    throw new Error("Architecture review must contain exactly the three required requirement rows and valid results.");
  }
  return value.trim();
}

export function parseArchitectureReport(raw: string): { findings: Finding[]; architectureReview: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Architecture reviewer returned invalid JSON: ${message}`);
  }
  if (!isRecord(parsed)) throw new Error("Architecture reviewer must return a JSON object.");
  assertExactKeys(parsed, ["findings", "architectureReview"], "Architecture reviewer response");
  if (!Array.isArray(parsed.findings)) throw new Error("Architecture reviewer must return a findings array.");
  return {
    findings: normalizeFindings(parsed.findings, "architecture"),
    architectureReview: architectureMarkdown(parsed.architectureReview),
  };
}

export function parseValidationResult(raw: string, candidates: FindingCandidate[], architectureRequired = false): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.trim()) as unknown;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`The final validator returned invalid JSON: ${message}`);
  }
  if (!isRecord(parsed)) {
    throw new Error("The final validator must return a JSON object.");
  }
  assertExactKeys(parsed, ["summary", "decisions", ...(architectureRequired ? ["architectureReview"] : [])], "The final validator response");
  if (typeof parsed.summary !== "string" || !parsed.summary.trim() || !Array.isArray(parsed.decisions)) {
    throw new Error("The final validator must return a summary string and a decisions array.");
  }

  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const seen = new Set<string>();
  const decisions = parsed.decisions.map((rawDecision, index): FindingDecision => {
    if (!isRecord(rawDecision)) {
      throw new Error(`Validator decision ${index + 1} must be a JSON object.`);
    }
    assertExactKeys(rawDecision, ["id", "status", "severity", "rationale", "body", "startLine", "line"], `Validator decision ${index + 1}`);
    if (typeof rawDecision.id !== "string" || !candidateById.has(rawDecision.id)) {
      throw new Error(`Validator decision ${index + 1} references an unknown candidate ID.`);
    }
    if (seen.has(rawDecision.id)) throw new Error(`The final validator returned candidate ${rawDecision.id} more than once.`);
    seen.add(rawDecision.id);
    if (
      rawDecision.status !== "confirmed" &&
      rawDecision.status !== "revised" &&
      rawDecision.status !== "false_positive" &&
      rawDecision.status !== "unverified"
    ) {
      throw new Error(`Validator decision ${index + 1} has an invalid status.`);
    }
    if (rawDecision.severity !== "critical" && rawDecision.severity !== "major" && rawDecision.severity !== "minor") {
      throw new Error(`Validator decision ${index + 1} has an invalid severity.`);
    }
    if (typeof rawDecision.rationale !== "string" || !rawDecision.rationale.trim()) {
      throw new Error(`Validator decision ${index + 1} must include an evidence-based rationale.`);
    }
    if (rawDecision.startLine !== null && (typeof rawDecision.startLine !== "number" || !Number.isSafeInteger(rawDecision.startLine) || rawDecision.startLine <= 0)) {
      throw new Error(`Validator decision ${index + 1} has an invalid startLine.`);
    }
    if (rawDecision.line !== null && (typeof rawDecision.line !== "number" || !Number.isSafeInteger(rawDecision.line) || rawDecision.line <= 0)) {
      throw new Error(`Validator decision ${index + 1} has an invalid line.`);
    }
    if (typeof rawDecision.startLine === "number" && (typeof rawDecision.line !== "number" || rawDecision.startLine > rawDecision.line)) {
      throw new Error(`Validator decision ${index + 1} has an invalid line range.`);
    }
    if (rawDecision.body !== null && (typeof rawDecision.body !== "string" || !rawDecision.body.trim())) {
      throw new Error(`Validator decision ${index + 1} has an invalid Markdown body.`);
    }
    const candidate = candidateById.get(rawDecision.id)!;
    if (rawDecision.status === "revised" && (typeof rawDecision.body !== "string" || !rawDecision.body.trim())) {
      throw new Error(`Revised candidate ${rawDecision.id} must include its complete final Markdown body.`);
    }
    if (
      rawDecision.status !== "revised" &&
      rawDecision.status !== "confirmed" &&
      rawDecision.severity !== candidate.severity
    ) {
      throw new Error(`Validator decision ${rawDecision.id} must retain its original severity unless revised.`);
    }
    if ((rawDecision.status === "false_positive" || rawDecision.status === "unverified") && rawDecision.body !== null) {
      throw new Error(`Discarded candidate ${rawDecision.id} must have a null body.`);
    }
    const candidateStartLine = candidate.startLine ?? null;
    if (rawDecision.status === "confirmed" && (rawDecision.startLine !== candidateStartLine || rawDecision.line !== candidate.line)) {
      throw new Error(`Confirmed candidate ${rawDecision.id} must preserve its original line range.`);
    }
    if ((rawDecision.status === "false_positive" || rawDecision.status === "unverified") && (rawDecision.startLine !== null || rawDecision.line !== null)) {
      throw new Error(`Discarded candidate ${rawDecision.id} must have null line locations.`);
    }
    return {
      id: rawDecision.id,
      status: rawDecision.status,
      severity: rawDecision.status === "confirmed" ? candidate.severity : rawDecision.severity,
      rationale: rawDecision.rationale.trim(),
      startLine: typeof rawDecision.startLine === "number" ? rawDecision.startLine : null,
      line: typeof rawDecision.line === "number" ? rawDecision.line : null,
      ...(rawDecision.status === "confirmed"
        ? { body: candidate.body }
        : typeof rawDecision.body === "string" ? { body: rawDecision.body } : {}),
    };
  });

  const missing = candidates.filter((candidate) => !seen.has(candidate.id)).map((candidate) => candidate.id);
  if (missing.length) throw new Error(`The final validator omitted candidate decisions: ${missing.join(", ")}.`);
  return {
    summary: parsed.summary.trim(),
    decisions,
    ...(architectureRequired ? { architectureReview: architectureMarkdown(parsed.architectureReview) } : {}),
  };
}

export function applyValidationResult(
  candidates: FindingCandidate[],
  validation: ValidationResult,
): { result: ReviewResult; revised: number; falsePositives: number; unverified: number } {
  const candidateById = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  let revised = 0;
  let falsePositives = 0;
  let unverified = 0;
  const findings: Finding[] = [];

  for (const decision of validation.decisions) {
    const candidate = candidateById.get(decision.id);
    if (!candidate) throw new Error(`Validator decision references unknown candidate ${decision.id}.`);
    if (decision.status === "false_positive") {
      falsePositives++;
      continue;
    }
    if (decision.status === "unverified") {
      unverified++;
      continue;
    }
    if (decision.status === "revised") revised++;
    const severityNote = candidate.severity === decision.severity
      ? ""
      : `; severity revised from ${candidate.severity} to ${decision.severity}`;
    const note = decision.status === "confirmed"
      ? "_(Final validator: confirmed.)_"
      : `_(Final validator: revised${severityNote} — ${decision.rationale})_`;
    findings.push({
      ...candidate,
      severity: decision.severity,
      ...(decision.status === "revised" ? { startLine: decision.startLine, line: decision.line } : {}),
      body: `${note}\n\n${decision.body ?? candidate.body}`,
    });
  }

  const discarded = falsePositives + unverified;
  const disposition = `Final validator retained ${findings.length}, revised ${revised}, discarded ${falsePositives} false positive${falsePositives === 1 ? "" : "s"} and ${unverified} unverified finding${unverified === 1 ? "" : "s"}.`;
  return {
    result: {
      summary: `${validation.summary} ${disposition}`.trim(),
      findings,
      ...(validation.architectureReview ? { architectureReview: validation.architectureReview } : {}),
    },
    revised,
    falsePositives,
    unverified,
  };
}

export function conciseSummary(summary: string, max = 200): string {
  const first = summary.trim().split(SENTENCE_BOUNDARY_PATTERN)[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

export function isPlaceable(finding: Finding, commentable: Map<string, Set<number>>): boolean {
  if (!finding.file || !finding.line) return false;
  const lines = commentable.get(finding.file);
  const startLine = finding.startLine ?? finding.line;
  if (!lines || startLine > finding.line || finding.line - startLine + 1 > lines.size) return false;
  for (let line = startLine; line <= finding.line; line++) {
    if (!lines.has(line)) return false;
  }
  return true;
}
