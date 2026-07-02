"""Drive the reviewer + judge over a dataset and produce a RunReport."""

from __future__ import annotations

import asyncio
from pathlib import Path

from ..judge import judge_pr
from ..judge.judge import JudgeError
from ..models import PRMetrics, PullRequest, RunReport
from ..review_agent import review_pull_request
from .. import progress
from .metrics import build_run_report, compute_pr_metrics


async def _score_one(
    pr: PullRequest,
    transcript_dir: Path | None = None,
    mode: str = "full",
):
    progress.log(f"{pr.id}: start")
    findings = await review_pull_request(pr, transcript_dir=transcript_dir, mode=mode)
    try:
        verdicts = await judge_pr(pr, findings, transcript_dir=transcript_dir)
    except JudgeError as exc:
        # Infra failure — do NOT report this as a 0% quality result. Mark the PR
        # as errored so the gate is inconclusive and the run can be re-tried.
        progress.log(f"{pr.id}: JUDGE ERROR — {exc}")
        return PRMetrics(pr_id=pr.id, error=str(exc), n_findings=len(findings))
    m = compute_pr_metrics(pr, verdicts)
    progress.log(
        f"{pr.id}: done (recall={m.recall:.2f} precision={m.precision:.2f} "
        f"f1={m.f1:.2f})"
    )
    return m


async def run_eval(
    dataset: str,
    prs: list[PullRequest],
    *,
    concurrency: int = 2,
    transcript_dir: Path | None = None,
    mode: str = "full",
) -> RunReport:
    """Evaluate every PR (bounded concurrency) and aggregate the report."""
    sem = asyncio.Semaphore(concurrency)

    async def _guarded(pr: PullRequest):
        async with sem:
            return await _score_one(pr, transcript_dir=transcript_dir, mode=mode)

    per_pr = await asyncio.gather(*(_guarded(pr) for pr in prs))
    report = build_run_report(dataset, list(per_pr))
    if not prs:
        report.notes.append("Dataset was empty.")
    return report
