"""Reviewer orchestrator: find (parallel) -> dedup -> verify -> final review.

Modes
-----
full   (default) — three parallel specialists → dedup → adversarial verifier
simple           — single comprehensive agentic pass, no specialists or verifier
"""

from __future__ import annotations

import json
from pathlib import Path

from ..agent_client import FINDINGS_JSON_SCHEMA, complete_agentic_json
from ..config import settings
from ..models import Category, Finding, PullRequest, Severity
from .. import progress
from .aggregator import dedup_findings
from .prompts import (
    resolve_codebase_path,
    _AGENTIC_FINDING_SCHEMA,
)
from .specialists import run_specialists
from .verifier import verify_findings

_SIMPLE_SYSTEM = (
    "You are a senior software engineer doing a comprehensive code review. "
    "You look for ALL categories of issues: correctness bugs, off-by-one errors, "
    "null/None dereferences, unhandled exceptions, really analyze and find bugs; security issues including injection, hardcoded "
    "secrets, missing authentication, unsafe deserialization, XSS, CSRF; and "
    "performance issues including N+1 queries, blocking async calls, missing indexes, "
    "inefficient algorithms, and unnecessary full-table scans.\n"
    + _AGENTIC_FINDING_SCHEMA
)


def _simple_prompt(abs_codebase_path: str) -> str:
    return (
        f"Review the codebase at: `{abs_codebase_path}`\n\n"
        "Find ALL bugs, security vulnerabilities, and performance issues across the "
        "entire codebase — do not limit yourself to any single category.\n\n"
        "Steps:\n"
        "1. Run Glob to discover all source files\n"
        "2. Read each file thoroughly\n"
        "3. Grep for suspicious patterns (hardcoded values, raw SQL, unsafe calls, "
        "lock acquisitions, retry loops, etc.)\n"
        "4. Pay attention to interactions BETWEEN files\n"
        "5. Output your JSON findings"
    )


def _coerce_findings(raw: object, prefix: str = "s") -> list[Finding]:
    items: list = []
    if isinstance(raw, dict):
        items = raw.get("findings", [])
    elif isinstance(raw, list):
        items = raw
    findings: list[Finding] = []
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        try:
            sev = Severity(str(item.get("severity", "Medium")).capitalize())
        except ValueError:
            sev = Severity.MEDIUM
        try:
            cat = Category(str(item.get("category", "bug")).lower())
        except ValueError:
            cat = Category.BUG
        comment = str(item.get("comment", "")).strip()
        if not comment:
            continue
        findings.append(Finding(
            id=f"{prefix}-{i + 1}",
            file=str(item.get("file", "") or ""),
            line=item.get("line") if isinstance(item.get("line"), int) else None,
            severity=sev,
            category=cat,
            comment=comment,
            confidence=max(0.0, min(1.0, float(item.get("confidence", 0.7)))),
        ))
    return findings


def _write_findings_md(pr: PullRequest, findings: list[Finding], path: Path) -> None:
    lines = [f"# Code Review: {pr.pr_title or pr.id}\n"]
    if not findings:
        lines.append("_No findings confirmed._\n")
    for i, f in enumerate(findings, 1):
        loc = f"{f.file}:{f.line}" if f.line else (f.file or "?")
        lines.append(f"## Finding {i} — {f.severity.value} [{f.category.value}]")
        lines.append(f"**Location:** `{loc}`\n")
        lines.append(f.comment)
        lines.append("\n---\n")
    path.write_text("\n".join(lines), encoding="utf-8")


async def _review_simple(
    pr: PullRequest, *, transcript_dir: Path | None = None
) -> list[Finding]:
    """Single comprehensive agentic pass — no specialists, no verifier."""
    if not pr.codebase_path:
        progress.log(f"{pr.id}: simple mode requires codebase_path; skipping")
        return []

    abs_path = resolve_codebase_path(pr.codebase_path)
    tpath = (
        transcript_dir / f"{pr.id}__simple_reviewer.jsonl"
        if transcript_dir else None
    )
    model_label = settings.specialist_model.split("-")[1].capitalize()
    progress.log(f"{pr.id}: simple mode — single pass [{model_label}]...")

    try:
        raw = await complete_agentic_json(
            _simple_prompt(str(abs_path)),
            model=settings.specialist_model,
            system=_SIMPLE_SYSTEM,
            transcript_path=tpath,
            json_schema=FINDINGS_JSON_SCHEMA,
        )
    except Exception as exc:
        progress.log(f"{pr.id}: simple reviewer FAILED ({exc!s:.80})")
        return []

    findings = _coerce_findings(raw, prefix="s")
    progress.log(f"{pr.id}: simple mode -> {len(findings)} finding(s)")

    if transcript_dir is not None:
        transcript_dir.mkdir(parents=True, exist_ok=True)
        _write_findings_md(pr, findings, transcript_dir / f"{pr.id}__findings_final.md")

    return findings


async def review_pull_request(
    pr: PullRequest,
    *,
    verify: bool = True,
    transcript_dir: Path | None = None,
    mode: str = "full",
) -> list[Finding]:
    """Run the code review and return findings.

    Modes:
      full   — three parallel specialists → dedup → adversarial verifier (default)
      simple — single comprehensive agentic pass, no specialists or verifier
    """
    if mode == "simple":
        return await _review_simple(pr, transcript_dir=transcript_dir)

    candidates = await run_specialists(pr, transcript_dir=transcript_dir)

    if transcript_dir is not None:
        transcript_dir.mkdir(parents=True, exist_ok=True)
        (transcript_dir / f"{pr.id}__findings_pre_dedup.json").write_text(
            json.dumps([f.model_dump() for f in candidates], indent=2), encoding="utf-8"
        )

    deduped = dedup_findings(candidates)
    progress.log(f"{pr.id}: dedup {len(candidates)} -> {len(deduped)} candidate(s)")

    if transcript_dir is not None:
        (transcript_dir / f"{pr.id}__findings_post_dedup.json").write_text(
            json.dumps([f.model_dump() for f in deduped], indent=2), encoding="utf-8"
        )

    if not verify:
        if transcript_dir is not None:
            _write_findings_md(pr, deduped, transcript_dir / f"{pr.id}__findings_final.md")
        return deduped

    final = await verify_findings(pr, deduped, transcript_dir=transcript_dir)

    if transcript_dir is not None:
        _write_findings_md(pr, final, transcript_dir / f"{pr.id}__findings_final.md")

    return final
