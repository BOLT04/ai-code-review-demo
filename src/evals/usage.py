"""Accumulates token / cost / timing across every Claude call in a run.

The `claude -p --output-format json` backend reports per-call `total_cost_usd`,
token counts, and durations; `agent_client._complete_cli` feeds them here. The
CLI prints a summary at the end of `review` / `eval`.

Caveats:
- Only the CLI backend (`REVIEW_PROVIDER=claude_code`) records usage; the Agent
  SDK backends leave these at zero.
- `cost_usd` is the API-equivalent cost Claude Code computes. On a Pro/Max
  subscription you are NOT billed per call -- treat it as a relative gauge.
- `api_ms` is summed per call; specialists run in parallel, so it overcounts
  wall-clock. The CLI measures and reports true wall time separately.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass
class Usage:
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_creation_tokens: int = 0
    cost_usd: float = 0.0
    api_ms: int = 0

    def record(
        self,
        *,
        input_tokens: object = 0,
        output_tokens: object = 0,
        cache_read: object = 0,
        cache_creation: object = 0,
        cost_usd: object = 0.0,
        api_ms: object = 0,
    ) -> None:
        self.calls += 1
        self.input_tokens += int(input_tokens or 0)
        self.output_tokens += int(output_tokens or 0)
        self.cache_read_tokens += int(cache_read or 0)
        self.cache_creation_tokens += int(cache_creation or 0)
        self.cost_usd += float(cost_usd or 0.0)
        self.api_ms += int(api_ms or 0)

    def reset(self) -> None:
        self.calls = 0
        self.input_tokens = 0
        self.output_tokens = 0
        self.cache_read_tokens = 0
        self.cache_creation_tokens = 0
        self.cost_usd = 0.0
        self.api_ms = 0


# Module-level singleton; the whole process shares one accumulator.
usage = Usage()
