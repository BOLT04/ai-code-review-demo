import { parseReviewerSelection } from "./review-selection.ts";

const REVIEW_COMMAND = /^\/cool-review(?:\s+([\s\S]*))?$/;

export const isReviewCommand = (body: string): boolean => REVIEW_COMMAND.test(body);

export function parseReviewCommand(body: string): { model: string; evidence: boolean; reviewers: string[] } {
  const command = body.match(REVIEW_COMMAND);
  if (!command) {
    throw new Error("Use `/cool-review [--evidence] [--model <model>] [--<reviewer-name> [--<reviewer-name>]]`.");
  }

  const args = (command[1] ?? "").trim().split(/\s+/).filter(Boolean);
  let model = "";
  let evidence = false;
  const reviewers: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--evidence") {
      evidence = true;
    } else if (arg === "--model" || arg.startsWith("--model=")) {
      model = arg === "--model" ? args[++index] : arg.slice("--model=".length);
      if (!model || model.startsWith("--")) {
        throw new Error("Provide a value for `--model`, e.g. `/cool-review --model gpt-4.1`.");
      }
    } else {
      reviewers.push(arg);
    }
  }

  parseReviewerSelection(reviewers);
  return { model, evidence, reviewers };
}
