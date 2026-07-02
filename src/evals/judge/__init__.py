"""LLM-as-a-judge: match reviewer findings to golden comments (Martian-style)."""

from .judge import judge_pr

__all__ = ["judge_pr"]
