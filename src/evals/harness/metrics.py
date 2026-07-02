"""Precision / recall / F1, Martian-aligned, plus the success gate.

Definitions (strict Martian):
  TP = a finding that the judge matched to a golden comment
  FP = a finding the judge matched to NO golden comment
  FN = a golden comment that NO finding matched

  precision = TP / (TP + FP)        # of what we reported, how much was real
  recall    = TP / (TP + FN)        # of the real issues, how many we caught
  f1        = 2*P*R / (P + R)

Edge case: precision is undefined when a PR yields zero findings (0/0). We
report it as 1.0 (vacuously precise — reported nothing wrong) and record a note.
Recall is 0.0 when there are golden comments but none were found; 1.0 when there
are no golden comments to find.

Aggregates:
  macro = unweighted mean of the per-PR metrics
  micro = computed from summed TP/FP/FN across all PRs
"""

from __future__ import annotations

from ..config import settings
from ..models import (
    Category,
    F1GateResult,
    GateResult,
    MatchVerdict,
    PRMetrics,
    PullRequest,
    RunReport,
)


_SEVERITY_WEIGHT = {"Critical": 4, "High": 3, "Medium": 2, "Low": 1}


def _safe_div(num: float, den: float, *, default: float) -> float:
    return num / den if den else default


def compute_pr_metrics(pr: PullRequest, verdicts: list[MatchVerdict]) -> PRMetrics:
    """Compute precision, recall, F1, and auxiliary metrics for a single PR.

    Performs a single-pass computation of metrics by consolidating all verdicts
    into a single loop, computing derived metrics directly (avoiding O(4N) to O(N)).

    Args:
        pr: The pull request with its golden comments (expected findings).
        verdicts: Judge verdicts matching findings to golden comments.

    Returns:
        PRMetrics with all scores and breakdown data.
    """
    # Single-pass consolidation: Build all needed data in one iteration.
    # Avoids the previous O(4N) pattern (four separate comprehensions).
    matched_golden_ids: set[str] = set()
    matched_finding_ids: set[str] = set()
    unmatched_finding_ids: list[str] = []
    plausible_unmatched: int = 0
    verdict_by_finding: dict[str, MatchVerdict] = {}
    severity_matches: int = 0
    tp_verdict_count: int = 0
    actionability_sum: float = 0
    actionability_count: int = 0

    for v in verdicts:
        if v.is_match:
            if v.golden_id:
                matched_golden_ids.add(v.golden_id)
            if v.finding_id:
                matched_finding_ids.add(v.finding_id)
            if v.severity_match is not None and v.severity_match:
                severity_matches += 1
            if v.severity_match is not None:
                tp_verdict_count += 1
        else:
            # Unmatched finding (false positive).
            if v.finding_id:
                unmatched_finding_ids.append(v.finding_id)
                verdict_by_finding[v.finding_id] = v
                if v.finding_is_plausible:
                    plausible_unmatched += 1

        # Accumulate actionability scores for all verdicts with one present.
        if v.actionability_score is not None:
            actionability_sum += v.actionability_score
            actionability_count += 1

    # Basic Martian metrics: TP, FP, FN
    n_golden = len(pr.golden_comments)
    tp = len(matched_golden_ids)
    fp = len(unmatched_finding_ids)
    fn = n_golden - tp
    n_findings = tp + fp

    # Precision / Recall / F1 (Martian definitions)
    precision = _safe_div(tp, tp + fp, default=1.0)  # 0 findings => vacuously 1.0
    recall = _safe_div(tp, tp + fn, default=1.0)     # 0 goldens  => vacuously 1.0
    f1 = _safe_div(2 * precision * recall, precision + recall, default=0.0)

    # Adjusted metrics: distinguish plausible FP from hallucinated FP
    # Plausible FPs are real issues missed by the golden set; hallucinated FPs
    # are false detections (worse, as they dilute precision).
    hallucinated_fp = fp - plausible_unmatched
    adjusted_precision = _safe_div(tp, tp + hallucinated_fp, default=1.0)

    # Severity accuracy: % of true positives with matching severity
    severity_accuracy = (
        _safe_div(severity_matches, tp_verdict_count, default=0.0)
        if tp_verdict_count else 0.0
    )

    # Actionability score: mean 1-5 across all verdicts with a score
    avg_actionability = (
        _safe_div(actionability_sum, actionability_count, default=0.0)
        if actionability_count else 0.0
    )

    # Severity-weighted recall: weight TPs by issue severity (Critical > High > Medium > Low)
    golden_by_id = {g.id: g for g in pr.golden_comments}
    total_weight = sum(_SEVERITY_WEIGHT.get(g.severity.value, 2) for g in pr.golden_comments)
    matched_weight = sum(
        _SEVERITY_WEIGHT.get(golden_by_id[gid].severity.value, 2)
        for gid in matched_golden_ids
        if gid in golden_by_id
    )
    weighted_recall = _safe_div(matched_weight, total_weight, default=1.0)

    # Category-level recall breakdown: recall per finding category (bug, security, perf)
    category_recall: dict[str, float] = {}
    for cat in Category:
        cat_goldens = [g for g in pr.golden_comments if g.category == cat]
        if cat_goldens:
            cat_matched = sum(1 for g in cat_goldens if g.id in matched_golden_ids)
            category_recall[cat.value] = round(_safe_div(cat_matched, len(cat_goldens), default=1.0), 4)

    return PRMetrics(
        pr_id=pr.id,
        true_positives=tp,
        false_positives=fp,
        false_negatives=fn,
        precision=round(precision, 4),
        recall=round(recall, 4),
        f1=round(f1, 4),
        n_findings=n_findings,
        n_golden=n_golden,
        matched_golden_ids=sorted(matched_golden_ids),
        unmatched_finding_ids=sorted(unmatched_finding_ids),
        plausible_false_positives=plausible_unmatched,
        adjusted_precision=round(adjusted_precision, 4),
        severity_accuracy=round(severity_accuracy, 4),
        avg_actionability=round(avg_actionability, 2),
        weighted_recall=round(weighted_recall, 4),
        category_recall=category_recall,
    )


def evaluate_gate(per_pr: list[PRMetrics]) -> GateResult:
    """Evaluate the success gate: did the eval pass quality thresholds?

    Checks:
      1. No judge/infra errors (INCONCLUSIVE status)
      2. Minimum % of PRs with recall >= threshold
      3. Hard (hallucinated) false positives <= threshold

    BUG FIX (BUG-4): Previously computed hard_fp = total_fp - plausible_fp without
    bounds checking. If judge incorrectly marked more as plausible than total FP count
    (data inconsistency), hard_fp would be negative, breaking gate logic.
    Now: hard_fp = max(0, total_fp - plausible_fp) to handle data anomalies.

    Args:
        per_pr: Metrics from all evaluated PRs.

    Returns:
        GateResult with pass/fail status and detailed reasoning.
    """
    min_recall = settings.gate_min_recall
    min_passing = settings.gate_min_passing_prs
    max_fp = settings.gate_max_false_positives

    # A PR whose judge failed has no valid metrics. It must not be scored as a
    # 0% quality result, and its (meaningless) zeros must not pollute the FP/
    # recall tallies. Any such PR makes the whole run INCONCLUSIVE — the honest
    # outcome is "re-run", not PASS/FAIL on partial data.
    errored = [m for m in per_pr if m.error]
    scored = [m for m in per_pr if not m.error]

    passing = [m for m in scored if m.recall >= min_recall]
    total_fp = sum(m.false_positives for m in scored)
    plausible_fp = sum(m.plausible_false_positives for m in scored)

    # Gate on *hard* (hallucinated/wrong) FPs only. Real issues the judge confirms
    # are absent from the golden set (plausible FPs) reflect thoroughness, not error,
    # and must not fail the precision gate. The judge defaults unmatched findings to
    # plausible=False, so genuine hallucinations still count here.
    # NOTE: Clamp to 0 to handle data inconsistency (plausible_fp > total_fp).
    hard_fp = max(0, total_fp - plausible_fp)

    reasons: list[str] = []
    ok_prs = len(passing) >= min_passing
    ok_fp = hard_fp <= max_fp
    ok_no_errors = not errored
    plausible_note = (
        f" ({plausible_fp} real-but-unlabeled FP excused)" if plausible_fp else ""
    )
    if errored:
        ids = ", ".join(m.pr_id for m in errored)
        reasons.append(
            f"INCONCLUSIVE — judge/infra failure on {len(errored)} PR(s) [{ids}]. "
            f"This is NOT a quality result; re-run the eval."
        )
    if not ok_prs:
        reasons.append(
            f"{len(passing)}/{len(per_pr)} PRs reached recall>={min_recall:.0%} "
            f"(need {min_passing})."
        )
    if not ok_fp:
        reasons.append(
            f"{hard_fp} hallucinated false positives across the run "
            f"(max {max_fp}){plausible_note}."
        )
    if ok_prs and ok_fp:
        reasons.append(
            f"{len(passing)}/{len(per_pr)} PRs at recall>={min_recall:.0%} and "
            f"{hard_fp} hallucinated false positives{plausible_note}."
        )
    # Always mention false positives when gate passes but PRs insufficient
    if ok_fp and not ok_prs:
        reasons.append(
            f"Got {hard_fp} hallucinated false positives (limit {max_fp}){plausible_note}."
        )

    return GateResult(
        passed=ok_prs and ok_fp and ok_no_errors,
        min_recall=min_recall,
        min_passing_prs=min_passing,
        max_false_positives=max_fp,
        passing_prs=len(passing),
        total_false_positives=total_fp,
        hard_false_positives=hard_fp,
        plausible_false_positives=plausible_fp,
        reasons=reasons,
    )


def evaluate_f1_gate(per_pr: list[PRMetrics]) -> F1GateResult:
    min_f1 = settings.gate_f1_min_score
    min_passing = settings.gate_f1_min_passing_prs

    # Same infra-failure handling as the main gate: errored PRs are inconclusive,
    # not quality failures.
    errored = [m for m in per_pr if m.error]
    scored = [m for m in per_pr if not m.error]

    passing = [m for m in scored if m.f1 >= min_f1]
    ok_prs = len(passing) >= min_passing
    ok_no_errors = not errored

    reasons: list[str] = []
    if errored:
        ids = ", ".join(m.pr_id for m in errored)
        reasons.append(
            f"INCONCLUSIVE — judge/infra failure on {len(errored)} PR(s) [{ids}]. "
            f"This is NOT a quality result; re-run the eval."
        )
    if not ok_prs:
        reasons.append(
            f"{len(passing)}/{len(per_pr)} PRs reached F1>={min_f1:.0%} "
            f"(need {min_passing})."
        )
    if ok_prs:
        reasons.append(
            f"{len(passing)}/{len(per_pr)} PRs at F1>={min_f1:.0%}."
        )

    return F1GateResult(
        passed=ok_prs and ok_no_errors,
        min_f1=min_f1,
        min_passing_prs=min_passing,
        passing_prs=len(passing),
        reasons=reasons,
    )


def build_run_report(dataset: str, per_pr: list[PRMetrics]) -> RunReport:
    report = RunReport(
        dataset=dataset,
        judge_model=settings.judge_model,
        specialist_model=settings.specialist_model,
        verifier_model=settings.verifier_model,
        per_pr=per_pr,
    )
    # Aggregate only over PRs that were actually scored — an errored (judge/infra
    # failure) PR has meaningless zeros that would otherwise deflate every metric.
    scored = [m for m in per_pr if not m.error]
    if [m for m in per_pr if m.error]:
        ids = ", ".join(m.pr_id for m in per_pr if m.error)
        report.notes.append(
            f"Judge/infra failure on: {ids}. Aggregates cover the {len(scored)} "
            f"scored PR(s) only; the run is INCONCLUSIVE — re-run."
        )
    if scored:
        n = len(scored)
        report.macro_precision = round(sum(m.precision for m in scored) / n, 4)
        report.macro_recall = round(sum(m.recall for m in scored) / n, 4)
        report.macro_f1 = round(sum(m.f1 for m in scored) / n, 4)

        tp = sum(m.true_positives for m in scored)
        fp = sum(m.false_positives for m in scored)
        fn = sum(m.false_negatives for m in scored)
        mp = _safe_div(tp, tp + fp, default=1.0)
        mr = _safe_div(tp, tp + fn, default=1.0)
        report.micro_precision = round(mp, 4)
        report.micro_recall = round(mr, 4)
        report.micro_f1 = round(_safe_div(2 * mp * mr, mp + mr, default=0.0), 4)

        # new aggregates
        report.avg_severity_accuracy = round(sum(m.severity_accuracy for m in scored) / n, 4)
        report.avg_actionability = round(sum(m.avg_actionability for m in scored) / n, 2)
        report.plausible_fp_total = sum(m.plausible_false_positives for m in scored)
        report.avg_adjusted_precision = round(sum(m.adjusted_precision for m in scored) / n, 4)
        report.avg_weighted_recall = round(sum(m.weighted_recall for m in scored) / n, 4)

    report.gate = evaluate_gate(per_pr)
    report.f1_gate = evaluate_f1_gate(per_pr)
    return report
