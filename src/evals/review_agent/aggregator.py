"""Cross-specialist dedup with O(N) tokenization caching.

Two specialists (e.g. bug + security) can flag the same underlying issue. Left
alone, one would match a golden comment (TP) and the duplicate would match
nothing (FP), inflating false positives. Martian has an explicit dedup step for
exactly this; we mirror it before verification/scoring.

This is a cheap, deterministic, local heuristic (same file + token overlap). The
verifier provides a second, semantic dedup pass.

Performance: Previously O(N²) tokenization calls; now O(N) by caching tokens
before the similarity loop.
"""

from __future__ import annotations

import re

from ..models import Finding

_WORD_RE = re.compile(r"[a-z0-9_]+")
_STOP = {
    "the", "a", "an", "is", "are", "to", "of", "in", "on", "and", "or", "this",
    "that", "it", "with", "for", "without", "be", "can", "could", "should",
    "may", "issue", "code", "line", "value", "use", "used", "using",
}


def _tokens(text: str) -> set[str]:
    """Tokenize text into meaningful words (exclude stop words).

    Lowercases, extracts alphanumeric+underscore words, and filters common
    stop words and very short words (<3 chars).

    Args:
        text: Raw text to tokenize.

    Returns:
        Set of meaningful tokens.

    Example:
        >>> _tokens("The value is invalid") == {'invalid'}
        True
    """
    return {w for w in _WORD_RE.findall(text.lower()) if w not in _STOP and len(w) > 2}


def _similar(
    a: Finding,
    b: Finding,
    cached_tokens: dict[int, set[str]],
    threshold: float = 0.6,
) -> bool:
    """Check if two findings are similar (possible duplicates).

    Uses Jaccard similarity on token sets. Findings in different files are
    never similar. Findings with no tokens are never similar.

    Args:
        a, b: Findings to compare.
        cached_tokens: Pre-computed token cache {id(finding) → tokens set}.
        threshold: Minimum Jaccard similarity to consider findings similar (0-1).

    Returns:
        True if findings are likely duplicates.
    """
    # Different files: not similar.
    if a.file and b.file and a.file != b.file:
        return False

    # Look up pre-computed tokens (or compute on-the-fly if not cached).
    ta = cached_tokens.get(id(a)) or _tokens(a.comment)
    tb = cached_tokens.get(id(b)) or _tokens(b.comment)

    # No tokens: not similar (prevent false positives from empty comments).
    if not ta or not tb:
        return False

    # Jaccard similarity: |A ∩ B| / |A ∪ B|
    overlap = len(ta & tb) / len(ta | tb)
    return overlap >= threshold


def dedup_findings(findings: list[Finding]) -> list[Finding]:
    """Collapse near-duplicate findings, keeping the highest-confidence one.

    Operates in two phases:
      1. Tokenization (O(N)): Pre-compute token sets for all findings
      2. Deduplication (O(N²) comparisons): Keep highest-confidence from each group

    Args:
        findings: List of findings (possibly with duplicates).

    Returns:
        Deduplicated findings, re-ID'd stably for downstream reference (f1, f2, ...).

    Performance:
        O(N) tokenization + O(N²) comparisons = O(N²) overall, but with
        cached tokens to avoid redundant work.
    """
    # Phase 1: Pre-compute tokens for all findings (O(N) tokenization).
    # This eliminates the O(N²) re-tokenization that happened in the loop.
    token_cache: dict[int, set[str]] = {}
    for f in findings:
        token_cache[id(f)] = _tokens(f.comment)

    # Phase 2: Sort by confidence descending (keep highest-confidence from each group).
    ordered = sorted(findings, key=lambda f: f.confidence, reverse=True)
    kept: list[Finding] = []

    for f in ordered:
        # Check if f is similar to any already-kept finding (using cached tokens).
        is_duplicate = any(_similar(f, k, token_cache) for k in kept)
        if not is_duplicate:
            kept.append(f)

    # Re-ID stably for downstream reference and reproducibility.
    for i, f in enumerate(kept, start=1):
        f.id = f"f{i}"

    return kept
