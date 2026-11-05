import assert from "node:assert/strict";
import { test } from "node:test";
import { isReviewCommand } from "../src/application/review-command.ts";
import { resolveReviewRequest } from "../src/integrations/github/review-request.ts";
import type { ReviewRequestGitHub } from "../src/integrations/github/review-request.ts";

function fakes({
  body = "/cool-review",
  permission = "write",
  headRepo = "octo/demo" as string | null,
  files = [] as string[],
} = {}) {
  const calls: string[] = [];
  const outputs: Record<string, string> = {};
  const github: ReviewRequestGitHub = {
    rest: {
      repos: {
        getCollaboratorPermissionLevel: async () => { calls.push("permission"); return { data: { permission } }; },
      },
      reactions: { createForIssueComment: async () => { calls.push("reaction"); } },
      pulls: {
        get: async () => {
          calls.push("pull");
          return { data: { head: { sha: "a".repeat(40), repo: headRepo === null ? null : { full_name: headRepo } } } };
        },
        listFiles: Symbol("listFiles"),
      },
    },
    paginate: async () => { calls.push("files"); return files.map((filename) => ({ filename })); },
  };
  const context = {
    repo: { owner: "octo", repo: "demo" },
    payload: { comment: { id: 7, body, user: { login: "dev" } }, issue: { number: 3 } },
  };
  const core = { info: () => {}, setOutput: (name: string, value: string) => { outputs[name] = value; } };
  return { github, context, core, calls, outputs };
}

test("isReviewCommand_ShouldMatchOnlyTheExactCommandToken", () => {
  for (const body of ["/cool-review", "/cool-review --bogus", "/cool-review\r\n--evidence"]) {
    assert.equal(isReviewCommand(body), true, body);
  }
  for (const body of ["/cool-reviewer", "/COOL-REVIEW", " /cool-review", "/cool-review-extra"]) {
    assert.equal(isReviewCommand(body), false, body);
  }
});

test("resolveReviewRequest_ShouldSkipNonCommandsWithoutApiCalls", async () => {
  const deps = fakes({ body: "/cool-reviewer is great" });
  await resolveReviewRequest(deps);
  assert.deepEqual(deps.calls, []);
  assert.equal(deps.outputs.run, "false");
});

test("resolveReviewRequest_ShouldRejectReadOnlyCommenterBeforeReactionOrPullLookup", async () => {
  const deps = fakes({ permission: "read" });
  await assert.rejects(resolveReviewRequest(deps), /needs write access/);
  assert.deepEqual(deps.calls, ["permission"]);
  assert.equal(deps.outputs.run, "false");
});

test("resolveReviewRequest_ShouldRejectMalformedArgumentsBeforeReaction", async () => {
  const deps = fakes({ body: "/cool-review --unknown" });
  await assert.rejects(resolveReviewRequest(deps));
  assert.deepEqual(deps.calls, ["permission"]);
  assert.equal(deps.outputs.run, "false");
});

test("resolveReviewRequest_ShouldEnableEvidenceOnlyForSameRepoDemoChanges", async () => {
  const deps = fakes({
    body: "/cool-review --evidence --model m1 --code-reviewer",
    files: ["README.md", "src/js-codebase/api.js"],
  });
  await resolveReviewRequest(deps);
  assert.deepEqual(deps.calls, ["permission", "reaction", "pull", "files"]);
  assert.deepEqual(deps.outputs, {
    run: "true", model: "m1", reviewers: "--code-reviewer",
    same_repo: "true", head_sha: "a".repeat(40), evidence: "true",
  });
});

test("resolveReviewRequest_ShouldDisableEvidenceWithoutListingFilesWhenNotEligible", async () => {
  for (const options of [{ body: "/cool-review --evidence", headRepo: "fork/demo" }, { headRepo: null }, {}]) {
    const deps = fakes(options);
    await resolveReviewRequest(deps);
    assert.equal(deps.calls.includes("files"), false);
    assert.equal(deps.outputs.evidence, "false");
    assert.equal(deps.outputs.run, "true");
  }
});

test("resolveReviewRequest_ShouldDisableEvidenceWhenDemoCodeIsUnchanged", async () => {
  const deps = fakes({ body: "/cool-review --evidence", files: ["docs/adrs/README.md"] });
  await resolveReviewRequest(deps);
  assert.equal(deps.outputs.evidence, "false");
});

test("resolveReviewRequest_ShouldAcceptAdminPermission", async () => {
  const deps = fakes({ permission: "admin" });
  await resolveReviewRequest(deps);
  assert.equal(deps.outputs.run, "true");
});

test("resolveReviewRequest_ShouldKeepReviewDisabledWhenGitHubFails", async () => {
  const deps = fakes({ body: "/cool-review --evidence" });
  const failure = new Error("GitHub unavailable");
  deps.github.paginate = async () => { throw failure; };
  await assert.rejects(resolveReviewRequest(deps), (error) => error === failure);
  assert.equal(deps.outputs.run, "false");
});
