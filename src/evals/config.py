"""Central configuration, read from the environment (.env supported)."""

from __future__ import annotations

import os
from dataclasses import dataclass

try:  # optional: load .env if python-dotenv is installed
    from dotenv import load_dotenv

    load_dotenv()
except Exception:  # pragma: no cover - dotenv is optional at runtime
    pass


@dataclass
class Settings:
    provider: str = os.getenv("REVIEW_PROVIDER", "claude_code")

    specialist_model: str = os.getenv("REVIEW_SPECIALIST_MODEL", "claude-sonnet-4-6")
    verifier_model: str = os.getenv("REVIEW_VERIFIER_MODEL", "claude-opus-4-8")
    judge_model: str = os.getenv("JUDGE_MODEL", "claude-opus-4-8")

    gate_min_recall: float = float(os.getenv("GATE_MIN_RECALL", "0.80"))
    gate_min_passing_prs: int = int(os.getenv("GATE_MIN_PASSING_PRS", "2"))
    gate_max_false_positives: int = int(os.getenv("GATE_MAX_FALSE_POSITIVES", "2"))
    gate_f1_min_score: float = float(os.getenv("GATE_F1_MIN_SCORE", "0.70"))
    gate_f1_min_passing_prs: int = int(os.getenv("GATE_F1_MIN_PASSING_PRS", "2"))

    def reload(self) -> "Settings":
        """Re-read env (after the provider layer mutates it)."""
        return Settings()


settings = Settings()
