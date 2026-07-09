"""Parallel specialist finders (bugs / security / performance)."""

from __future__ import annotations

import asyncio
from pathlib import Path

from ..agent_client import FINDINGS_JSON_SCHEMA, complete_agentic_json, complete_json
from ..config import settings
from ..models import Category, Finding, PullRequest, Severity
from .. import progress
from ..prompts import loader
from .prompts import (
    agentic_specialist_prompt,
    agentic_specialist_system,
    pr_context_block,
    resolve_codebase_path,
    specialist_system,
)

SPECIALTIES = [Category.BUG, Category.SECURITY, Category.PERFORMANCE]


def _coerce_findings(raw: object, category: Category, prefix: str) -> list[Finding]:
    findings: list[Finding] = []
    items = []
    if isinstance(raw, dict):
        items = raw.get("findings", [])
    elif isinstance(raw, list):
        items = raw
    for i, item in enumerate(items):
        if not isinstance(item, dict):
            continue
        try:
            sev = Severity(str(item.get("severity", "Medium")).capitalize())
        except ValueError:
            sev = Severity.MEDIUM
        # The specialist owns its category; trust it over a stray model value.
        findings.append(
            Finding(
                id=f"{prefix}-{i+1}",
                file=str(item.get("file", "") or ""),
                line=item.get("line") if isinstance(item.get("line"), int) else None,
                severity=sev,
                category=category,
                comment=str(item.get("comment", "")).strip(),
                confidence=_clamp(item.get("confidence", 0.5)),
            )
        )
    return [f for f in findings if f.comment]


def _clamp(v: object) -> float:
    try:
        return max(0.0, min(1.0, float(v)))
    except (TypeError, ValueError):
        return 0.5


async def _run_specialist(
    pr: PullRequest, category: Category, transcript_dir: Path | None = None
) -> list[Finding]:
    if pr.codebase_path:
        return await _run_specialist_agentic(pr, category, transcript_dir)
    prompt = (
        pr_context_block(pr)
        + f"\n\nReview the change above for {category.value} issues only."
    )
    tpath = (
        transcript_dir / f"{pr.id}__{category.value}_specialist.jsonl"
        if transcript_dir else None
    )
    try:
        system = loader.get(f"specialists/{category.value}.md") or specialist_system(category)
        raw = await complete_json(
            prompt, model=settings.specialist_model, system=system, transcript_path=tpath
        )
    except Exception as exc:
        progress.log(f"{pr.id}: {category.value} specialist FAILED ({exc!s:.80})")
        return []
    out = _coerce_findings(raw, category, prefix=category.value[:3])
    progress.log(f"{pr.id}: {category.value} specialist -> {len(out)} finding(s)")
    return out


async def _run_specialist_agentic(
    pr: PullRequest, category: Category, transcript_dir: Path | None = None
) -> list[Finding]:
    abs_path = resolve_codebase_path(pr.codebase_path)
    prompt = agentic_specialist_prompt(str(abs_path), category)
    tpath = (
        transcript_dir / f"{pr.id}__{category.value}_specialist.jsonl"
        if transcript_dir else None
    )
    try:
        system = loader.get(f"specialists/{category.value}.md") or agentic_specialist_system(category)
        raw = await complete_agentic_json(
            prompt, model=settings.specialist_model, system=system, transcript_path=tpath,
            json_schema=FINDINGS_JSON_SCHEMA,
        )
    except Exception as exc:
        progress.log(f"{pr.id}: {category.value} specialist FAILED ({exc!s:.80})")
        return []
    out = _coerce_findings(raw, category, prefix=category.value[:3])
    progress.log(f"{pr.id}: {category.value} specialist -> {len(out)} finding(s)")
    return out


async def run_specialists(pr: PullRequest, transcript_dir: Path | None = None) -> list[Finding]:
    """Fan out the three specialists IN PARALLEL and merge their findings."""
    model_label = settings.specialist_model.split("-")[1].capitalize()
    progress.log(f"{pr.id}: launching 3 specialists (bug/security/performance) [{model_label}]...")
    results = await asyncio.gather(
        *(_run_specialist(pr, c, transcript_dir) for c in SPECIALTIES), return_exceptions=True
    )
    findings: list[Finding] = []
    for res in results:
        if isinstance(res, list):
            findings.extend(res)
    return findings
