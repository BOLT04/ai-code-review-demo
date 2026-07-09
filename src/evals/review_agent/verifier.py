"""Adversarial verification pass (Opus 4.8).

Takes the deduped candidate findings and confirms each is substantiated by the
diff. Drops hallucinations and pure-style noise. This is the precision guard;
it's framed to keep real bugs (protecting recall) and only cut what it can
specifically justify dropping.

BUG FIX (BUG-3): Properly distinguish between structural failure (verdicts missing
or unparseable) vs. semantic outcome (verdicts is valid but all marked unverified).
The previous code conflated these, causing legitimate "no verified findings" results
to fall through to the high-confidence fallback, which would inflate recall artificially.
"""

from __future__ import annotations

import json
from pathlib import Path

from ..agent_client import complete_agentic_json, complete_json, VERIFIER_JSON_SCHEMA
from ..config import settings
from ..models import Finding, PullRequest, Severity
from .. import progress
from ..prompts import loader
from .prompts import VERIFIER_SYSTEM, pr_context_block, resolve_codebase_path


def _candidates_block(findings: list[Finding]) -> str:
    """Serialize candidate findings to JSON for verifier input."""
    payload = [
        {
            "id": f.id,
            "file": f.file,
            "line": f.line,
            "severity": f.severity.value,
            "category": f.category.value,
            "comment": f.comment,
            "confidence": f.confidence,
        }
        for f in findings
    ]
    return json.dumps(payload, indent=2)


async def verify_findings(
    pr: PullRequest, findings: list[Finding], transcript_dir: Path | None = None
) -> list[Finding]:
    """Verify candidate findings using the verifier model.

    The verifier acts as an adversary: given the PR diff (or actual codebase),
    it checks each candidate finding and marks it verified or not. Unverified
    findings are dropped (precision guard).

    Two modes:
      1. Diff-based: PR diff provided via complete_json
      2. Agentic: Model reads actual codebase with file tools

    Args:
        pr: The PR with its diff (or codebase_path for agentic mode).
        findings: Candidate findings to verify.
        transcript_dir: Optional directory for transcripts.

    Returns:
        Verified findings (subset of input), with re-ID'd (v1, v2, ...).
    """
    if not findings:
        return []
    if pr.codebase_path:
        return await _verify_findings_agentic(pr, findings, transcript_dir)

    model_label = settings.verifier_model.split("-")[1].capitalize()
    progress.log(f"{pr.id}: verifying {len(findings)} candidate(s) [{model_label}]...")
    prompt = (
        pr_context_block(pr)
        + "\n\n## Candidate findings to verify\n```json\n"
        + _candidates_block(findings)
        + "\n```\n\nVerify each candidate against the code above."
    )

    tpath = transcript_dir / f"{pr.id}__verifier.jsonl" if transcript_dir else None
    system = loader.get("verifier.md") or VERIFIER_SYSTEM
    try:
        raw = await complete_json(
            prompt, model=settings.verifier_model, system=system, transcript_path=tpath
        )
    except Exception:
        # If verification fails (model call error), fall back to high-confidence only,
        # so we degrade toward precision rather than emitting unverified noise.
        kept = [f for f in findings if f.confidence >= 0.7]
        progress.log(f"{pr.id}: verifier unavailable; kept {len(kept)} high-confidence")
        return kept

    verdicts = raw.get("verified_findings", []) if isinstance(raw, dict) else []
    out = _apply_verdicts(findings, verdicts, pr.id)
    for i, f in enumerate(out, start=1):
        f.id = f"v{i}"
    progress.log(f"{pr.id}: verified -> {len(out)} confirmed finding(s)")
    return out


def _apply_verdicts(
    findings: list[Finding], verdicts: list, pr_id: str = ""
) -> list[Finding]:
    """Apply verifier verdicts to the candidate list.

    BUG FIX (BUG-3): Distinguish between two failure modes:
      1. Structural failure: verdicts is None, not a list, or missing entirely
         → This is an infra issue; fall back to high-confidence to avoid silent loss
      2. Semantic outcome: verdicts is valid but all items have verified=False
         → This is a legitimate result; don't fall back (that would silently inflate recall)

    Args:
        findings: List of candidate findings.
        verdicts: List of verdict dicts from verifier (may be None, invalid, or empty).
        pr_id: PR ID for logging.

    Returns:
        List of verified findings (subset of input), or fallback if structural failure.
    """
    by_id = {f.id: f for f in findings}
    out: list[Finding] = []

    # Check for structural failure: verdicts not in expected format.
    # This indicates a model call issue, not a semantic outcome.
    if verdicts is None or not isinstance(verdicts, list):
        high_conf = [f for f in findings if f.confidence >= 0.8]
        progress.log(
            f"{pr_id}: verifier returned non-list verdicts ({type(verdicts).__name__}); "
            f"treating as structural failure. Falling back to {len(high_conf)} "
            f"high-confidence (≥0.8) candidates."
        )
        return high_conf

    # Empty verdict list is valid (not a failure). Don't fall back.
    # This means the verifier examined all findings and marked none as verified,
    # which is a legitimate outcome (they were hallucinations).
    if not verdicts:
        if findings:
            progress.log(
                f"{pr_id}: verifier examined {len(findings)} candidate(s) "
                f"and verified none (all likely hallucinations)."
            )
        return []

    # Process valid verdicts: collect any with verified=True.
    verified_count = 0
    for v in verdicts:
        if not isinstance(v, dict):
            continue

        f = by_id.get(str(v.get("id")))
        if f is None:
            continue  # ID not in findings (data mismatch); skip.

        if not v.get("verified", False):
            continue  # Not verified; skip.

        verified_count += 1

        # Apply verifier's refined comment/severity if provided.
        if v.get("comment"):
            f.comment = str(v["comment"]).strip()
        try:
            f.severity = Severity(
                str(v.get("severity", f.severity.value)).capitalize()
            )
        except ValueError:
            pass  # Invalid severity; keep original.

        f.verified = True
        f.verifier_note = str(v.get("note", ""))
        out.append(f)

    # Audit log: if verdicts list was valid but all marked unverified.
    if verified_count == 0 and verdicts:
        progress.log(
            f"{pr_id}: verifier examined {len(verdicts)} candidate(s); "
            f"0 verified (all hallucinations or contextually invalid)."
        )

    return out


async def _verify_findings_agentic(
    pr: PullRequest, findings: list[Finding], transcript_dir: Path | None = None
) -> list[Finding]:
    """Verify findings by letting the model read the actual codebase with file tools.

    Used when pr.codebase_path is set. The verifier can use Read, Glob, Grep, LS
    to explore the actual source code and verify each finding's existence.

    Args:
        pr: PR with codebase_path set.
        findings: Candidate findings to verify.
        transcript_dir: Optional transcript directory.

    Returns:
        Verified findings with re-ID'd (v1, v2, ...).
    """
    model_label = settings.verifier_model.split("-")[1].capitalize()
    progress.log(
        f"{pr.id}: verifying {len(findings)} candidate(s) [agentic/{model_label}]..."
    )
    abs_path = resolve_codebase_path(pr.codebase_path)
    prompt = (
        f"You are verifying code review findings about the codebase at: `{abs_path}`\n\n"
        f"Use Read, Glob, and Grep tools to inspect the actual code for each finding.\n\n"
        f"Candidate findings:\n```json\n{_candidates_block(findings)}\n```\n\n"
        f"Verify each finding against the real code. Keep the id field unchanged."
    )
    tpath = transcript_dir / f"{pr.id}__verifier.jsonl" if transcript_dir else None
    system = loader.get("verifier.md") or VERIFIER_SYSTEM
    try:
        raw = await complete_agentic_json(
            prompt,
            model=settings.verifier_model,
            system=system,
            transcript_path=tpath,
            json_schema=VERIFIER_JSON_SCHEMA,
        )
    except Exception as exc:

        progress.log(f"{pr.id}: verifier JSON parse failed ({type(exc).__name__}: {str(exc)[:100]})")
        # Fallback to high-confidence candidates when verifier fails entirely
        high_conf_threshold = 0.75
        kept = [f for f in findings if f.confidence >= high_conf_threshold]
        progress.log(
            f"{pr.id}: emergency fallback — kept {len(kept)}/{len(findings)} candidates "
            f"with confidence ≥{high_conf_threshold} (verifier unavailable)"
        )
        return kept

    verdicts = raw.get("verified_findings", []) if isinstance(raw, dict) else []

    # Diagnostic logging: show what the verifier returned.
    if isinstance(raw, dict):
        progress.log(
            f"{pr.id}: verifier returned dict with keys={list(raw.keys())}, "
            f"verified_findings={len(verdicts)} verdicts"
        )
    else:
        progress.log(
            f"{pr.id}: verifier returned {type(raw).__name__} instead of dict; "
            f"verdicts extracted as {len(verdicts)}"
        )

    out = _apply_verdicts(findings, verdicts)

    # Final sanity check: warn if we're returning 0 findings despite having candidates.
    if not out and len(findings) > 0:
        progress.log(
            f"WARNING {pr.id}: verifier produced 0 confirmed findings from {len(findings)} candidates. "
            f"Check: (1) all candidates had confidence < 0.7, (2) verifier marked all as verified=false, "
            f"or (3) extraction/parsing failed. See transcript for details."
        )

    for i, f in enumerate(out, start=1):
        f.id = f"v{i}"
    progress.log(f"{pr.id}: verified -> {len(out)} confirmed finding(s)")
    return out
