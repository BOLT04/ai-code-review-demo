import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { approveAll, CopilotClient, type CopilotClientOptions } from "@github/copilot-sdk";
import { CopilotReviewRunner } from "../src/integrations/copilot/copilot-runner.ts";
import type { CopilotRunnerOptions } from "../src/integrations/copilot/copilot-runner.ts";
import type { ReviewContext } from "../src/application/types.ts";
import { buildSpecialistPrompt, buildValidationPrompt } from "../src/application/review-prompts.ts";

type SessionConfig = NonNullable<Parameters<CopilotClient["createSession"]>[0]>;
type Session = Awaited<ReturnType<CopilotClient["createSession"]>>;

async function startRunner(
  context: TestContext,
  enabled: boolean,
  onValidate: (config: SessionConfig) => Promise<void> = async () => {},
  apiResponse: () => Response = () => Response.json({ status: "ok" }),
  architectureDocuments?: ReviewContext["architectureDocuments"],
  auth: Pick<CopilotRunnerOptions, "gitHubToken" | "provider"> = {},
) {
  const logs: string[] = [];
  const requests: Array<{ method: string; path: string }> = [];
  let runtimeApiUrl: string | undefined;
  if (enabled) {
    const server = createServer(async (request, response) => {
      requests.push({ method: request.method ?? "", path: request.url ?? "" });
      const result = apiResponse();
      const body = await result.text();
      response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
      response.end(body);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    context.after(() => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    runtimeApiUrl = `http://127.0.0.1:${address.port}`;
  }
  const report = JSON.stringify({ summary: `test-secret ${"complete report ".repeat(40)}`, decisions: [] });
  let config: SessionConfig;
  let clientOptions: CopilotClientOptions;
  context.mock.method(CopilotClient.prototype, "start", async function (this: CopilotClient) {
    clientOptions = Reflect.get(this, "options");
    assert.ok(clientOptions);
  });
  context.mock.method(CopilotClient.prototype, "stop", async () => []);
  context.mock.method(CopilotClient.prototype, "createSession", async (options: SessionConfig) => {
    assert.ok(options);
    config = options;
    return {
      on: () => () => {},
      disconnect: async () => {},
      sendAndWait: async () => {
        await onValidate(config);
        const hook = config.hooks?.onSubagentStop;
        assert.ok(hook);
        await hook({
          agentName: "final-validator",
          response: report,
        } as Parameters<typeof hook>[0], { sessionId: "test-session" });
      },
    } as unknown as Session;
  });
  const runner = await CopilotReviewRunner.start({
    ...auth,
    maxAiCredits: 30,
    max429Retries: 0,
    architectureDocuments,
    ...(runtimeApiUrl ? { runtimeApiUrl } : {}),
    log: (message) => logs.push(message),
    warn: (message) => logs.push(message),
    sanitize: (message) => message.replaceAll("test-secret", "[REDACTED]"),
  });
  context.after(() => runner.close());
  return { runner, logs, report, config: () => config, clientOptions: () => clientOptions, requests };
}

test("runnerPassesExplicitCopilotTokenToSdkWithoutEnablingStoredLogin", async (context) => {
  const { clientOptions } = await startRunner(context, false, undefined, undefined, undefined, {
    gitHubToken: "test-copilot-token",
  });
  assert.equal(clientOptions().gitHubToken, "test-copilot-token");
  assert.equal(clientOptions().useLoggedInUser, false);
});

test("runnerSupportsByokWithoutCopilotAuthentication", async (context) => {
  const provider = { type: "openai", baseUrl: "https://example.com", apiKey: "test-byok-key" } as const;
  const { clientOptions, config } = await startRunner(context, false, undefined, undefined, undefined, { provider });
  assert.equal(clientOptions().gitHubToken, undefined);
  assert.equal(clientOptions().useLoggedInUser, false);
  assert.deepEqual(config().provider, provider);
});

test("runnerLogsWhenRuntimeApiCheckIsUnavailable", async (context) => {
  const { runner, logs, config } = await startRunner(context, false);
  await runner.runValidator("Validate", 1_000, []);

  assert.equal(runner.runtimeApiCheckEnabled, false);
  assert.ok(logs.some((message) => message.includes("[runtime-api] registration") && message.includes('"enabled":false')));
  assert.ok(logs.some((message) => message.includes('"reason": "tool unavailable"')));
  assert.equal(config().tools?.some((tool) => tool.name === "check_runtime_api") ?? false, false);
  assert.equal(config().skipCustomInstructions, true);
  assert.equal(config().enableConfigDiscovery, false);
  assert.equal(config().customAgentsLocalOnly, true);
  assert.equal(config().onPermissionRequest, approveAll);
  assert.equal(config().hooks?.onPreToolUse, undefined);
  assert.deepEqual(config().availableTools, ["view", "grep", "glob", "task"]);
});

test("runnerRegistersFullStandardsAndAdrContextInBothArchitectureAgents", async (context) => {
  const documents = [
    { path: "docs/architecture/team-standards.md", content: "# Accepted team standards\nOBS-02: Preserve failure events." },
    { path: "docs/adrs/0001.md", content: "# Accepted ADR\nPrefix cache keys with caseId." },
  ];
  const { config } = await startRunner(context, false, undefined, undefined, documents);
  for (const name of ["architecture-reviewer", "final-validator"]) {
    const agent = config().customAgents?.find((entry) => entry.name === name);
    assert.ok(agent);
    assert.ok(agent.prompt?.includes(JSON.stringify(documents)));
    assert.equal(agent.prompt.split("<<<ARCHITECTURE_DOCUMENTS_JSON").length - 1, 1);
    assert.deepEqual(agent?.tools, ["view", "grep", "glob"]);
  }
  const reviewContext = {
    title: "Review change", body: "", diff: "scoped diff", truncated: false,
    architectureDocuments: documents,
  };
  for (const prompt of [
    buildSpecialistPrompt(reviewContext, ["architecture-reviewer"]),
    buildValidationPrompt({ ...reviewContext, reports: [], candidates: [] }),
  ]) {
    assert.doesNotMatch(prompt, /<<<ARCHITECTURE_DOCUMENTS_JSON/);
    assert.match(prompt, /registered prompt/);
    for (const document of documents) assert.ok(!prompt.includes(document.content));
  }
});

test("runnerRequiresAValidatorRuntimeApiCheckCall", async (context) => {
  const { runner, config, logs, requests } = await startRunner(context, true);
  await assert.rejects(
    () => runner.runValidator("Validate", 1_000, []),
    /did not call the required check_runtime_api tool/,
  );

  assert.equal(runner.runtimeApiCheckEnabled, true);
  assert.ok(config().tools?.some((tool) => tool.name === "check_runtime_api"));
  assert.ok(config().availableTools);
  const validator = config().customAgents?.find((agent) => agent.name === "final-validator");
  assert.ok(validator?.tools?.includes("check_runtime_api"));
  const apiTool = config().tools?.find((tool) => tool.name === "check_runtime_api");
  assert.ok(apiTool);
  assert.equal(config().onPermissionRequest, approveAll);
  const parameters = apiTool.parameters;
  assert.ok(parameters && typeof parameters === "object" && "properties" in parameters);
  const properties = parameters.properties;
  assert.ok(properties && typeof properties === "object" && "path" in properties);
  assert.deepEqual(
    properties.path,
    {
      type: "string",
      enum: ["/health", "/counter", "/profile/ada/en", "/profile/ada/es", "/profile/grace/es"],
      description: "API path on the configured loopback service.",
    },
  );
  const defaultAgent = config().defaultAgent;
  assert.ok(defaultAgent?.excludedTools?.includes("check_runtime_api"));
  assert.deepEqual(requests, []);
  assert.deepEqual(runner.getRuntimeApiEvidence(), []);
  assert.ok(logs.some((message) => message.includes("required validator tool call was not observed")));
});

test("runnerCapturesEachSelectedRuntimeRequestForReviewEvidence", async (context) => {
  const { runner, logs, config, requests, report } = await startRunner(context, true, async (sessionConfig) => {
    const tool = sessionConfig.tools?.find((entry) => entry.name === "check_runtime_api");
    assert.ok(tool?.handler);
    const invocation = {} as Parameters<typeof tool.handler>[1];
    await tool.handler({ method: "GET", path: "/health" }, invocation);
    await tool.handler({ method: "HEAD", path: "/health" }, invocation);
  });
  await runner.runValidator("Validate", 1_000, []);

  assert.deepEqual(requests, [
    { method: "GET", path: "/health" },
    { method: "HEAD", path: "/health" },
  ]);
  assert.deepEqual(runner.getRuntimeApiEvidence().map((evidence) => ({
    method: evidence.request.method,
    path: new URL(evidence.request.url).pathname,
    status: evidence.response?.status,
  })), [
    { method: "GET", path: "/health", status: 200 },
    { method: "HEAD", path: "/health", status: 200 },
  ]);
  assert.ok(logs.includes(`[review-report] final-validator\n${report.replaceAll("test-secret", "[REDACTED]")}`));
  assert.ok(logs.every((message) => !message.includes("test-secret")));
  assert.ok(logs.some((message) => message.includes('"reason": "request and response captured for review rendering"')));
});

test("runnerCapturesLocalizedProfileProbeSequenceInOrder", async (context) => {
  const paths = ["/profile/grace/es", "/profile/ada/en", "/profile/ada/es"];
  const { runner, requests } = await startRunner(context, true, async (sessionConfig) => {
    const tool = sessionConfig.tools?.find((entry) => entry.name === "check_runtime_api");
    assert.ok(tool?.handler);
    const invocation = {} as Parameters<typeof tool.handler>[1];
    for (const path of paths) await tool.handler({ method: "GET", path }, invocation);
  });
  await runner.runValidator("Validate", 1_000, []);

  assert.deepEqual(requests, paths.map((path) => ({ method: "GET", path })));
  assert.deepEqual(runner.getRuntimeApiEvidence().map((evidence) => new URL(evidence.request.url).pathname), paths);
});

test("runnerCapturesFailedEndpointResponsesForReviewEvidence", async (context) => {
  const { runner, config } = await startRunner(context, true, async (sessionConfig) => {
    const tool = sessionConfig.tools?.find((entry) => entry.name === "check_runtime_api");
    assert.ok(tool?.handler);
    const invocation = {} as Parameters<typeof tool.handler>[1];
    await tool.handler({ method: "POST", path: "/counter" }, invocation);
  }, () => new Response('{"status":"degraded"}', { status: 503, statusText: "Unavailable" }));
  await runner.runValidator("Validate", 1_000, []);

  assert.equal(runner.getRuntimeApiEvidence()[0]?.response?.status, 503);
  assert.equal(runner.getRuntimeApiEvidence()[0]?.response?.body, '{"status":"degraded"}');
  assert.equal(config().tools?.some((tool) => tool.name === "check_runtime_api"), true);
});
