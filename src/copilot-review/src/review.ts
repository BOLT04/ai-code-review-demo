import { execFileSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { ConfigError, env, resolveReviewConfiguration } from "./config/configuration.ts";
import { parseRuntimeApiBaseUrl } from "./application/runtime-api-check.ts";
import { commentableLines, filterDiffByPathPrefix, isPlaceable } from "./application/findings.ts";
import { runReviewPipeline } from "./application/review-pipeline.ts";
import { parseReviewerSelection, ReviewSelectionError } from "./application/review-selection.ts";
import type { ReviewResult } from "./application/types.ts";
import { CopilotReviewRunner } from "./integrations/copilot/copilot-runner.ts";
import { buildReviewBody, submitReview } from "./integrations/github/github.ts";
import { loadArchitectureDocuments } from "./integrations/architecture-context.ts";

const MENTION_PATTERN = /@(?=[A-Za-z0-9])/g;
const SECRET_ENV = ["COPILOT_GITHUB_TOKEN", "BYOK_API_KEY", "GITHUB_TOKEN"];
const REVIEWED_PATH_PREFIX = "src/js-codebase/";
let notificationContext: { octokit: Octokit; owner: string; repo: string; pullNumber: number } | undefined;
let reviewCost = "cost unavailable (review session did not start)";

function sanitize(text: string): string {
  const secrets = SECRET_ENV.map(env).filter((value): value is string => value !== undefined);
  // Keep replacement code byte-for-byte intact; never publish redacted code as an apply-able fix.
  const parts = text.split(/(^```suggestion[ \t]*\r?\n[\s\S]*?^```[ \t]*(?=\r?$))/gm);
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      return secrets.some((secret) => part.includes(secret))
        ? "[Suggestion omitted because it contains a configured secret.]"
        : part;
    }
    let prose = part;
    for (const secret of secrets) {
      prose = prose.split(secret).join("[REDACTED]");
    }
    return prose.replace(MENTION_PATTERN, "@\u200b");
  }).join("");
}

function safeEndpoint(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined;
  try {
    const url = new URL(baseUrl);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return "[invalid URL omitted]";
  }
}

/**
 * Integration entry point: fetch trusted PR metadata and diff, invoke the
 * provider-neutral policy pipeline through the Copilot adapter, then publish
 * only its validated result through the GitHub adapter.
 */
async function main(): Promise<void> {
  const selectedReviewers = parseReviewerSelection(process.argv.slice(2));
  const config = resolveReviewConfiguration();
  const {
    auth, owner, repo, pullNumber, maxDiffChars, timeoutMs,
    runtimeApiEvidenceEnabled, runtimeApiUrl,
    maxAiCredits: reviewMaxAiCredits, max429Retries: reviewMax429Retries,
  } = config;
  const stageTimeoutMs = Math.max(1, Math.floor(timeoutMs / 2));
  if (runtimeApiUrl) {
    try {
      parseRuntimeApiBaseUrl(runtimeApiUrl);
    } catch {
      throw new ConfigError("`RUNTIME_API_URL` must be a credential-free loopback HTTP origin (http://127.0.0.1:port).");
    }
  }
  let prDir: string;
  try {
    prDir = config.prDir ?? execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (!statSync(prDir).isDirectory()) {
      throw new ConfigError("`PR_DIR` must point to a readable checkout directory.");
    }
    accessSync(prDir, constants.R_OK | constants.X_OK);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError("Set `PR_DIR` to an existing checkout directory, or run the review inside a Git repository.");
  }
  const octokit = new Octokit({ auth: config.githubToken });
  notificationContext = { octokit, owner, repo, pullNumber };
  const configForLog = {
    authMode: auth.mode,
    provider: auth.provider?.type ?? "copilot",
    model: auth.model ?? "SDK default",
    baseUrl: safeEndpoint(auth.provider?.baseUrl),
    wireApi: auth.provider?.wireApi,
    apiKeyConfigured: Boolean(auth.provider?.apiKey),
    maxAiCredits: reviewMaxAiCredits,
    max429Retries: reviewMax429Retries,
    runtimeApiUrl: safeEndpoint(runtimeApiUrl),
    maxDiffChars,
    reviewTimeoutMs: timeoutMs,
    stageTimeoutMs,
    selectedReviewers: selectedReviewers ?? "all",
  };
  console.log(`Review configuration (secrets omitted):\n${sanitize(JSON.stringify(configForLog, null, 2))}`);

  const { data: pr } = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
  if (pr.head.repo?.full_name !== `${owner}/${repo}`) {
    throw new ConfigError("PRs from forks are not supported (the review runs with repository secrets).");
  }
  if (config.reviewHeadSha && config.reviewHeadSha !== pr.head.sha) {
    throw new ConfigError("The PR head changed after checkout; rerun the review for the current commit.");
  }

  const architectureDocuments = !selectedReviewers || selectedReviewers.includes("architecture-reviewer")
    ? await loadArchitectureDocuments(prDir)
    : [];

  const diffResponse = await octokit.pulls.get({ owner, repo, pull_number: pullNumber, mediaType: { format: "diff" } });
  const fullDiff = diffResponse.data as unknown as string;
  const scopedDiff = filterDiffByPathPrefix(fullDiff, REVIEWED_PATH_PREFIX);
  const commentable = commentableLines(scopedDiff);
  const truncated = scopedDiff.length > maxDiffChars;
  const diff = truncated ? scopedDiff.slice(0, maxDiffChars) : scopedDiff;

  const runner = await CopilotReviewRunner.start({
    ...(auth.model ? { model: auth.model } : {}),
    ...(auth.provider ? { provider: auth.provider } : {}),
    ...(auth.gitHubToken ? { gitHubToken: auth.gitHubToken } : {}),
    workingDirectory: prDir,
    architectureDocuments,
    maxAiCredits: reviewMaxAiCredits,
    max429Retries: reviewMax429Retries,
    runtimeApiUrl,
    log: (message) => console.log(message),
    warn: (message) => console.warn(message),
    sanitize,
  });
  reviewCost = "cost unavailable (SDK did not report billing usage)";

  let result: ReviewResult;
  try {
    result = await runReviewPipeline({
      title: pr.title,
      body: pr.body ?? "",
      diff,
      truncated,
      architectureDocuments,
    }, runner, stageTimeoutMs, selectedReviewers);
  } finally {
    reviewCost = await runner.readCost();
    console.log(`Review usage: ${reviewCost}`);
    await runner.close();
  }

  console.log(sanitize(`[runtime-api] review-evidence\n${JSON.stringify({
    enabled: runner.runtimeApiCheckEnabled,
    captured: runner.getRuntimeApiEvidence().length > 0,
    requests: runner.getRuntimeApiEvidence().map((evidence) => ({
      method: evidence.request.method,
      url: evidence.request.url,
      status: evidence.response?.status ?? null,
    })),
  }, null, 2)}`));
  const meta = `Auth: ${auth.mode}${auth.model ? ` · model: ${auth.model}` : ""} · ${reviewCost} · commit ${pr.head.sha.slice(0, 7)}`;
  const unplaced = result.findings.filter((finding) => !isPlaceable(finding, commentable));
  await submitReview(
    octokit,
    owner,
    repo,
    pullNumber,
    sanitize,
    result.findings.some((finding) => finding.severity === "critical") ? "REQUEST_CHANGES" : "COMMENT",
    (inline) => buildReviewBody(result, meta, inline ? unplaced : result.findings),
    result.findings,
    commentable,
    result.runtimeEvidence ?? [],
  );
  console.log(`Review submitted (${result.findings.length} findings).`);
}

main().catch(async (error: unknown) => {
  console.error(error instanceof ConfigError ? sanitize(`Configuration error: ${error.message}`) : error);
  if (error instanceof ReviewSelectionError) {
    console.error("Usage: npm run review [-- <reviewer-name> [<reviewer-name>]]");
    process.exitCode = 2;
    return;
  }
  process.exitCode = 1;
  if (!notificationContext) return;
  const { octokit, owner, repo, pullNumber } = notificationContext;
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof ConfigError ? error.message : `The review failed: ${message}\n\nIf you are using a Copilot subscription, check that the token owner has an active Copilot subscription and the token has the **Copilot Requests** permission. Otherwise check your BYOK settings.`;
  try {
    await submitReview(octokit, owner, repo, pullNumber, sanitize, "COMMENT", () => `## 🤖 Copilot review could not run\n\n${hint}\n\n<sub>${reviewCost}</sub>`);
  } catch (postError) {
    console.error("Could not post the error to the PR:", postError);
  }
  process.exit(1);
});
