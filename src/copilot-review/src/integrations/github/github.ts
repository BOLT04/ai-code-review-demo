import type { Octokit } from "@octokit/rest";
import { isPlaceable } from "../../application/findings.ts";
import type { Finding, ReviewEvent, ReviewResult, RuntimeApiEvidence, Severity } from "../../application/types.ts";

const MAX_REVIEW_BODY = 60_000;
const ICON: Record<Severity, string> = { critical: "🔴", major: "🟠", minor: "🟡" };
const ORDER: Severity[] = ["critical", "major", "minor"];

function codeFence(content: string): string {
  const longestBacktickRun = Math.max(0, ...Array.from(content.matchAll(/`+/g), (match) => match[0].length));
  return "`".repeat(Math.max(3, longestBacktickRun + 1));
}

function runtimeApiMarkdown(evidence: RuntimeApiEvidence): string {
  const response = evidence.response
    ? [
      `HTTP ${evidence.response.status} ${evidence.response.statusText}`.trim(),
      ...(evidence.response.contentType ? [`Content-Type: ${evidence.response.contentType}`] : []),
      ...(evidence.error ? [`Error: ${evidence.error}`] : []),
      "",
      evidence.response.body || "(empty response body)",
    ].join("\n")
    : `No HTTP response${evidence.error ? `: ${evidence.error}` : "."}`;
  const fence = codeFence(response);
  return [
    "<details>",
    "<summary>Runtime evidence (PR service in isolated container)</summary>",
    "",
    `Request: \`${evidence.request.method} ${evidence.request.url}\``,
    "",
    `${fence}text`,
    response,
    fence,
    "",
    "</details>",
  ].join("\n");
}

function findingMarkdown(finding: Finding): string {
  const location = finding.startLine && finding.line && finding.startLine < finding.line
    ? `${finding.startLine}-${finding.line}`
    : finding.line ? `${finding.line}` : "";
  const where = finding.file ? ` \`${finding.file}${location ? `:${location}` : ""}\`` : "";
  const agent = finding.agent ? ` _(${finding.agent})_` : "";
  return `${where}${agent}\n\n${finding.body}`;
}

function findingCommentBody(finding: Finding, runtimeEvidence: RuntimeApiEvidence[]): string {
  const body = finding.body;
  const relevantEvidence = runtimeEvidence.filter((evidence) => {
    const path = new URL(evidence.request.url).pathname;
    const segments = path.split("/").filter(Boolean);
    const routePrefix = segments.length > 1 ? `/${segments[0]}/` : path;
    return body.includes(path) || body.includes(routePrefix);
  });
  if (relevantEvidence.length === 0) return body;
  return `${body}\n\n${relevantEvidence.map(runtimeApiMarkdown).join("\n\n")}`;
}

export function buildReviewBody(result: ReviewResult, meta: string, listed: Finding[]): string {
  const architecture = result.architectureReview ? `\n\n${result.architectureReview}` : "";
  if (!result.findings.length) {
    return `## 🤖 Copilot review\n\n${result.summary}\n\nNo issues found. ✅${architecture}\n\n<sub>${meta}</sub>`;
  }
  const counts = ORDER.map((severity) => `${ICON[severity]} ${result.findings.filter((finding) => finding.severity === severity).length} ${severity}`).join(" · ");
  const visible = [...new Set(listed)];
  const sorted = visible.sort((a, b) => ORDER.indexOf(a.severity) - ORDER.indexOf(b.severity));
  const extra = sorted.length ? `\n\n${sorted.map(findingMarkdown).join("\n\n")}` : "";
  return `## 🤖 Copilot review\n\n${result.summary}\n\n${counts}${architecture}${extra}\n\n<sub>${meta}</sub>`;
}

export async function submitReview(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  sanitize: (text: string) => string,
  event: ReviewEvent,
  bodyFor: (inline: boolean) => string,
  findings: Finding[] = [],
  commentable: Map<string, Set<number>> = new Map(),
  runtimeEvidence: RuntimeApiEvidence[] = [],
): Promise<void> {
  const comments = findings
    .filter((finding) => isPlaceable(finding, commentable))
    .map((finding) => ({
      path: finding.file!,
      line: finding.line!,
      side: "RIGHT" as const,
      ...(finding.startLine && finding.startLine < finding.line! ? { start_line: finding.startLine, start_side: "RIGHT" as const } : {}),
      body: sanitize(findingCommentBody(finding, runtimeEvidence)),
    }));
  const attempts: Array<{ event: ReviewEvent; withComments: boolean }> = [
    { event, withComments: true },
    { event, withComments: false },
    ...(event === "REQUEST_CHANGES" ? [{ event: "COMMENT" as const, withComments: false }] : []),
  ];

  let lastError: unknown;
  for (const attempt of attempts) {
    if (attempt.withComments && comments.length === 0) continue;
    try {
      await octokit.pulls.createReview({
        owner,
        repo,
        pull_number: pullNumber,
        event: attempt.event,
        body: sanitize(bodyFor(attempt.withComments)).slice(0, MAX_REVIEW_BODY),
        ...(attempt.withComments ? { comments } : {}),
      });
      return;
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`createReview(${attempt.event}, inline=${attempt.withComments}) failed:`, message);
    }
  }
  throw lastError;
}
