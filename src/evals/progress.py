"""Lightweight progress logging to stderr.

Stages in the reviewer/judge/harness call `progress.log(...)` so a run shows
motion instead of sitting silent. Goes to stderr, so it never pollutes stdout
(e.g. `review --json`). Call `reset()` at the start of a command to zero the
elapsed-time clock; `enable(False)` to silence it.
"""

from __future__ import annotations

import sys
import time

_t0 = time.monotonic()
_enabled = True


def reset() -> None:
    global _t0
    _t0 = time.monotonic()


def enable(on: bool) -> None:
    global _enabled
    _enabled = on


def log(msg: str) -> None:
    if not _enabled:
        return
    elapsed = time.monotonic() - _t0
    print(f"[+{elapsed:6.1f}s] {msg}", file=sys.stderr, flush=True)
