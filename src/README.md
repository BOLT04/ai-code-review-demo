# AI Demo — Code Review Evals Demo

Multi-agent AI code review system with a simple evals demo (precision / recall / F1). Some of the parts are simplified,
this is based on https://codereview.withmartian.com/, in order for us to use a public dataset too.

All private dataset examples and prompts can be used by editing this demo.

## Quick start

We can use `demo.py` or the CLI with more options:
```bash
cd src
python -m evals.cli review --pr evals/datasets/public/sample_pr.json
python -m evals.cli eval --dataset public
python -m evals.cli --profile public eval --dataset samples --concurrency 1 --mode full --filter dotnet
python -m evals.cli --profile public eval --dataset samples --concurrency 1 --mode simple --filter dotnet
```

## Provider

Set `REVIEW_PROVIDER` in `.env` (or override with `--provider`):
- `claude_code` (default) — local `claude -p` basically using claude code programmatically, no API key needed
- `anthropic` — direct API key
- `azure` — Azure / Microsoft Foundry
