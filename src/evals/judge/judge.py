"""Judge: Match reviewer findings to golden comments.

The judge receives a PR's golden comments (expected findings) and the reviewer's
findings, and produces verdicts indicating which findings matched which comments.

Each verdict represents one relationship:
  - matched pair         → MatchVerdict(golden_id, finding_id, is_match=True)
  - unmatched finding    → MatchVerdict(finding_id, is_match=False, plausible=?)
  - unmatched golden     → Derived later by metrics (a golden_id in no match = FN)

Strict one-to-one matching: each finding maps to at most one golden comment, and
each golden maps to at most one finding. Multiple findings claiming the same golden
(or vice versa) silently keeps only the first pair. All duplicate matches are
logged so we can investigate why the judge produced conflicting verdicts.
"""

from __future__ import annotations

from pathlib import Path

from ..agent_client import complete_json
from ..config import settings
from ..models import Finding, MatchVerdict, PullRequest
from .. import progress
from ..prompts import loader
from .prompts import JUDGE_SYSTEM, judge_user_prompt


class JudgeError(Exception):
    """The judge could not produce a usable verdict for a PR.

    This is an *infrastructure* failure (the model call raised, or returned an
    unusable/structurally-implausible result), NOT a statement that the reviewer
    scored badly. It must never be silently converted into a 0-match result:
    doing so reports "0% recall / everything is a false positive" for a PR the
    judge never actually scored, which corrupts the benchmark and the gate.
    """


async def judge_pr(
    pr: PullRequest,
    findings: list[Finding],
    transcript_dir: Path | None = None,
) -> list[MatchVerdict]:
    """Match findings to golden comments. Returns verdicts for all relationships.

    Args:
        pr: Pull request with its golden comments (expected findings).
        findings: List of findings produced by the reviewer.
        transcript_dir: Optional directory to save judge transcript (JSONL).

    Returns:
        List of MatchVerdict objects representing:
          - Matched pairs (is_match=True)
          - Unmatched findings (is_match=False, with plausibility assessment)

    Raises:
        JudgeError: If the judge model call fails or returns unusable output.
                   (NOT silently converted to 0 matches, which would corrupt the eval)

    Note:
        Unmatched goldens are *not* returned; they're inferred later by metrics
        as any golden_id that appears in no MatchVerdict with is_match=True.
    """
    # Degenerate cases don't need a model call.
    if not pr.golden_comments and not findings:
        return []
    if not findings:
        return []  # all goldens become FN in metrics; nothing to match

    progress.log(
        f"{pr.id}: judging {len(findings)} finding(s) vs "
        f"{len(pr.golden_comments)} golden(s) [{settings.judge_model.split('-')[1].capitalize()}]..."
    )
    system = loader.get("judge.md") or JUDGE_SYSTEM
    prompt = judge_user_prompt(pr, findings)
    tpath = transcript_dir / f"{pr.id}__judge.jsonl" if transcript_dir else None
    try:
        raw = await complete_json(
            prompt, model=settings.judge_model, system=system, transcript_path=tpath,
        )
    except Exception as exc:
        # Do NOT silently fabricate a 0-match result — that would score an infra
        # failure as "0% recall / all findings are false positives". Fail loud so
        # the run is marked ERROR (inconclusive) and can be re-run.
        raise JudgeError(
            f"judge model call failed for {pr.id}: {type(exc).__name__}: {exc}"
        ) from exc

    if not isinstance(raw, dict) or "matches" not in raw:
        raise JudgeError(
            f"judge returned an unusable payload for {pr.id} "
            f"(type={type(raw).__name__}, keys="
            f"{list(raw.keys()) if isinstance(raw, dict) else 'n/a'}); "
            f"see transcript {tpath}"
        )

    verdicts: list[MatchVerdict] = []
    matched_finding_ids: set[str] = set()
    matched_golden_ids: set[str] = set()

    golden_ids = {g.id for g in pr.golden_comments}
    finding_ids = {f.id for f in findings}

    # Process matched pairs. Enforce one-to-one matching: if the judge
    # produces duplicate matches (e.g., f1 matched to both g1 and g2), keep
    # only the first occurrence and log the duplicates for audit.
    duplicate_count = 0
    for m in (raw.get("matches", []) if isinstance(raw, dict) else []):
        if not isinstance(m, dict):
            continue
        gid, fid = str(m.get("golden_id", "")), str(m.get("finding_id", ""))

        # Validate IDs exist in the dataset.
        if gid not in golden_ids or fid not in finding_ids:
            continue

        # Enforce one-to-one: skip if either side already matched.
        if gid in matched_golden_ids or fid in matched_finding_ids:
            duplicate_count += 1
            continue  # Skip duplicate; log below.

        matched_golden_ids.add(gid)
        matched_finding_ids.add(fid)

        # Extract optional match metadata.
        severity_match = None
        if "severity_match" in m:
            try:
                severity_match = bool(m["severity_match"])
            except (TypeError, ValueError):
                severity_match = None

        actionability_score = None
        if "actionability_score" in m and isinstance(m["actionability_score"], (int, float)):
            try:
                actionability_score = int(m["actionability_score"])
            except (TypeError, ValueError):
                actionability_score = None

        verdicts.append(
            MatchVerdict(
                golden_id=gid,
                finding_id=fid,
                is_match=True,
                finding_is_plausible=True,
                rationale=str(m.get("rationale", "")),
                severity_match=severity_match,
                actionability_score=actionability_score,
            )
        )

    # Log duplicate matches for audit (BUG FIX: was silently skipped without logging).
    if duplicate_count:
        progress.log(
            f"  {pr.id}: {duplicate_count} duplicate match(es) skipped "
            "(one-to-one enforcement)"
        )

    # Extract metadata for unmatched findings (used to determine plausibility).
    plausible_by_id: dict[str, bool] = {}
    actionability_by_id: dict[str, int] = {}
    for u in (raw.get("unmatched_findings", []) if isinstance(raw, dict) else []):
        if isinstance(u, dict) and u.get("finding_id"):
            fid_u = str(u["finding_id"])
            plausible_by_id[fid_u] = bool(u.get("plausible", False))
            if "actionability_score" in u and isinstance(u["actionability_score"], (int, float)):
                try:
                    actionability_by_id[fid_u] = int(u["actionability_score"])
                except (TypeError, ValueError):
                    pass

    # Emit verdicts for unmatched findings (false positives under strict Martian scoring).
    for f in findings:
        if f.id in matched_finding_ids:
            continue  # Already matched.
        verdicts.append(
            MatchVerdict(
                finding_id=f.id,
                is_match=False,
                finding_is_plausible=plausible_by_id.get(f.id, False),
                rationale="unmatched finding",
                actionability_score=actionability_by_id.get(f.id),
            )
        )

    # Structural sanity check: zero matches when BOTH the reviewer reported
    # findings AND the PR has golden comments is not a real outcome — on these
    # datasets at least the SQL-injection / null-deref class always overlaps.
    # It is the fingerprint of a judge payload that parsed but was wrong-shape
    # (all ids filtered out, or matches silently empty). Treat it as an infra
    # failure rather than reporting 0% recall + everything-is-a-false-positive.
    if findings and pr.golden_comments and not matched_finding_ids:
        raise JudgeError(
            f"judge produced 0 matches for {pr.id} despite {len(findings)} "
            f"finding(s) and {len(pr.golden_comments)} golden comment(s) — "
            f"treating as an infra failure, not a 0% score. "
            f"See transcript {tpath}"
        )


    return verdicts
