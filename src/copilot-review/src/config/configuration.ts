import type { ProviderConfig } from "@github/copilot-sdk";

export class ConfigError extends Error {}

export const env = (key: string): string | undefined => process.env[key]?.trim() || undefined;

function requiredEnv(key: string): string {
  const value = env(key);
  if (!value) throw new ConfigError(`\`${key}\` is required.`);
  return value;
}

function positiveInteger(key: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER): number {
  const raw = env(key);
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new ConfigError(`\`${key}\` must be a positive integer no greater than ${maximum}.`);
  }
  return value;
}

export function resolveReviewConfiguration() {
  const auth = resolveAuth();
  const githubToken = requiredEnv("GITHUB_TOKEN");
  const repository = requiredEnv("GITHUB_REPOSITORY");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new ConfigError("`GITHUB_REPOSITORY` must have the form owner/repository.");
  }
  const [owner, repo] = repository.split("/");
  const rawPullNumber = requiredEnv("PR_NUMBER");
  const pullNumber = Number(rawPullNumber);
  if (!/^[1-9]\d*$/.test(rawPullNumber) || !Number.isSafeInteger(pullNumber)) {
    throw new ConfigError("`PR_NUMBER` must be a positive safe integer.");
  }
  const runtimeFlag = env("ENABLE_RUNTIME_API_EVIDENCE");
  if (runtimeFlag !== undefined && runtimeFlag !== "true" && runtimeFlag !== "false") {
    throw new ConfigError("`ENABLE_RUNTIME_API_EVIDENCE` must be true or false.");
  }
  const runtimeApiEvidenceEnabled = runtimeFlag === "true";
  const runtimeApiUrl = runtimeApiEvidenceEnabled ? requiredEnv("RUNTIME_API_URL") : undefined;
  const reviewHeadSha = env("REVIEW_HEAD_SHA");
  if (reviewHeadSha && !/^[a-fA-F0-9]{40}$/.test(reviewHeadSha)) {
    throw new ConfigError("`REVIEW_HEAD_SHA` must be a full 40-character hexadecimal commit SHA.");
  }
  return {
    auth,
    githubToken,
    owner,
    repo,
    pullNumber,
    reviewHeadSha,
    prDir: env("PR_DIR"),
    maxAiCredits: maxAiCredits(),
    max429Retries: max429Retries(),
    maxDiffChars: positiveInteger("MAX_DIFF_CHARS", 150_000),
    timeoutMs: positiveInteger("REVIEW_TIMEOUT_MS", 1_500_000, 2_147_483_647),
    runtimeApiEvidenceEnabled,
    runtimeApiUrl,
  };
}

export function resolveAuth(): { mode: string; model?: string; provider?: ProviderConfig; gitHubToken?: string } {
  const baseUrl = env("BYOK_BASE_URL");

  if (baseUrl) {
    const apiKey = env("BYOK_API_KEY");
    const model = env("BYOK_MODEL");
    if (!apiKey || !model) {
      throw new ConfigError(
        "`BYOK_BASE_URL` is set, but `BYOK_API_KEY` and/or `BYOK_MODEL` is missing. " +
          "BYOK requires a base URL, an API key, and a model (deployment) name.",
      );
    }
    let url: URL;
    try {
      url = new URL(baseUrl);
    } catch {
      throw new ConfigError("`BYOK_BASE_URL` must be a valid HTTP(S) URL.");
    }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new ConfigError("`BYOK_BASE_URL` must be a credential-free HTTP(S) URL without a query or fragment.");
    }
    const defaultType = url.hostname.endsWith(".openai.azure.com") ? "azure" : "openai";
    const type = env("BYOK_PROVIDER_TYPE") ?? defaultType;
    if (type !== "openai" && type !== "azure" && type !== "anthropic") {
      throw new ConfigError("`BYOK_PROVIDER_TYPE` must be `openai`, `azure`, or `anthropic`.");
    }
    let wireApi: "responses" | "completions" | undefined;
    if (type !== "anthropic") {
      const configuredWireApi = env("BYOK_WIRE_API") ?? "responses";
      if (configuredWireApi !== "responses" && configuredWireApi !== "completions") {
        throw new ConfigError("`BYOK_WIRE_API` must be `responses` or `completions`.");
      }
      wireApi = configuredWireApi;
    }
    return {
      mode: `BYOK (${type})`,
      model,
      provider: {
        type,
        baseUrl,
        apiKey,
        ...(wireApi ? { wireApi } : {}),
      },
    };
  }

  if (env("BYOK_API_KEY") || env("BYOK_MODEL") || env("BYOK_PROVIDER_TYPE") || env("BYOK_WIRE_API")) {
    throw new ConfigError("BYOK settings require `BYOK_BASE_URL`, `BYOK_API_KEY`, and `BYOK_MODEL`.");
  }

  const gitHubToken = env("COPILOT_GITHUB_TOKEN");
  if (!gitHubToken) {
    throw new ConfigError(
      "No authentication configured. Either:\n" +
        "- add a `COPILOT_GITHUB_TOKEN` secret (fine-grained PAT owned by a user with an active Copilot subscription, " +
        "with the **Copilot Requests** account permission), or\n" +
        "- configure BYOK with `BYOK_BASE_URL`, `BYOK_API_KEY` and `BYOK_MODEL`.",
    );
  }
  return { mode: "Copilot subscription", model: env("COPILOT_MODEL"), gitHubToken };
}

export function maxAiCredits(): number {
  const value = Number(env("MAX_AI_CREDITS") ?? 30);
  if (!Number.isFinite(value) || value < 30) {
    throw new ConfigError("`MAX_AI_CREDITS` must be a finite number of at least 30. Update the workflow environment variable or remove it to use the default of 30.");
  }
  return value;
}

export function max429Retries(): number {
  const value = Number(env("REVIEW_MAX_429_RETRIES") ?? 9);
  if (!Number.isInteger(value) || value < 0 || value > 20) {
    throw new ConfigError("`REVIEW_MAX_429_RETRIES` must be an integer between 0 and 20.");
  }
  return value;
}
