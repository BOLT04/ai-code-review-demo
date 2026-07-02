"""Shared data models for the reviewer, judge, and harness.

These pydantic models are the contract between every component:

    PullRequest  -->  Reviewer  -->  list[Finding]
    Finding + GoldenComment  -->  Judge  -->  MatchVerdict
    MatchVerdicts  -->  metrics  -->  PRMetrics / RunReport
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class Severity(str, Enum):
    LOW = "Low"
    MEDIUM = "Medium"
    HIGH = "High"
    CRITICAL = "Critical"


class Category(str, Enum):
    BUG = "bug"
    SECURITY = "security"
    PERFORMANCE = "performance"


# --------------------------------------------------------------------------- #
# Dataset models (Martian-compatible, lightly enriched)
# --------------------------------------------------------------------------- #
class GoldenComment(BaseModel):
    """A known issue a reviewer *should* catch (the ground truth)."""

    id: str
    comment: str
    severity: Severity = Severity.MEDIUM
    # `category` is our enrichment; Martian's raw golden comments omit it.
    category: Optional[Category] = None


class ChangedFile(BaseModel):
    path: str
    content: str = ""


class PullRequest(BaseModel):
    """One PR to review. Martian-compatible plus the fields the reviewer needs."""

    id: str
    repo: str = ""
    pr_title: str = ""
    url: str = ""
    language: str = ""
    diff: str = ""
    changed_files: list[ChangedFile] = Field(default_factory=list)
    golden_comments: list[GoldenComment] = Field(default_factory=list)
    # If set, the reviewer explores this directory with file tools instead of
    # reading an inlined diff. Path is relative to the repo root.
    codebase_path: str = ""


# --------------------------------------------------------------------------- #
# Reviewer output
# --------------------------------------------------------------------------- #
class Finding(BaseModel):
    """A single issue the reviewer reports about a PR."""

    id: str = ""
    file: str = ""
    line: Optional[int] = None
    severity: Severity = Severity.MEDIUM
    category: Category = Category.BUG
    comment: str
    # 0..1 confidence the specialist assigned; the verifier may revise/drop.
    confidence: float = 0.5
    # Set by the verifier stage.
    verified: bool = False
    verifier_note: str = ""


# --------------------------------------------------------------------------- #
# Judge output
# --------------------------------------------------------------------------- #
class MatchVerdict(BaseModel):
    """The judge's decision linking a finding to a golden comment (or not)."""

    golden_id: Optional[str] = None
    finding_id: Optional[str] = None
    is_match: bool = False
    # Strict-Martian: an unmatched finding is a false positive. We still record
    # the judge's read on whether it is at least a *plausible* real issue, for
    # the optional scope-aware view documented in EVAL_METHODOLOGY.md.
    finding_is_plausible: bool = False
    rationale: str = ""
    severity_match: Optional[bool] = None   # for TPs: did finding severity == golden severity?
    actionability_score: Optional[int] = None  # 1-5: how specific/actionable is the comment


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #
class PRMetrics(BaseModel):
    pr_id: str
    error: str = ""   # non-empty => judge/infra failure; metrics are NOT a quality result
    true_positives: int = 0
    false_positives: int = 0
    false_negatives: int = 0
    precision: float = 0.0
    recall: float = 0.0
    f1: float = 0.0
    n_findings: int = 0
    n_golden: int = 0
    matched_golden_ids: list[str] = Field(default_factory=list)
    unmatched_finding_ids: list[str] = Field(default_factory=list)
    plausible_false_positives: int = 0   # FPs the judge flagged as real-but-unlabeled issues
    adjusted_precision: float = 0.0      # TP / (TP + hallucinated_FP); excludes plausible FPs
    severity_accuracy: float = 0.0       # % of TPs where severity matched
    avg_actionability: float = 0.0       # mean actionability score (1-5) across all findings
    weighted_recall: float = 0.0         # severity-weighted recall (Critical=4,High=3,Med=2,Low=1)
    category_recall: dict = Field(default_factory=dict)  # {"security": 1.0, "bug": 0.7, "performance": 0.5}


class GateResult(BaseModel):
    passed: bool
    min_recall: float
    min_passing_prs: int
    max_false_positives: int
    passing_prs: int
    total_false_positives: int            # raw unmatched findings (incl. real-but-unlabeled)
    hard_false_positives: int = 0         # gated metric: FPs the judge deemed hallucinated/wrong
    plausible_false_positives: int = 0    # real issues missing from golden; excused by the gate
    reasons: list[str] = Field(default_factory=list)


class F1GateResult(BaseModel):
    passed: bool
    min_f1: float
    min_passing_prs: int
    passing_prs: int
    reasons: list[str] = Field(default_factory=list)


class RunReport(BaseModel):
    dataset: str
    judge_model: str
    specialist_model: str
    verifier_model: str
    per_pr: list[PRMetrics] = Field(default_factory=list)
    # Aggregates
    macro_precision: float = 0.0
    macro_recall: float = 0.0
    macro_f1: float = 0.0
    micro_precision: float = 0.0
    micro_recall: float = 0.0
    micro_f1: float = 0.0
    gate: Optional[GateResult] = None
    f1_gate: Optional[F1GateResult] = None
    notes: list[str] = Field(default_factory=list)
    avg_severity_accuracy: float = 0.0   # macro mean of PRMetrics.severity_accuracy
    avg_actionability: float = 0.0       # macro mean of PRMetrics.avg_actionability
    plausible_fp_total: int = 0          # sum plausible_false_positives across PRs
    avg_adjusted_precision: float = 0.0  # macro mean of adjusted_precision
    avg_weighted_recall: float = 0.0     # macro mean of weighted_recall
