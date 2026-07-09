"""Async wrapper over the Claude Agent SDK with AgentClient protocol implementation.

Two execution modes:

  complete()          — pure single-turn completion, no tools, diff supplied in
                        the prompt. Used by the diff-based reviewer pipeline.

  complete_agentic()  — multi-turn with Read/Glob/Grep/LS tools. Used by the
                        codebase reviewer pipeline (no diff; the agent explores
                        the target directory itself).

The Agent SDK reads provider credentials from the environment (set by
`evals.llm_providers.provider_selector.configure_provider`), so this layer never knows whether it is
talking to Azure/Foundry, a subscription token, or a direct API key.

ClaudeAgentClient class implements the AgentClient protocol (evals.llm_providers.base),
enabling type-safe dependency injection. Module-level functions provide backward
compatibility with existing code by delegating to a default instance.

Future: This pattern enables adding CopilotAgentClient (implementing the same
AgentClient protocol) for Copilot SDK or other providers.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
from pathlib import Path
from typing import Any

from .llm_providers.base import AgentClient

# claude_agent_sdk is imported lazily inside complete() so that `--help`,
# config validation, and dataset tooling work even if the SDK isn't installed.


# ─────────────────────────────────────────────────────────────────────────────
# ClaudeAgentClient: Implementation of AgentClient Protocol
# ─────────────────────────────────────────────────────────────────────────────


class ClaudeAgentClient:
    """Concrete implementation of the AgentClient protocol.

    Provides single-turn and multi-turn completions via either:
    1. Local `claude -p` CLI (subscription authentication)
    2. Claude Agent SDK (API key, Foundry, Azure, subscription token)

    The backend is determined by the REVIEW_BACKEND environment variable
    (set by evals.llm_providers.provider_selector.configure_provider).

    Methods automatically satisfy the AgentClient protocol through structural
    typing (Protocol), enabling type-safe dependency injection without inheritance.
    """

    async def complete(
        self,
        prompt: str,
        *,
        model: str,
        system: str | None = None,
        max_turns: int = 1,
        transcript_path: str | None = None,
    ) -> str:
        """Single-turn completion without tools. See module-level complete()."""
        if os.getenv("REVIEW_BACKEND") == "cli":
            tp = Path(transcript_path) if transcript_path else None
            return await _complete_cli(prompt, model=model, system=system, transcript_path=tp)
        try:
            from claude_agent_sdk import (  # type: ignore
                AssistantMessage,
                ClaudeAgentOptions,
                ResultMessage,
                TextBlock,
                query,
            )
        except Exception as exc:  # pragma: no cover - surfaced to the user clearly
            raise RuntimeError(
                "claude-agent-sdk is not installed. Run `pip install -e .` "
                "(and ensure the Claude Code CLI / provider auth is configured; "
                "see docs/PROVIDERS.md)."
            ) from exc

        options = ClaudeAgentOptions(
            model=model,
            system_prompt=system,
            allowed_tools=[],     # pure completion: no file/bash tools
            max_turns=max_turns,
        )

        chunks: list[str] = []
        async for message in query(prompt=prompt, options=options):
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        chunks.append(block.text)
            elif isinstance(message, ResultMessage):
                # Some SDK versions surface the final text only on the result.
                result_text = getattr(message, "result", None)
                if result_text and not chunks:
                    chunks.append(str(result_text))
        return "".join(chunks).strip()

    async def complete_agentic(
        self,
        prompt: str,
        *,
        model: str,
        system: str | None = None,
        max_turns: int = 15,
        transcript_path: str | None = None,
        json_schema: dict | None = None,
    ) -> str:
        """Multi-turn with tools. See module-level complete_agentic()."""
        if os.getenv("REVIEW_BACKEND") == "cli":
            tp = Path(transcript_path) if transcript_path else None
            return await _complete_cli_agentic(
                prompt, model=model, system=system, transcript_path=tp, json_schema=json_schema
            )
        try:
            from claude_agent_sdk import (  # type: ignore
                AssistantMessage,
                ClaudeAgentOptions,
                ResultMessage,
                TextBlock,
                query,
            )
        except Exception as exc:  # pragma: no cover
            raise RuntimeError(
                "claude-agent-sdk is not installed. Run `pip install -e .`."
            ) from exc

        options = ClaudeAgentOptions(
            model=model,
            system_prompt=system,
            allowed_tools=["Read", "Glob", "Grep", "LS"],
            max_turns=max_turns,
        )

        chunks: list[str] = []
        async for message in query(prompt=prompt, options=options):
            if isinstance(message, AssistantMessage):
                for block in message.content:
                    if isinstance(block, TextBlock):
                        chunks.append(block.text)
            elif isinstance(message, ResultMessage):
                result_text = getattr(message, "result", None)
                if result_text and not chunks:
                    chunks.append(str(result_text))
        return "".join(chunks).strip()

    async def complete_json(
        self,
        prompt: str,
        *,
        model: str,
        system: str | None = None,
        retries: int = 2,
        transcript_path: str | None = None,
    ) -> Any:
        """Parse JSON from single-turn completion. See module-level complete_json()."""
        last_err: Exception | None = None
        attempt_prompt = prompt

        for _ in range(retries + 1):
            try:
                text = await self.complete(
                    attempt_prompt,
                    model=model,
                    system=system,
                    transcript_path=transcript_path,
                )
                return _extract_json(text)
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                attempt_prompt = (
                    prompt
                    + "\n\nIMPORTANT: Respond with VALID JSON ONLY. No prose, no "
                    "markdown fences, no commentary."
                )

        # Fallback: if transcript was saved, scan it for valid JSON object.
        if transcript_path and Path(transcript_path).exists():
            extracted = _extract_json_from_transcript(transcript_path)
            if extracted is not None:
                return extracted

        raise ValueError(f"Model did not return parseable JSON: {last_err}")

    async def complete_agentic_json(
        self,
        prompt: str,
        *,
        model: str,
        system: str | None = None,
        max_turns: int = 15,
        retries: int = 1,
        transcript_path: str | None = None,
        json_schema: dict | None = None,
    ) -> Any:
        """Parse JSON from multi-turn completion. See module-level complete_agentic_json()."""
        last_err: Exception | None = None
        attempt_prompt = prompt

        for attempt in range(retries + 1):
            attempt_transcript_path = transcript_path
            if transcript_path and attempt > 0:
                p = Path(transcript_path)
                attempt_transcript_path = p.parent / f"{p.name}.retry{attempt}"

            try:
                text = await self.complete_agentic(
                    attempt_prompt,
                    model=model,
                    system=system,
                    max_turns=max_turns,
                    transcript_path=attempt_transcript_path,
                    json_schema=json_schema,
                )
                return _extract_json(text)
            except Exception as exc:  # noqa: BLE001
                last_err = exc
                attempt_prompt = (
                    prompt
                    + "\n\nIMPORTANT: After your investigation, output VALID JSON ONLY "
                    "matching the required schema. No prose after the JSON."
                )

        # Fallback 1: if transcript was saved, scan it for valid JSON objects.
        if transcript_path and Path(transcript_path).exists():
            extracted = _extract_json_from_transcript(transcript_path)
            if extracted is not None:
                return extracted

        # Fallback 2: Check all retry transcripts for JSON.
        if transcript_path:
            for attempt in range(1, retries + 1):
                p = Path(transcript_path)
                retry_path = p.parent / f"{p.name}.retry{attempt}"
                if retry_path.exists():
                    extracted = _extract_json_from_transcript(str(retry_path))
                    if extracted is not None:
                        return extracted

        raise ValueError(f"Model did not return parseable JSON: {last_err}")


# ─────────────────────────────────────────────────────────────────────────────
# Module-Level API: Backward-Compatible Functions (delegating to default instance)
# ─────────────────────────────────────────────────────────────────────────────

_default_client = ClaudeAgentClient()


async def complete(
    prompt: str,
    *,
    model: str,
    system: str | None = None,
    max_turns: int = 1,
    transcript_path: Path | None = None,
) -> str:
    """Run a single-turn, tool-free completion and return the concatenated text.

    Backend is chosen by the REVIEW_BACKEND env var (set by
    `providers.configure_provider`): "cli" shells out to the local `claude -p`
    (reusing your subscription login); anything else uses the Claude Agent SDK.
    """
    tp = transcript_path.as_posix() if transcript_path else None
    return await _default_client.complete(prompt, model=model, system=system, transcript_path=tp)


async def _complete_cli(
    prompt: str,
    *,
    model: str,
    system: str | None = None,
    transcript_path: Path | None = None,
) -> str:
    """Single completion via the local `claude -p` CLI (subscription login).

    Uses stream-json + verbose to capture the full transcript (tool calls,
    thinking traces, assistant turns). Raw JSONL is saved to transcript_path
    when provided, giving full session replay for eval debugging.
    """
    exe = shutil.which("claude")
    if not exe:
        raise RuntimeError(
            "REVIEW_PROVIDER=claude_code needs the Claude Code CLI ('claude') on "
            "PATH, logged in to your subscription. See docs/PROVIDERS.md."
        )
    args = [exe, "-p", "--model", model, "--output-format", "stream-json", "--verbose"]
    if system:
        args += ["--system-prompt", system]

    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate(prompt.encode("utf-8"))
    if proc.returncode != 0:
        detail = err.decode("utf-8", "replace").strip()[:800]
        raise RuntimeError(
            f"`claude -p` failed (exit {proc.returncode}). "
            f"Are you logged in (`claude` then /login)?\n{detail}"
        )

    raw = out.decode("utf-8", "replace")
    if transcript_path is not None:
        transcript_path.parent.mkdir(parents=True, exist_ok=True)
        transcript_path.write_text(raw, encoding="utf-8")

    return _parse_stream_json(raw)


async def complete_agentic(
    prompt: str,
    *,
    model: str,
    system: str | None = None,
    max_turns: int = 15,
    transcript_path: Path | None = None,
    json_schema: dict | None = None,
) -> str:
    """Multi-turn completion with Read/Glob/Grep/LS tools for codebase review.

    The agent receives a prompt that tells it to explore a directory, then uses
    file tools to read and search the codebase, and finally returns JSON findings.
    Pass json_schema to enforce structured output at the CLI level (--json-schema).
    """
    tp = transcript_path.as_posix() if transcript_path else None
    return await _default_client.complete_agentic(
        prompt, model=model, system=system, max_turns=max_turns,
        transcript_path=tp, json_schema=json_schema,
    )


async def _complete_cli_agentic(
    prompt: str,
    *,
    model: str,
    system: str | None = None,
    max_turns: int = 15,
    transcript_path: Path | None = None,
    json_schema: dict | None = None,
) -> str:
    """Agentic completion via the local `claude -p` CLI with file tools enabled."""
    exe = shutil.which("claude")
    if not exe:
        raise RuntimeError(
            "REVIEW_PROVIDER=claude_code needs the Claude Code CLI ('claude') on "
            "PATH, logged in to your subscription. See docs/PROVIDERS.md."
        )
    args = [
        exe, "-p", "--model", model, "--output-format", "stream-json", "--verbose",
        "--allowedTools", "Read,Glob,Grep,LS",
        "--max-turns", str(max_turns),
    ]
    if system:
        args += ["--system-prompt", system]
    if json_schema is not None:
        args += ["--json-schema", json.dumps(json_schema, separators=(",", ":"))]

    proc = await asyncio.create_subprocess_exec(
        *args,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    out, err = await proc.communicate(prompt.encode("utf-8"))
    if proc.returncode != 0:
        detail = err.decode("utf-8", "replace").strip()[:800]
        raise RuntimeError(
            f"`claude -p` agentic call failed (exit {proc.returncode}).\n{detail}"
        )

    raw = out.decode("utf-8", "replace")
    if transcript_path is not None:
        transcript_path.parent.mkdir(parents=True, exist_ok=True)
        transcript_path.write_text(raw, encoding="utf-8")

    return _parse_stream_json(raw)


async def complete_agentic_json(
    prompt: str,
    *,
    model: str,
    system: str | None = None,
    max_turns: int = 15,
    retries: int = 1,
    transcript_path: Path | None = None,
    json_schema: dict | None = None,
) -> Any:
    """Like complete_agentic(), but parse the reply as JSON, retrying once on failure.

    Pass json_schema to enforce structured output at the CLI level (--json-schema),
    which makes JSON output a hard transport constraint rather than a prompt request.

    Includes multi-layer fallback:
    1. Try extracting from the returned text
    2. On failure, retry with explicit JSON-only instruction
    3. If retries exhausted and transcript_path exists, scan the JSONL transcript for
       any valid JSON objects that match the schema type (dict with expected keys)
    """
    tp = transcript_path.as_posix() if transcript_path else None
    return await _default_client.complete_agentic_json(
        prompt, model=model, system=system, max_turns=max_turns,
        retries=retries, transcript_path=tp, json_schema=json_schema,
    )


async def complete_json(
    prompt: str,
    *,
    model: str,
    system: str | None = None,
    retries: int = 2,
    transcript_path: Path | None = None,
) -> Any:
    """Like complete(), but parse the reply as JSON, retrying on failure.

    The Agent SDK returns free text, so we extract the first JSON object/array
    found and parse it. Retries cover BOTH failure modes:
      - a transport error (the `claude -p` call itself raising, e.g. a transient
        CLI/network hiccup or non-zero exit), and
      - a parse error (the reply is prose or malformed JSON).
    Previously the `complete()` call sat outside the try/except, so a single
    transient transport error propagated straight to the caller with no retry —
    which, for the judge, silently turned an infra blip into a fake 0-match
    result. Keeping the call inside the loop's try closes that gap.

    On exhaustion, if a transcript was saved, scan it for any valid JSON object
    (mirrors complete_agentic_json's salvage path) before giving up.
    """
    tp = transcript_path.as_posix() if transcript_path else None
    return await _default_client.complete_json(
        prompt, model=model, system=system, retries=retries, transcript_path=tp
    )


def _parse_stream_json(raw: str) -> str:
    """Parse a stream-json JSONL response and return the best candidate text.

    Primary source: the `result` field of the final `result` event (the
    CLI's session-end envelope).  For multi-turn agentic sessions the model
    may emit its structured JSON in an *earlier* assistant turn and then
    append a prose summary as the last turn, which is what the `result` field
    captures.  When the result text contains no JSON-like content we fall back
    to the largest assistant text block seen across all turns — that is where
    the structured output actually lives.

    Records usage/cost from the 'result' event. Falls back to returning the
    raw string if no valid result event is found (e.g. older CLI builds).
    """
    result_text = ""
    total_cost = 0.0
    api_ms = 0
    usage_data: dict = {}
    found_result = False
    # Collect all assistant text blocks so we can fall back to the best one.
    assistant_text_blocks: list[str] = []

    for line in raw.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except Exception:
            continue

        # Collect assistant text blocks from every turn.
        if event.get("type") == "assistant":
            content = event.get("message", {}).get("content", [])
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and block.get("type") == "text":
                        txt = str(block.get("text", "")).strip()
                        if txt:
                            assistant_text_blocks.append(txt)

        if event.get("type") == "result":
            found_result = True
            if event.get("is_error"):
                raise RuntimeError(
                    f"`claude -p` returned error: {str(event.get('result', ''))[:800]}"
                )
            result_text = str(event.get("result", "")).strip()
            total_cost = event.get("total_cost_usd", 0.0)
            api_ms = event.get("duration_api_ms", 0)
            usage_data = event.get("usage") or {}

    if not found_result:
        return raw.strip()

    from .usage import usage  # local import avoids any import cycle
    usage.record(
        input_tokens=usage_data.get("input_tokens", 0),
        output_tokens=usage_data.get("output_tokens", 0),
        cache_read=usage_data.get("cache_read_input_tokens", 0),
        cache_creation=usage_data.get("cache_creation_input_tokens", 0),
        cost_usd=total_cost,
        api_ms=api_ms,
    )

    # If the result text looks like it contains structured JSON, use it as-is.
    # Otherwise fall back to the largest assistant text block that contains a
    # JSON-like structure — this handles the common pattern where the model
    # outputs valid JSON mid-session then appends a prose summary as its last
    # turn (which is what the result event captures).
    result_has_json = "{" in result_text or "[" in result_text
    if not result_has_json and assistant_text_blocks:
        json_blocks = [b for b in assistant_text_blocks if "{" in b or "[" in b]
        if json_blocks:
            # Prefer the largest such block (most likely the full JSON payload).
            return max(json_blocks, key=len)

    return result_text


_FENCE_RE = re.compile(r"```(?:json)?\s*(.*?)```", re.DOTALL)

# JSON Schema passed to `claude -p --json-schema` so the CLI enforces structured
# output at the transport level rather than relying solely on prompt instructions.

# Schema for the verifier's output contract.  Using --json-schema forces the CLI
# to reject a prose summary and require the structured object, eliminating the
# "JSON mid-session, prose summary as final turn" failure mode.
VERIFIER_JSON_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "verified_findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id":       {"type": "string"},
                    "verified": {"type": "boolean"},
                    "severity": {"type": "string", "enum": ["Low", "Medium", "High", "Critical"]},
                    "comment":  {"type": "string"},
                    "note":     {"type": "string"},
                },
                "required": ["id", "verified"],
            },
        }
    },
    "required": ["verified_findings"],
}

FINDINGS_JSON_SCHEMA: dict = {
    "type": "object",
    "properties": {
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "file":       {"type": "string"},
                    "line":       {"oneOf": [{"type": "integer"}, {"type": "null"}]},
                    "severity":   {"type": "string", "enum": ["Low", "Medium", "High", "Critical"]},
                    "category":   {"type": "string", "enum": ["bug", "security", "performance"]},
                    "comment":    {"type": "string"},
                    "confidence": {"type": "number", "minimum": 0, "maximum": 1},
                },
                "required": ["file", "severity", "category", "comment", "confidence"],
            },
        }
    },
    "required": ["findings"],
}


def _extract_json_from_transcript(transcript_path: str) -> Any | None:
    """Scan a stream-json JSONL transcript for valid JSON objects.

    Multi-turn agentic sessions may emit structured JSON mid-session (in an
    assistant text block), then continue with prose or tool calls. The final
    `result` event may capture only the trailing text. This function scans the
    JSONL for all JSON objects found in assistant text blocks and returns the
    best candidate: prefer objects with "verified_findings" or "findings" keys
    (the expected output shapes for verifier and specialist), otherwise return
    the first valid dict found.

    Returns None if no suitable JSON is found.
    """
    candidates: list[Any] = []
    all_assistant_text: list[str] = []

    try:
        with open(transcript_path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    event = json.loads(line)
                except Exception:
                    continue

                # Look for assistant message events.
                if event.get("type") != "assistant":
                    continue

                content = event.get("message", {}).get("content", [])
                if not isinstance(content, list):
                    continue

                for block in content:
                    if not isinstance(block, dict) or block.get("type") != "text":
                        continue

                    text = str(block.get("text", "")).strip()
                    if not text:
                        continue

                    all_assistant_text.append(text)

                    # Try to extract JSON from this text block.
                    try:
                        obj = _extract_json(text)
                        if isinstance(obj, dict) and obj:  # non-empty dict
                            candidates.append(obj)
                    except Exception:
                        pass

    except Exception:
        pass

    if not candidates:
        return None

    # Prefer candidates with "verified_findings" (verifier output).
    for c in candidates:
        if isinstance(c, dict) and "verified_findings" in c:
            return c

    # Otherwise prefer "findings" (specialist output).
    for c in candidates:
        if isinstance(c, dict) and "findings" in c:
            return c

    # Fallback: return the largest candidate (likely the most complete JSON).
    return max(candidates, key=lambda x: len(json.dumps(x)))


def _extract_verdicts_from_reasoning(transcript_path: str, candidate_ids: set[str]) -> list[dict] | None:
    """Last-resort: scan transcript for model reasoning and extract verdicts.

    If structured JSON extraction fails entirely, parse the assistant's
    reasoning and decision statements to salvage verdict data. Looks for
    patterns like "f1: confirmed", "f2: dropped", etc. in the model's
    explanation text, and creates synthetic verdict objects for any IDs
    that were mentioned as confirmed/kept.

    This is a best-effort heuristic and may miss nuances, but prevents
    silent loss of verified findings when JSON formatting fails.

    Returns a list of verdict dicts with id, verified, and note fields,
    or None if no verdicts can be salvaged.
    """
    verdicts_found: dict[str, dict] = {}

    try:
        with open(transcript_path, encoding="utf-8") as f:
            full_text = f.read()

        # Simple heuristic: look for lines mentioning finding IDs with verdict keywords.
        # E.g.: "f1: confirmed", "f1 is real", "f2: dropped", "f2: hallucination"
        import re
        verdict_keywords_keep = {"confirmed", "verified", "real", "kept", "true", "yes", "correct"}
        verdict_keywords_drop = {"dropped", "hallucination", "false", "alarm", "false alarm", "nope", "no", "incorrect"}

        for candidate_id in candidate_ids:
            # Look for lines containing this ID
            pattern = rf"\b{re.escape(candidate_id)}\b[^\n]*\b(?:confirmed|verified|real|kept|hallucination|dropped|false alarm|nope)\b"
            matches = re.finditer(pattern, full_text, re.IGNORECASE)
            for match in matches:
                line = match.group(0).lower()
                is_confirmed = any(kw in line for kw in verdict_keywords_keep)
                is_dropped = any(kw in line for kw in verdict_keywords_drop)

                if is_confirmed or is_dropped:
                    verdicts_found[candidate_id] = {
                        "id": candidate_id,
                        "verified": is_confirmed,
                        "severity": "Medium",  # fallback; not extracted
                        "comment": "",
                        "note": f"Extracted from reasoning: {line[:100]}",
                    }
                    break  # Use first match per ID

        if verdicts_found:
            return list(verdicts_found.values())

    except Exception:
        pass

    return None


def _extract_json(text: str) -> Any:
    """Best-effort extraction of a JSON value from a model reply."""
    text = text.strip()
    # 1) fenced block
    m = _FENCE_RE.search(text)
    if m:
        text = m.group(1).strip()
    # 2) try whole string
    try:
        return json.loads(text)
    except Exception:
        pass
    # 3) first balanced {...} or [...]
    for opener, closer in (("{", "}"), ("[", "]")):
        start = text.find(opener)
        end = text.rfind(closer)
        if start != -1 and end != -1 and end > start:
            candidate = text[start : end + 1]
            return json.loads(candidate)
    raise ValueError("no JSON found in reply")
