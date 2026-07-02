"""Agent client interface protocol for AI providers.

Defines the contract that all AI agent implementations must follow (Claude Agent SDK,
Copilot SDK, future providers, etc.). Uses Python's Protocol for structural typing —
any class implementing these methods is a valid AgentClient, no inheritance needed.

This enables:
  - Easy addition of new providers without changing evals core logic
  - Testability via mock implementations (no ABC required)
  - Future extensibility (streaming, RAG indexing, etc.)
  - Natural duck typing (if it implements the methods, it's an AgentClient)

Current implementations:
  - agent_client.py (Claude Agent SDK + local `claude -p` CLI)
  - [Future] CopilotAgentClient
  - [Future] OtherProviderClient
"""

from __future__ import annotations

from typing import Any, Protocol


class AgentClient(Protocol):
    """Structural protocol for AI agent/provider clients.

    Any class implementing these methods is a valid AgentClient. This is not an
    abstract base class — it's a type hint contract that enables type checking
    and documentation without requiring inheritance.
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
        """Single-turn completion without tools.

        Args:
            prompt: User prompt / code to review
            model: Model identifier (e.g., "claude-opus", "gpt-4", "copilot-pro")
            system: Optional system prompt (instructions, role, context)
            max_turns: Max conversation turns (typically 1 for non-agentic)
            transcript_path: Optional path to save full session transcript (JSONL, etc.)

        Returns:
            The assistant's text response, stripped of whitespace.

        Raises:
            RuntimeError: If the provider is not available or authentication fails.
            ValueError: If the model is not found or request is invalid.
        """
        ...

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
        """Multi-turn completion with tools for codebase exploration.

        The agent can use tools like Read, Glob, Grep, LS to explore a codebase
        directory and return findings.

        Args:
            prompt: System prompt + task description (tells agent which dir to explore)
            model: Model identifier
            system: Optional system prompt
            max_turns: Max multi-turn iterations (default 15 for agentic loops)
            transcript_path: Optional path to save full session transcript
            json_schema: Optional JSON schema to enforce structured output

        Returns:
            The assistant's response, which may contain JSON findings.

        Raises:
            RuntimeError: If provider is not available or agent loop fails.
            ValueError: If no schema support and agent returns invalid JSON.
        """
        ...

    async def complete_json(
        self,
        prompt: str,
        *,
        model: str,
        system: str | None = None,
        retries: int = 2,
        transcript_path: str | None = None,
    ) -> Any:
        """Like complete(), but parse reply as JSON with automatic retries.

        Useful for structured output (findings, verdicts) where the model must
        return valid JSON. Retries cover both transport errors (transient API issues)
        and parse errors (the reply is prose or malformed JSON).

        On exhaustion, if transcript was saved, scan it for any valid JSON object
        before giving up.

        Args:
            prompt: User prompt
            model: Model identifier
            system: Optional system prompt
            retries: Number of JSON parse retries
            transcript_path: Optional transcript path

        Returns:
            Parsed JSON object/list.

        Raises:
            ValueError: If JSON extraction fails after all retries.
        """
        ...

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
        """Like complete_agentic(), but parse reply as JSON with retries and fallbacks.

        Includes multi-layer fallback strategy:
        1. Try extracting JSON from returned text
        2. On parse failure, retry with explicit JSON-only instruction
        3. If retries exhausted and transcript exists, scan transcript for JSON

        Args:
            prompt: Task prompt
            model: Model identifier
            system: Optional system prompt
            max_turns: Max multi-turn iterations
            retries: JSON parse retries
            transcript_path: Optional transcript path
            json_schema: Optional JSON schema

        Returns:
            Parsed JSON object.

        Raises:
            ValueError: If JSON extraction fails after all fallbacks.
        """
        ...
