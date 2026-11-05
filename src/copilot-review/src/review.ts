import { readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ConfigError, env, resolveReviewConfiguration } from "./config/configuration.ts";
import { commentableLines, filterDiffByPathPrefix, isPlaceable } from "./application/findings.ts";
import { runReviewPipeline } from "./application/review-pipeline.ts";
import { parseReviewerSelection, ReviewSelectionError } from "./application/review-selection.ts";
import { CopilotReviewRunner } from "./integrations/copilot/copilot-runner.ts";
import { buildReviewBody } from "./integrations/github/github.ts";
import { loadArchitectureDocuments } from "./integrations/architecture-context.ts";
import { parseReviewInput, buildPublication } from "./application/static-review.ts";

const SECRET_ENV = ["COPILOT_GITHUB_TOKEN", "BYOK_API_KEY"];

function sanitize(text: string): string {
  const secrets = SECRET_ENV.map(env).filter((value): value is string => value !== undefined);
  const parts = text.split(/(^```suggestion[ \t]*\r?\n[\s\S]*?^```[ \t]*(?=\r?$))/gm);
  return parts.map((part, index) => {
    if (index % 2 === 1) {
      return secrets.some((secret) => part.includes(secret))
        ? "[Suggestion omitted because it contains a configured secret.]" : part;
    }
    for (const secret of secrets) part = part.split(secret).join("[REDACTED]");
    return part.replace(/@(?=[A-Za-z0-9])/g, "@\u200b");
  }).join("");
}

async function main(): Promise<void> {
  const selectedReviewers = parseReviewerSelection(process.argv.slice(2));
  const config = resolveReviewConfiguration();
  const inputStat = await stat(config.inputPath);
  if (!inputStat.isFile() || inputStat.size > 2_000_000) {
    throw new ConfigError("Review input must be a JSON file no larger than 2 MB.");
  }
  const input = parseReviewInput(JSON.parse(await readFile(config.inputPath, "utf8")), config.reviewHeadSha);
  const trustedRoot = fileURLToPath(new URL("../../../", import.meta.url));
  const architectureDocuments = !selectedReviewers || selectedReviewers.includes("architecture-reviewer")
    ? await loadArchitectureDocuments(trustedRoot) : [];
  const scopedDiff = filterDiffByPathPrefix(input.diff, "src/js-codebase/");
  const truncated = scopedDiff.length > config.maxDiffChars;
  const diff = truncated ? scopedDiff.slice(0, config.maxDiffChars) : scopedDiff;
  const commentable = commentableLines(diff);
  console.log(`Diff review: commit ${input.headSha}; diff truncated=${truncated}; runtime evidence=${Boolean(config.runtimeApiUrl)}; no agent filesystem tools.`);
  const runner = await CopilotReviewRunner.start({
    ...(config.auth.model ? { model: config.auth.model } : {}),
    ...(config.auth.provider ? { provider: config.auth.provider } : {}),
    architectureDocuments,
    maxAiCredits: config.maxAiCredits,
    max429Retries: config.max429Retries,
    runtimeApiUrl: config.runtimeApiUrl,
    log: (message) => console.log(sanitize(message)),
    warn: (message) => console.warn(sanitize(message)),
    sanitize,
  });
  try {
    const result = await runReviewPipeline({
      title: input.title, body: input.body, diff, truncated, architectureDocuments,
    }, runner, Math.max(1, Math.floor(config.timeoutMs / 2)), selectedReviewers);
    const cost = await runner.readCost();
    const meta = `Auth: ${config.auth.mode}${config.auth.model ? ` · model: ${config.auth.model}` : ""} · ${cost} · commit ${input.headSha.slice(0, 7)} · ${config.runtimeApiUrl ? "diff review with runtime evidence" : "static diff-only review"}`;
    const unplaced = result.findings.filter((finding) => !isPlaceable(finding, commentable));
    const output = buildPublication(
      result,
      (inline) => buildReviewBody(result, meta, inline ? unplaced : result.findings),
      commentable,
      sanitize,
    );
    await writeFile(config.outputPath, JSON.stringify(output), { flag: "wx", mode: 0o600 });
    console.log(`Review generated (${result.findings.length} findings); publication is a separate trusted step.`);
  } finally {
    await runner.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(sanitize(`Review failed: ${message}`));
  process.exitCode = error instanceof ReviewSelectionError ? 2 : 1;
});
