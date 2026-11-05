import { isReviewCommand, parseReviewCommand } from "../../application/review-command.ts";

interface RepoRef { owner: string; repo: string }

export interface ReviewRequestGitHub {
  rest: {
    repos: {
      getCollaboratorPermissionLevel(params: RepoRef & { username: string }): Promise<{ data: { permission: string } }>;
    };
    reactions: {
      createForIssueComment(params: RepoRef & { comment_id: number; content: "eyes" }): Promise<unknown>;
    };
    pulls: {
      get(params: RepoRef & { pull_number: number }): Promise<{
        data: { head: { sha: string; repo: { full_name: string } | null } };
      }>;
      listFiles: unknown;
    };
  };
  paginate(
    method: unknown,
    params: RepoRef & { pull_number: number; per_page: number },
  ): Promise<Array<{ filename: string }>>;
}

export interface ReviewRequestContext {
  repo: RepoRef;
  payload: {
    comment: { id: number; body: string; user: { login: string } };
    issue: { number: number };
  };
}

export interface ReviewRequestCore {
  info(message: string): void;
  setOutput(name: string, value: string): void;
}

const WRITE_PERMISSIONS = new Set(["admin", "write"]);
const EVIDENCE_PATH_PREFIX = "src/js-codebase/";

export async function resolveReviewRequest({ github, context, core }: {
  github: ReviewRequestGitHub;
  context: ReviewRequestContext;
  core: ReviewRequestCore;
}): Promise<void> {
  const { owner, repo } = context.repo;
  const { comment, issue } = context.payload;
  core.setOutput("run", "false");

  if (!isReviewCommand(comment.body)) {
    core.info("Comment is not a /cool-review command; skipping review.");
    return;
  }

  const { data: access } = await github.rest.repos.getCollaboratorPermissionLevel({
    owner, repo, username: comment.user.login,
  });
  if (!WRITE_PERMISSIONS.has(access.permission)) {
    throw new Error(`@${comment.user.login} needs write access to run /cool-review (has: ${access.permission}).`);
  }

  const { model, evidence: requested, reviewers } = parseReviewCommand(comment.body);
  core.setOutput("model", model);
  core.setOutput("reviewers", reviewers.join(" "));
  core.info(`Parsed review options: ${JSON.stringify({
    evidenceRequested: requested,
    modelOverride: model || null,
    selectedReviewers: reviewers,
    defaultReviewers: reviewers.length === 0,
  })}`);

  await github.rest.reactions.createForIssueComment({ owner, repo, comment_id: comment.id, content: "eyes" });

  const pullNumber = issue.number;
  const { data: pr } = await github.rest.pulls.get({ owner, repo, pull_number: pullNumber });
  const sameRepository = pr.head.repo?.full_name === `${owner}/${repo}`;
  core.setOutput("same_repo", String(sameRepository));
  core.setOutput("head_sha", pr.head.sha);

  const decision = await decideEvidence(github, { owner, repo, pullNumber, requested, sameRepository });
  core.info(`Evidence decision: ${JSON.stringify(decision)}`);
  core.setOutput("evidence", String(decision.enabled));
  core.setOutput("run", "true");
}

async function decideEvidence(
  github: ReviewRequestGitHub,
  { owner, repo, pullNumber, requested, sameRepository }:
    RepoRef & { pullNumber: number; requested: boolean; sameRepository: boolean },
) {
  if (!sameRepository) {
    return { requested, sameRepository, enabled: false, reason: "fork PRs are not eligible" };
  }
  if (!requested) {
    return { requested, sameRepository, enabled: false, reason: "the command did not request evidence" };
  }
  const files = await github.paginate(github.rest.pulls.listFiles, {
    owner, repo, pull_number: pullNumber, per_page: 100,
  });
  const changedDemoFiles = files.map((file) => file.filename).filter((name) => name.startsWith(EVIDENCE_PATH_PREFIX));
  const enabled = changedDemoFiles.length > 0;
  return {
    requested, sameRepository, changedDemoFiles, enabled,
    reason: enabled ? "eligible; stack startup must still pass" : `the PR does not change ${EVIDENCE_PATH_PREFIX}`,
  };
}
