"""Command-line entrypoint.

    evals doctor                      # validate provider/auth config (no API calls)
    evals review --pr <file.json>     # run the multi-agent reviewer on one PR
    evals eval --dataset public       # run the full benchmark + success gate
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from . import progress
from .config import settings
from .llm_providers.provider_selector import (
    ProviderError,
    VALID_PROVIDERS,
    configure_provider,
    validate_provider,
)
from .prompts import VALID_PROFILES, configure_profile
from .usage import usage

REPORTS_DIR = Path(__file__).parent / "reports"
TRANSCRIPTS_DIR = Path(__file__).parent / "transcripts"


def _print_run_stats(wall_s: float) -> None:
    """Print token/cost/timing for the run (stderr, so stdout stays clean)."""
    if usage.calls == 0:
        print(f"\n--- run stats ---  wall {wall_s:.1f}s  (no per-call usage; "
              f"non-CLI provider)", file=sys.stderr)
        return
    print("\n--- run stats ---", file=sys.stderr)
    print(f"  claude calls   : {usage.calls}", file=sys.stderr)
    print(f"  input tokens   : {usage.input_tokens:,}  "
          f"(+{usage.cache_read_tokens:,} cache read, "
          f"{usage.cache_creation_tokens:,} cache write)", file=sys.stderr)
    print(f"  output tokens  : {usage.output_tokens:,}", file=sys.stderr)
    print(f"  est. cost      : ${usage.cost_usd:.4f}  "
          f"(API-equivalent; a subscription is not billed per call)", file=sys.stderr)
    print(f"  wall time      : {wall_s:.1f}s", file=sys.stderr)


# --------------------------------------------------------------------------- #
# doctor
# --------------------------------------------------------------------------- #
def cmd_doctor(args: argparse.Namespace) -> int:
    configure_profile(args.profile)
    provider = args.provider or settings.provider
    print(f"REVIEW_PROVIDER = {provider}")
    print(f"Prompt profile   : {args.profile}")
    if provider not in VALID_PROVIDERS:
        print(f"  ERROR: must be one of {VALID_PROVIDERS}")
        return 1
    missing = validate_provider(provider)
    print(f"Specialist model : {settings.specialist_model}")
    print(f"Verifier model   : {settings.verifier_model}")
    print(f"Judge model      : {settings.judge_model}")
    if missing:
        print(f"  MISSING env: {', '.join(missing)}")
        print("  See docs/PROVIDERS.md and .env.example.")
        return 1
    print("Provider config looks OK (credentials present; not validated against the API).")
    return 0


# --------------------------------------------------------------------------- #
# review
# --------------------------------------------------------------------------- #
def cmd_review(args: argparse.Namespace) -> int:
    from .datasets import load_pr_file
    from .review_agent import review_pull_request

    configure_profile(args.profile)
    try:
        configure_provider(args.provider)
    except ProviderError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    pr = load_pr_file(args.pr)
    progress.reset()
    usage.reset()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    transcript_dir = TRANSCRIPTS_DIR / f"review-{pr.id}-{stamp}"
    transcript_dir.mkdir(parents=True, exist_ok=True)
    print(f"Reviewing {pr.id} ...", file=sys.stderr)
    t0 = time.monotonic()
    findings = asyncio.run(
        review_pull_request(
            pr, verify=not args.no_verify, transcript_dir=transcript_dir,
            mode=args.mode,
        )
    )
    _print_run_stats(time.monotonic() - t0)
    print(f"Transcripts: {transcript_dir}", file=sys.stderr)

    print(f"\n=== Review: {pr.pr_title or pr.id} ({len(findings)} findings) ===\n")
    for f in findings:
        loc = f"{f.file}:{f.line}" if f.line else (f.file or "?")
        print(f"[{f.severity.value:8}] [{f.category.value:11}] {loc}")
        print(f"    {f.comment}")
    if args.json:
        print("\n" + json.dumps([f.model_dump() for f in findings], indent=2))
    return 0


# --------------------------------------------------------------------------- #
# eval
# --------------------------------------------------------------------------- #
def cmd_eval(args: argparse.Namespace) -> int:
    from .datasets import load_dataset
    from .harness import render_markdown, run_eval

    configure_profile(args.profile)
    try:
        configure_provider(args.provider)
    except ProviderError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if args.gate_min_passing_prs is not None:
        settings.gate_min_passing_prs = args.gate_min_passing_prs
    if args.gate_max_fp is not None:
        settings.gate_max_false_positives = args.gate_max_fp
    if args.gate_f1_min_score is not None:
        settings.gate_f1_min_score = args.gate_f1_min_score
    if args.gate_f1_min_passing_prs is not None:
        settings.gate_f1_min_passing_prs = args.gate_f1_min_passing_prs

    prs = load_dataset(args.dataset)
    if hasattr(args, "filter") and args.filter:
        prs = [pr for pr in prs if args.filter in pr.id]
    if not prs:
        print(f"No PRs found in dataset '{args.dataset}'.", file=sys.stderr)
        return 1
    print(f"Evaluating {len(prs)} PR(s) from '{args.dataset}'...")

    progress.reset()
    usage.reset()
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    transcript_dir = TRANSCRIPTS_DIR / f"{args.dataset}-{stamp}"
    transcript_dir.mkdir(parents=True, exist_ok=True)
    t0 = time.monotonic()
    report = asyncio.run(
        run_eval(
            args.dataset, prs, concurrency=args.concurrency,
            transcript_dir=transcript_dir, mode=args.mode,
        )
    )
    _print_run_stats(time.monotonic() - t0)
    md = render_markdown(report)
    print("\n" + md)

    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    base = REPORTS_DIR / f"{args.dataset}-{stamp}"
    base.with_suffix(".json").write_text(
        report.model_dump_json(indent=2), encoding="utf-8"
    )
    base.with_suffix(".md").write_text(md, encoding="utf-8")
    print(f"\nWrote {base.with_suffix('.json').name} and {base.with_suffix('.md').name} "
          f"to {REPORTS_DIR}")
    print(f"Transcripts: {transcript_dir}")

    if args.export_jsonl:
        from .harness.foundry_export import build_jsonl
        jsonl_path = base.with_suffix(".jsonl")
        jsonl_path.write_text(build_jsonl(report), encoding="utf-8")
        print(f"\nWrote {jsonl_path.name} to {REPORTS_DIR}")
        print("Import this file in: Azure AI Foundry portal → Evaluations → New evaluation → Upload dataset")

    if args.export_foundry:
        from .harness.foundry_export import export_to_foundry
        try:
            result = export_to_foundry(
                report,
                endpoint=os.environ.get("AZURE_AI_PROJECT_ENDPOINT"),
                run_name=args.foundry_run_name,
            )
            print(
                f"\nFoundry export: eval_id={result['eval_id']} "
                f"run_id={result['run_id']} status={result['status']}"
            )
            print("View results in the Azure AI Foundry portal -> Evaluations.")
        except Exception as exc:
            print(f"\nFoundry export FAILED: {exc}", file=sys.stderr)

    gate_passed = bool(report.gate and report.gate.passed)
    f1_gate_passed = bool(report.f1_gate and report.f1_gate.passed)
    return 0 if (gate_passed or f1_gate_passed) else 2


# --------------------------------------------------------------------------- #
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="evals", description=__doc__)
    p.add_argument(
        "--provider",
        choices=VALID_PROVIDERS,
        help="Override REVIEW_PROVIDER (claude_code | azure | subscription | anthropic).",
    )
    p.add_argument(
        "--profile",
        choices=VALID_PROFILES,
        default="default",
        help=(
            "Prompt profile: 'default' uses built-in prompts (original behaviour); "
            "'public' uses prompts/public/ markdown files; "
            "'ccp' uses prompts/private/ (falls back to public/). "
            "Default: default."
        ),
    )
    sub = p.add_subparsers(dest="command", required=True)

    d = sub.add_parser("doctor", help="Validate provider/auth config (no API calls).")
    d.set_defaults(func=cmd_doctor)

    r = sub.add_parser("review", help="Run the multi-agent reviewer on one PR file.")
    r.add_argument("--pr", required=True, help="Path to a PR JSON file.")
    r.add_argument("--no-verify", action="store_true", help="Skip the verifier pass.")
    r.add_argument("--json", action="store_true", help="Also print findings as JSON.")
    r.add_argument(
        "--mode",
        choices=["full", "simple"],
        default="full",
        help=(
            "Review mode: 'full' runs three parallel specialists + dedup + verifier "
            "(default); 'simple' runs a single comprehensive agentic pass with no "
            "specialists or verifier — useful as a baseline comparison."
        ),
    )
    r.set_defaults(func=cmd_review)

    e = sub.add_parser("eval", help="Run the benchmark over a dataset.")
    e.add_argument("--dataset", default="public", help="Dataset name or path (default: public).")
    e.add_argument("--filter", default=None, help="Only run PRs whose id contains this string (e.g. 'dotnet', 'django').")
    e.add_argument("--concurrency", type=int, default=2, help="PRs reviewed in parallel.")
    e.add_argument(
        "--mode",
        choices=["full", "simple"],
        default="full",
        help=(
            "Review mode: 'full' runs three parallel specialists + dedup + verifier "
            "(default); 'simple' runs a single comprehensive agentic pass — useful "
            "as a baseline to compare against the full multi-agent pipeline."
        ),
    )
    e.add_argument(
        "--gate-min-passing-prs",
        type=int,
        default=None,
        dest="gate_min_passing_prs",
        help="Override GATE_MIN_PASSING_PRS for this run.",
    )
    e.add_argument(
        "--gate-max-fp",
        type=int,
        default=None,
        dest="gate_max_fp",
        help="Override GATE_MAX_FALSE_POSITIVES for this run.",
    )
    e.add_argument(
        "--gate-f1-min-score",
        type=float,
        default=None,
        dest="gate_f1_min_score",
        help="Override GATE_F1_MIN_SCORE for this run.",
    )
    e.add_argument(
        "--gate-f1-min-passing-prs",
        type=int,
        default=None,
        dest="gate_f1_min_passing_prs",
        help="Override GATE_F1_MIN_PASSING_PRS for this run.",
    )
    e.add_argument(
        "--export-jsonl",
        action="store_true",
        default=False,
        dest="export_jsonl",
        help="Write a .jsonl file alongside the report for manual import into Azure AI Foundry.",
    )
    e.add_argument(
        "--export-foundry",
        action="store_true",
        default=False,
        dest="export_foundry",
        help="Upload results to Azure AI Foundry after the eval run. "
             "Requires AZURE_AI_PROJECT_ENDPOINT env var.",
    )
    e.add_argument(
        "--foundry-run-name",
        default=None,
        dest="foundry_run_name",
        help="Name for the Foundry evaluation run (default: auto-generated).",
    )
    e.set_defaults(func=cmd_eval)

    return p


def _force_utf8_io() -> None:
    """Model output contains unicode (en-dashes, quotes, arrows). A cp1252
    Windows console would raise UnicodeEncodeError on print(); reconfigure to
    UTF-8 with replacement so the CLI never crashes on output."""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
        except Exception:
            pass


def main(argv: list[str] | None = None) -> int:
    _force_utf8_io()
    args = build_parser().parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
