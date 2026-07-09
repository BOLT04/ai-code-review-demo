"""Multi-agent code reviewer: parallel specialists -> dedup -> verifier."""

from .reviewer import review_pull_request

__all__ = ["review_pull_request"]
