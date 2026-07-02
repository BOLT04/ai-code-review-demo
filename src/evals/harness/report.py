"""Render a RunReport to a readable markdown summary."""

from __future__ import annotations

from ..models import RunReport


def _pct(x: float) -> str:
    return f"{x * 100:.1f}%"


def _score(x: float) -> str:
    """Format a 1-5 score."""
    return f"{x:.2f}/5"


def render_markdown(report: RunReport) -> str:
    lines: list[str] = []
    lines.append(f"# Code Review Eval - `{report.dataset}` dataset\n")
    lines.append(
        f"- Specialists: `{report.specialist_model}`  |  "
        f"Verifier: `{report.verifier_model}`  |  "
        f"Judge: `{report.judge_model}`\n"
    )

    # Gates
    has_errors = any(m.error for m in report.per_pr)
    if report.gate or report.f1_gate:
        lines.append("## Success gates\n")
    if report.gate:
        g = report.gate
        if has_errors:
            verdict = "INCONCLUSIVE (judge/infra failure — re-run)"
        else:
            verdict = "PASS" if g.passed else "FAIL"
        lines.append(f"### Recall/FP gate: {verdict}\n")
        lines.append(
            f"Target: >={g.min_passing_prs} PRs at recall >={_pct(g.min_recall)} "
            f"AND <={g.max_false_positives} hallucinated false positives across the run "
            f"(real issues missing from the golden set do not count).\n"
        )
        for r in g.reasons:
            lines.append(f"- {r}")
        lines.append("")
    if report.f1_gate:
        g = report.f1_gate
        if has_errors:
            verdict = "INCONCLUSIVE (judge/infra failure — re-run)"
        else:
            verdict = "PASS" if g.passed else "FAIL"
        lines.append(f"### F1 gate: {verdict}\n")
        lines.append(
            f"Target: >={g.min_passing_prs} PRs at F1 >={_pct(g.min_f1)}.\n"
        )
        for r in g.reasons:
            lines.append(f"- {r}")
        lines.append("")

    # Aggregates
    lines.append("## Aggregate metrics\n")
    lines.append("| | Precision | Recall | F1 |")
    lines.append("|---|---|---|---|")
    lines.append(
        f"| macro | {_pct(report.macro_precision)} | "
        f"{_pct(report.macro_recall)} | {_pct(report.macro_f1)} |"
    )
    lines.append(
        f"| micro | {_pct(report.micro_precision)} | "
        f"{_pct(report.micro_recall)} | {_pct(report.micro_f1)} |"
    )
    lines.append("")

    # Per-PR
    lines.append("## Per-PR results\n")
    lines.append("Column definitions:")
    lines.append("- **TP**: True Positives (findings matched to golden comments)")
    lines.append("- **FP**: False Positives (findings with no golden match)")
    lines.append("- **FN**: False Negatives (golden comments not found)")
    lines.append("- **Precision**: % of reported findings that were correct")
    lines.append("- **Recall**: % of golden issues that were caught")
    lines.append("- **F1**: Harmonic mean of precision and recall")
    lines.append("- **Adj. Precision**: Precision excluding plausible-but-unlabeled FPs")
    lines.append("- **Weighted Recall**: Recall weighted by severity (Critical=4x, High=3x, Medium=2x, Low=1x)")
    lines.append("")
    lines.append("| PR | TP | FP | FN | Precision | Recall | F1 | Adj. Precision | Weighted Recall |")
    lines.append("|---|---|---|---|---|---|---|---|---|")
    for m in report.per_pr:
        if m.error:
            # Infra failure — render as ERROR, not a 0% quality row.
            lines.append(
                f"| {m.pr_id} | — | — | — | ERROR | ERROR | ERROR | — | — |"
            )
            continue
        lines.append(
            f"| {m.pr_id} | {m.true_positives} | {m.false_positives} | "
            f"{m.false_negatives} | {_pct(m.precision)} | {_pct(m.recall)} | "
            f"{_pct(m.f1)} | {_pct(m.adjusted_precision)} | {_pct(m.weighted_recall)} |"
        )
    lines.append("")
    for m in report.per_pr:
        if m.error:
            lines.append(f"> **{m.pr_id} ERROR:** {m.error}")
    if any(m.error for m in report.per_pr):
        lines.append("")

    # Quality scorers (only if judge returned new-format fields)
    if report.avg_actionability > 0 or report.avg_severity_accuracy > 0:
        lines.append("## Quality scorers\n")
        lines.append("| | Adjusted Precision | Severity Accuracy | Avg Actionability | Weighted Recall |")
        lines.append("|---|---|---|---|---|")
        lines.append(
            f"| run | {_pct(report.avg_adjusted_precision)} | "
            f"{_pct(report.avg_severity_accuracy)} | "
            f"{_score(report.avg_actionability)} | "
            f"{_pct(report.avg_weighted_recall)} |"
        )
        lines.append("")
        lines.append("- **Adjusted precision**: precision excluding plausible-but-unlabeled FPs (real issues missing from golden set)")
        lines.append("- **Severity accuracy**: of findings that matched a golden, % where severity was also correct")
        lines.append("- **Avg actionability**: mean specificity of findings (1 = vague, 5 = file+line+fix)")
        lines.append("- **Weighted recall**: recall weighted by severity (Critical=4x, High=3x, Medium=2x, Low=1x)")
        lines.append(f"- Plausible FPs (real issues not in golden set): {report.plausible_fp_total}")
        lines.append("")

    # Category recall breakdown (only if any PR has category data)
    all_cats: set[str] = set()
    for m in report.per_pr:
        all_cats.update(m.category_recall.keys())
    if all_cats:
        sorted_cats = sorted(all_cats)
        lines.append("## Category recall breakdown\n")
        header = "| PR | " + " | ".join(c.capitalize() for c in sorted_cats) + " |"
        sep = "|---|" + "---|" * len(sorted_cats)
        lines.append(header)
        lines.append(sep)
        for m in report.per_pr:
            row = f"| {m.pr_id} |"
            for cat in sorted_cats:
                val = m.category_recall.get(cat)
                row += f" {_pct(val)} |" if val is not None else " — |"
            lines.append(row)
        lines.append("")

    if report.notes:
        lines.append("## Notes\n")
        for n in report.notes:
            lines.append(f"- {n}")
        lines.append("")

    return "\n".join(lines)
