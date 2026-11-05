import { REVIEWER_AGENT_IDS } from "./review-prompts.ts";
import type { ReviewerAgentName } from "./review-prompts.ts";

export class ReviewSelectionError extends Error {}

function isReviewerAgentName(name: string): name is ReviewerAgentName {
  return Object.hasOwn(REVIEWER_AGENT_IDS, name);
}

export function parseReviewerSelection(args: string[]): ReviewerAgentName[] | undefined {
  if (args.length === 0) return undefined;
  if (args.length > 2 || args.some((arg) => !arg.startsWith("--"))) {
    throw new ReviewSelectionError(
      `Expected no arguments or up to two --<reviewer-name> options. Available reviewers: ${Object.keys(REVIEWER_AGENT_IDS).join(", ")}.`,
    );
  }

  const reviewers: ReviewerAgentName[] = [];
  for (const arg of args) {
    const name = arg.slice(2);
    if (!isReviewerAgentName(name)) {
      throw new ReviewSelectionError(
        `Unknown reviewer "${name}". Available reviewers: ${Object.keys(REVIEWER_AGENT_IDS).join(", ")}.`,
      );
    }
    reviewers.push(name);
  }
  if (new Set(reviewers).size !== reviewers.length) {
    throw new ReviewSelectionError("Select two different specialist reviewers.");
  }
  return reviewers;
}
