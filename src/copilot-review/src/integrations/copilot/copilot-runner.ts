import { approveAll, CopilotClient, defineTool } from "@github/copilot-sdk";
import type { ProviderConfig } from "@github/copilot-sdk";
import { agentsForRuntimeApiCheck, READ_ONLY_TOOLS, REVIEWER_AGENT_IDS, VALIDATOR_NAME } from "./agents.ts";
import { conciseSummary } from "../../application/findings.ts";
import {
  checkRuntimeApi,
  RUNTIME_API_PATHS,
  RUNTIME_API_TOOL_NAME,
} from "../../application/runtime-api-check.ts";
import type { ReviewContext, RuntimeApiEvidence } from "../../application/types.ts";
import { readReviewCost } from "./usage.ts";
import { withRateLimitRetries } from "./rate-limit-retry.ts";
import type { FindingCandidate, ReviewerReport } from "../../application/types.ts";
import type { ReviewStageRunner } from "../../application/review-pipeline.ts";

export interface CopilotRunnerOptions {
  model?: string;
  provider?: ProviderConfig;
  gitHubToken?: string;
  workingDirectory?: string;
  maxAiCredits: number;
  max429Retries: number;
  runtimeApiUrl?: string;
  architectureDocuments?: ReviewContext["architectureDocuments"];
  log: (message: string) => void;
  warn: (message: string) => void;
  sanitize: (message: string) => string;
}

type Stage = "idle" | "specialists" | "validator" | "complete";

interface RunState {
  stage: Stage;
  outputs: Map<string, string[]>;
  expectedSpecialists: string[];
  failures: string[];
  unexpectedCalls: string[];
  budgetExhausted: boolean;
  totalNanoAiu?: number;
  runtimeApiEnabled: boolean;
  runtimeApiEvidence: RuntimeApiEvidence[];
  runtimeApiAttempted: boolean;
}

const MAX_RUNTIME_REQUESTS = 10;

/**
 * SDK boundary: owns CopilotClient/session lifecycle, tool allowlists, events,
 * and the SDK-specific onSubagentStop response-capture hook. The stable hook
 * exposes child final text; lifecycle events alone do not expose that report.
 */
export class CopilotReviewRunner implements ReviewStageRunner {
  private readonly client: CopilotClient;
  private readonly session: Awaited<ReturnType<CopilotClient["createSession"]>>;
  private readonly options: CopilotRunnerOptions;
  private readonly state: RunState;
  private readonly startedAt = Date.now();

  private constructor(
    client: CopilotClient,
    session: Awaited<ReturnType<CopilotClient["createSession"]>>,
    options: CopilotRunnerOptions,
    state: RunState,
  ) {
    this.client = client;
    this.session = session;
    this.options = options;
    this.state = state;
  }

  static async start(options: CopilotRunnerOptions): Promise<CopilotReviewRunner> {
    const client = new CopilotClient({
      ...(options.gitHubToken ? { gitHubToken: options.gitHubToken } : {}),
      useLoggedInUser: false,
      logLevel: "info",
    });
    try {
      const runtimeApiUrl = options.runtimeApiUrl;
      const runtimeApiEnabled = runtimeApiUrl !== undefined;
      options.log(`[runtime-api] registration ${JSON.stringify({
        tool: RUNTIME_API_TOOL_NAME,
        enabled: runtimeApiEnabled,
        allowedAgent: VALIDATOR_NAME,
        reason: runtimeApiEnabled ? "loopback API URL is configured" : "runtime API evidence was not enabled",
      })}`);
      const sessionModel = options.model ?? "SDK default";
      const agents = agentsForRuntimeApiCheck(runtimeApiEnabled, options.architectureDocuments);
      const agentModels = agents
        .map((agent) => `${agent.name}=${agent.model ?? sessionModel}`)
        .join(", ");
      const provider = options.provider?.type;
      const wireApi = options.provider?.wireApi;
      options.log(options.sanitize(
        `Using model configuration: provider=${provider}; wireApi=${wireApi ?? "not set"}; session=${sessionModel}; agents=[${agentModels}]`,
      ));
      await client.start();
      const state: RunState = {
        stage: "idle",
        outputs: new Map(),
        expectedSpecialists: Object.keys(REVIEWER_AGENT_IDS),
        failures: [],
        unexpectedCalls: [],
        budgetExhausted: false,
        runtimeApiEnabled,
        runtimeApiEvidence: [],
        runtimeApiAttempted: false,
      };
      let apiToolInvocationCount = 0;
      const captureRuntimeApi = async (
        url: string,
        method: string,
        path: string,
      ): Promise<RuntimeApiEvidence> => {
        if (apiToolInvocationCount > MAX_RUNTIME_REQUESTS) {
          throw new Error(`Runtime endpoint tool is limited to ${MAX_RUNTIME_REQUESTS} requests per review`);
        }
        state.runtimeApiAttempted = true;
        const evidence = await checkRuntimeApi(url, method, path);
        state.runtimeApiEvidence.push(evidence);
        return evidence;
      };
      const runtimeApiTool = runtimeApiUrl === undefined
        ? undefined
        : defineTool(RUNTIME_API_TOOL_NAME, {
          description: "Send one HTTP request to the configured loopback demo service. Choose any valid HTTP method and one of the listed API paths. The origin is fixed, redirects are not followed, and no request body is sent. The actual response or connection error is recorded as review evidence. For a locale-specific profile cache candidate, call GET /profile/grace/es, then GET /profile/ada/en, then GET /profile/ada/es in that order, waiting for each result before the next call.",
          parameters: {
            type: "object",
            additionalProperties: false,
            required: ["method", "path"],
            properties: {
              method: { type: "string", description: "HTTP method token, such as GET, HEAD, POST, or OPTIONS." },
              path: { type: "string", enum: [...RUNTIME_API_PATHS], description: "API path on the configured loopback service." },
            },
          },
          skipPermission: true,
          defer: "never",
          handler: async (args: { method: string; path: string }) => {
            const invocation = ++apiToolInvocationCount;
            const startedAt = Date.now();
            options.log(`[runtime-api] ${RUNTIME_API_TOOL_NAME} called ${JSON.stringify({
              invocation, stage: state.stage, method: args.method, path: args.path,
            })}`);
            const complete = (evidence: RuntimeApiEvidence) => {
              options.log(options.sanitize(`[runtime-api] ${RUNTIME_API_TOOL_NAME} completed\n${JSON.stringify({
                invocation, durationMs: Date.now() - startedAt, output: evidence,
              }, null, 2)}`));
              return evidence;
            };
            return complete(await captureRuntimeApi(runtimeApiUrl, args.method, args.path));
          },
        });
      const session = await client.createSession({
        ...(options.model ? { model: options.model } : {}),
        ...(options.provider ? { provider: options.provider } : {}),
        workingDirectory: options.workingDirectory,
        skipCustomInstructions: true,
        enableConfigDiscovery: false,
        customAgentsLocalOnly: true,
        availableTools: [...READ_ONLY_TOOLS, "task", ...(runtimeApiTool ? [RUNTIME_API_TOOL_NAME] : [])],
        customAgents: agents,
        ...(runtimeApiTool ? {
          tools: [runtimeApiTool],
          defaultAgent: { excludedTools: [RUNTIME_API_TOOL_NAME] },
        } : {}),
        sessionLimits: { maxAiCredits: options.maxAiCredits },
        onPermissionRequest: approveAll,
        hooks: {
          onSubagentStop: ({ agentName, response }) => {
            if (state.stage === "specialists" && Object.hasOwn(REVIEWER_AGENT_IDS, agentName)) {
              if (state.expectedSpecialists.includes(agentName)) {
                const reports = state.outputs.get(agentName) ?? [];
                reports.push(response);
                state.outputs.set(agentName, reports);
              } else {
                state.unexpectedCalls.push(`${state.stage}: ${agentName}`);
              }
            } else if (state.stage === "validator" && agentName === VALIDATOR_NAME) {
              const reports = state.outputs.get(VALIDATOR_NAME) ?? [];
              reports.push(response);
              state.outputs.set(VALIDATOR_NAME, reports);
            } else {
              state.unexpectedCalls.push(`${state.stage}: ${agentName}`);
            }
            options.log(options.sanitize(`[review-report] ${agentName}\n${response}`));
          },
        },
      });
      const runner = new CopilotReviewRunner(client, session, options, state);
      runner.attachListeners();
      return runner;
    } catch (error: unknown) {
      try {
        await client.stop();
      } catch (stopError: unknown) {
        const message = stopError instanceof Error ? stopError.message : String(stopError);
        options.warn(`Could not stop Copilot client after startup failure: ${options.sanitize(message)}`);
      }
      throw error;
    }
  }

  private attachListeners(): void {
    this.session.on((event) => {
      if (event.type === "subagent.failed") {
        const message = conciseSummary(event.data.error, 300) || "Unknown error";
        this.state.failures.push(`${event.data.agentName}: ${message}`);
        this.options.warn(`Sub-agent ${event.data.agentName} failed: ${message}`);
      }
      if (event.type === "session.usage_checkpoint") this.state.totalNanoAiu = event.data.totalNanoAiu;
      if (event.type === "session_limits_exhausted.requested") {
        this.state.budgetExhausted = true;
        this.options.warn(`Review AI-credit limit exhausted (${event.data.usedAiCredits}/${event.data.maxAiCredits}).`);
      }
      if (event.type === "session.shutdown" && typeof event.data.totalNanoAiu === "number") {
        this.state.totalNanoAiu = event.data.totalNanoAiu;
      }
    });
    this.session.on((event) => {
      const data = typeof event.data === "string" ? event.data : JSON.stringify(event.data) ?? "";
      const shortened = data.length > 300 ? `${data.slice(0, 300)}...(${data.length} chars)` : data;
      const agent = event.agentId ? ` [agent ${event.agentId}]` : "";
      this.options.log(`+${((Date.now() - this.startedAt) / 1000).toFixed(1)}s ${event.type}${agent} ${this.options.sanitize(shortened)}`);
    });
  }

  async runSpecialists(prompt: string, timeoutMs: number, reviewerNames: string[]): Promise<ReviewerReport[]> {
    this.state.stage = "specialists";
    this.state.expectedSpecialists = reviewerNames;
    await withRateLimitRetries(
      async () => {
        this.resetStageAttempt();
        await this.session.sendAndWait({ prompt }, timeoutMs);
        this.assertStageSucceeded("specialist review");
      },
      this.options.max429Retries,
      (retry, delayMs) => this.logRateLimitRetry("specialist review", retry, delayMs),
    );

    const missingOrDuplicate = reviewerNames.filter((name) => (this.state.outputs.get(name)?.length ?? 0) !== 1);
    if (missingOrDuplicate.length) {
      throw new Error(`Specialist stage must capture exactly one report from each selected reviewer; missing or duplicated: ${missingOrDuplicate.join(", ")}.`);
    }
    return reviewerNames.map((name) => ({
      agent: name,
      output: this.state.outputs.get(name)![0],
    }));
  }

  async runValidator(prompt: string, timeoutMs: number, candidates: FindingCandidate[]): Promise<string> {
    this.state.stage = "validator";
    await withRateLimitRetries(
      async () => {
        this.resetStageAttempt();
        this.options.log(`[runtime-api] validation-start\n${this.options.sanitize(JSON.stringify({
          enabled: this.state.runtimeApiEnabled,
        }, null, 2))}`);
        await this.session.sendAndWait({ prompt }, timeoutMs);
        this.assertStageSucceeded("final validation");
      },
      this.options.max429Retries,
      (retry, delayMs) => this.logRateLimitRetry("final validation", retry, delayMs),
    );
    const reports = this.state.outputs.get(VALIDATOR_NAME) ?? [];
    if (reports.length !== 1) {
      throw new Error(`Final validation must capture exactly one validator report; received ${reports.length}.`);
    }

    if (this.options.runtimeApiUrl !== undefined && this.state.runtimeApiEvidence.length === 0) {
      this.options.log("[runtime-api] required validator tool call was not observed.");
      throw new Error(
        "Final validator did not call the required check_runtime_api tool; runtime evidence was not captured.",
      );
    }

    this.options.log(this.options.sanitize(`[runtime-api] validation-complete\n${JSON.stringify({
      enabled: this.state.runtimeApiEnabled,
      attempted: this.state.runtimeApiAttempted,
      captured: this.state.runtimeApiEvidence.length > 0,
      source: this.state.runtimeApiEnabled
        ? this.state.runtimeApiEvidence.length ? "validator tool" : "unavailable"
        : "disabled",
      reason: !this.state.runtimeApiEnabled ? "tool unavailable"
        : !this.state.runtimeApiAttempted ? "validator did not call the tool"
        : "request and response captured for review rendering",
    }, null, 2)}`));
    this.state.stage = "complete";
    return reports[0];
  }

  get runtimeApiCheckEnabled(): boolean {
    return this.state.runtimeApiEnabled;
  }

  getRuntimeApiEvidence(): RuntimeApiEvidence[] {
    return [...this.state.runtimeApiEvidence];
  }

  private assertStageSucceeded(label: string): void {
    if (this.state.failures.length) {
      throw new Error(`Sub-agent failure during ${label}: ${this.state.failures.join("; ")}.`);
    }
    if (this.state.unexpectedCalls.length) {
      throw new Error(`Unexpected sub-agent call during ${label}: ${this.state.unexpectedCalls.join(", ")}.`);
    }
    if (this.state.budgetExhausted) throw new Error(`AI-credit limit exhausted before ${label} completed.`);
  }

  private resetStageAttempt(): void {
    this.state.outputs.clear();
    this.state.failures.length = 0;
    this.state.unexpectedCalls.length = 0;
    this.state.runtimeApiAttempted = false;
    this.state.runtimeApiEvidence.length = 0;
  }

  private logRateLimitRetry(stage: string, retry: number, delayMs: number): void {
    this.options.warn(
      `HTTP 429 during ${stage}; retry ${retry}/${this.options.max429Retries} in ${delayMs / 1000}s.`,
    );
  }

  async readCost(): Promise<string> {
    return readReviewCost(
      () => this.session.rpc.usage.getMetrics(),
      this.state.totalNanoAiu,
      (message) => this.options.warn(this.options.sanitize(message)),
    );
  }

  async close(): Promise<void> {
    try {
      await this.session.disconnect();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.warn(`Could not disconnect Copilot session: ${this.options.sanitize(message)}`);
    }
    try {
      await this.client.stop();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.warn(`Could not stop Copilot client: ${this.options.sanitize(message)}`);
    }
  }
}
