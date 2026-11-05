import {
  REVIEWER_AGENT_IDS,
  buildSpecialistPrompt,
  buildValidationPrompt,
} from "./review-prompts.ts";
import type { ReviewerAgentName } from "./review-prompts.ts";
import {
  applyValidationResult,
  parseArchitectureReport,
  parseReviewerFindings,
  parseValidationResult,
} from "./findings.ts";
import type { FindingCandidate, ReviewContext, ReviewResult, ReviewerReport, RuntimeApiEvidence } from "./types.ts";

export interface ReviewStageRunner {
  // Runners supply architecture documents directly to the architecture and validator agents.
  runSpecialists(prompt: string, timeoutMs: number, reviewerNames: string[]): Promise<ReviewerReport[]>;
  runValidator(prompt: string, timeoutMs: number, candidates: FindingCandidate[]): Promise<string>;
  readonly runtimeApiCheckEnabled?: boolean;
  getRuntimeApiEvidence?(): RuntimeApiEvidence[];
}

/**
 * SDK-independent review policy: gather every specialist report, normalize
 * candidates, request independent adjudication, and only return validated
 * findings. The application owns these awaited barriers instead of relying
 * on the SDK's experimental Dynamic Workflows API; a caller can supply another
 * provider without changing the policy.
 */
export async function runReviewPipeline(
  context: ReviewContext,
  runner: ReviewStageRunner,
  timeoutMs: number,
  selectedReviewers?: ReviewerAgentName[],
): Promise<ReviewResult> {
  if (selectedReviewers && (selectedReviewers.length < 1 || selectedReviewers.length > 2)) {
    throw new Error("Select one or two specialist reviewers.");
  }
  if (selectedReviewers?.some((name) => !Object.hasOwn(REVIEWER_AGENT_IDS, name))) {
    throw new Error("Unknown specialist reviewer.");
  }
  if (selectedReviewers && new Set(selectedReviewers).size !== selectedReviewers.length) {
    throw new Error("Select different specialist reviewers.");
  }
  const reviewerNames: ReviewerAgentName[] = selectedReviewers
    ?? Object.keys(REVIEWER_AGENT_IDS).filter(
      (name): name is ReviewerAgentName => Object.hasOwn(REVIEWER_AGENT_IDS, name),
    );
  const architectureRequired = reviewerNames.includes("architecture-reviewer");
  if (architectureRequired) {
    const documents = context.architectureDocuments ?? [];
    const hasTeamStandards = documents.some(
      (document) => document.path === "docs/architecture/team-standards.md",
    );
    const hasAdr = documents.some(
      (document) => document.path.startsWith("docs/adrs/") &&
        document.path.endsWith(".md") &&
        !document.path.endsWith("/README.md"),
    );
    if (!hasTeamStandards || !hasAdr) {
      throw new Error(
        "Architecture review requires docs/architecture/team-standards.md and at least one ADR before running specialists.",
      );
    }
  }
  const reports = await runner.runSpecialists(
    buildSpecialistPrompt(context, selectedReviewers),
    timeoutMs,
    reviewerNames,
  );
  const reportCounts = new Map<string, number>();
  for (const report of reports) reportCounts.set(report.agent, (reportCounts.get(report.agent) ?? 0) + 1);

  const missingOrDuplicate = reviewerNames.filter((agent) => reportCounts.get(agent) !== 1);
  const unexpected = reports
    .map((report) => report.agent)
    .filter((agent) => !reviewerNames.some((reviewerName) => reviewerName === agent));
  if (missingOrDuplicate.length || unexpected.length) {
    throw new Error(
      `Invalid specialist reports; expected exactly one each from ${reviewerNames.join(", ")}.` +
      `${missingOrDuplicate.length ? ` Missing or duplicated: ${missingOrDuplicate.join(", ")}.` : ""}` +
      `${unexpected.length ? ` Unexpected: ${unexpected.join(", ")}.` : ""}`,
    );
  }

  const orderedReports = reviewerNames.map((agent) => ({
    ...reports.find((report) => report.agent === agent)!,
    agent,
  }));
  const candidates: FindingCandidate[] = [];
  for (const report of orderedReports) {
    const findings = report.agent === "architecture-reviewer"
      ? parseArchitectureReport(report.output).findings
      : parseReviewerFindings(report.output, REVIEWER_AGENT_IDS[report.agent]);
    for (const finding of findings) {
      candidates.push({ ...finding, id: `F${String(candidates.length + 1).padStart(3, "0")}` });
    }
  }

  const validatorOutput = await runner.runValidator(buildValidationPrompt({
    ...context,
    reports: orderedReports.map((report) => ({ ...report, agent: REVIEWER_AGENT_IDS[report.agent] })),
    candidates,
    runtimeApiCheckAvailable: runner.runtimeApiCheckEnabled === true,
  }), timeoutMs, candidates);
  const validation = parseValidationResult(validatorOutput, candidates, architectureRequired);
  const result = applyValidationResult(candidates, validation).result;
  const runtimeEvidence = runner.getRuntimeApiEvidence?.();
  if (runtimeEvidence?.length) result.runtimeEvidence = runtimeEvidence;
  return result;
}
