import asyncio
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from evals.datasets.loader import load_dataset
from evals.review_agent.reviewer import review_pull_request   # find → dedup → verify
from evals.judge.judge import judge_pr                        # match findings to golden
from evals.harness.metrics import build_run_report, compute_pr_metrics
from evals import progress
from evals.usage import usage

TRANSCRIPTS_DIR = Path(__file__).parent / "evals" / "transcripts"

# golden_comments are the ground-truth issues a good reviewer should find.
# NOTE: Remove dotnet filter to test other samples
prs = [pr for pr in load_dataset("samples") if "dotnet" in pr.id]

# Three specialist sub-agents run in parallel (bug / security / performance),
# each reads the codebase with Glob + Read + Grep tools, then outputs findings.
# A dedup step merges overlapping findings, then an adversarial verifier agent
# challenges each one and drops low-confidence results.
#
#   run_specialists(pr)     →  candidates[]
#   dedup_findings(…)       →  deduped[]
#   verify_findings(pr, …)  →  final findings[]
#
# review_pull_request() wraps all three steps.

async def main():
    progress.reset()
    # 0 Usage + o11y telemetry, shown as a summary at the end
    usage.reset()
    t0 = time.monotonic()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    transcript_dir = TRANSCRIPTS_DIR / f"demo-{stamp}"

    all_metrics = []
    for pr in prs:
        # 1 Run agents
        findings = await review_pull_request(pr, mode="full", transcript_dir=transcript_dir)

        # 2 Grader: LLM-as-a-judge (model-based grader)
        verdicts = await judge_pr(pr, findings)

        # 3 Scores and outcomes: precision, recall, F1, severity_accuracy, etc
        metrics = compute_pr_metrics(pr, verdicts)
        all_metrics.append(metrics)
        print(json.dumps(metrics.model_dump()))

    # 4 Run report — aggregate per-PR metrics and evaluate the gate
    report = build_run_report("samples", all_metrics)
    print(json.dumps(report.model_dump()))

    # 5 Telemetry summary
    wall = time.monotonic() - t0
    print(json.dumps({
        "calls": usage.calls, "input_tokens": usage.input_tokens,
        "output_tokens": usage.output_tokens, "cache_read_tokens": usage.cache_read_tokens,
        "cost_usd": round(usage.cost_usd, 4), "wall_s": round(wall, 1),
        "transcripts": str(transcript_dir),
    }))

asyncio.run(main())
