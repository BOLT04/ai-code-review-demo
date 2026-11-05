# AI Demos for code review

Below you can read the section to get started on the code review demos of this repository.

## TS Copilot SDK code review demo

TypeScript pull request reviews powered by the GitHub Copilot SDK.

### Quick start

Use Node.js 24 or later. Configure either `COPILOT_GITHUB_TOKEN` or the BYOK settings `BYOK_BASE_URL`, `BYOK_API_KEY`, and `BYOK_MODEL`.

```sh
cd src/copilot-review
npm ci --ignore-scripts
npm run review -- --code-reviewer
npm run review -- --code-reviewer --security-reviewer
npm run review -- --architecture-reviewer
```

### GitHub workflow and security boundaries

**Only my user is configured on the GH action workflow**, this can be changed for the demo. Comment `/cool-review` to request a review or rerun it, optionally selecting `--model <model>` and up to two specialist flags shown above. The `--evidence` option checks out the PR and builds/runs its demo API. This is a simple use case on purpose (basically a super small version of what [Greptile TREX has](https://www.greptile.com/blog/trex-code-execution)).

## Python code review evals demo

Multi-agent AI code review system with a simple evals demo (precision / recall / F1). Some of the parts are simplified,
this is based on https://codereview.withmartian.com/, in order for us to use a public dataset too.

All private dataset examples and prompts can be used by editing this demo.

### Quick start

We can use `demo.py` or the CLI with more options:
```bash
cd src
python -m evals.cli review --pr evals/datasets/public/sample_pr.json
python -m evals.cli eval --dataset public
python -m evals.cli --profile public eval --dataset samples --concurrency 1 --mode full --filter dotnet
python -m evals.cli --profile public eval --dataset samples --concurrency 1 --mode simple --filter dotnet
```

### Provider

Set `REVIEW_PROVIDER` in `.env` (or override with `--provider`):
- `claude_code` (default) — local `claude -p` basically using claude code programmatically, no API key needed
- `anthropic` — direct API key
- `azure` — Azure / Microsoft Foundry
