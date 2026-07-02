"""Single startup switch that wires the Claude Agent SDK to a provider.

`REVIEW_PROVIDER` chooses one of:

  claude_code   -> Local `claude -p` CLI, reusing your interactive subscription
                   login (no token, no API key). Backend = CLI subprocess.
  azure         -> Microsoft Foundry  (CLAUDE_CODE_USE_FOUNDRY=1 + ANTHROPIC_FOUNDRY_*)
  subscription  -> Claude Code token  (CLAUDE_CODE_OAUTH_TOKEN), for CI/headless.
  anthropic     -> Direct API key     (ANTHROPIC_API_KEY)

The SDK-based providers read these env vars natively; `claude_code` instead
shells out to the already-authenticated Claude Code CLI. Either way the rest of
the codebase never needs to know which provider is in use.
"""

from __future__ import annotations

import os
import shutil

from ..config import settings

VALID_PROVIDERS = ("claude_code", "azure", "subscription", "anthropic")


class ProviderError(RuntimeError):
    """Raised when the selected provider is missing required configuration."""


def _require(name: str, missing: list[str]) -> str | None:
    value = os.getenv(name)
    if not value:
        missing.append(name)
    return value


def validate_provider(provider: str | None = None) -> list[str]:
    provider = (provider or settings.provider or "claude_code").lower()
    if provider not in VALID_PROVIDERS:
        return [f"REVIEW_PROVIDER must be one of {VALID_PROVIDERS}, got {provider!r}"]

    missing: list[str] = []
    if provider == "claude_code":
        # No env vars needed -- just the CLI, already logged in to your sub.
        if not shutil.which("claude"):
            missing.append("claude (the Claude Code CLI must be on PATH)")
    elif provider == "azure":
        _require("ANTHROPIC_FOUNDRY_RESOURCE", missing)
        _require("ANTHROPIC_FOUNDRY_API_KEY", missing)
    elif provider == "subscription":
        _require("CLAUDE_CODE_OAUTH_TOKEN", missing)
    else:  # anthropic
        _require("ANTHROPIC_API_KEY", missing)
    return missing


def configure_provider(provider: str | None = None, *, strict: bool = True) -> str:
    """Set the env the Claude Agent SDK needs for `provider`.

    Returns the resolved provider name. With strict=True, raises ProviderError
    if required credentials are missing.
    """
    provider = (provider or settings.provider or "claude_code").lower()
    if provider not in VALID_PROVIDERS:
        raise ProviderError(
            f"REVIEW_PROVIDER must be one of {VALID_PROVIDERS}, got {provider!r}"
        )

    missing = validate_provider(provider)
    if missing and strict:
        raise ProviderError(
            f"Provider '{provider}' is missing required env vars: {', '.join(missing)}.\n"
            f"See docs/PROVIDERS.md and .env.example."
        )

    # Default backend is the Agent SDK; claude_code overrides it to the CLI.
    os.environ["REVIEW_BACKEND"] = "sdk"

    if provider == "claude_code":
        # Drive the local `claude -p` CLI, which authenticates with whatever
        # your interactive Claude Code session is logged into.
        os.environ["REVIEW_BACKEND"] = "cli"
        os.environ.pop("ANTHROPIC_API_KEY", None)
    elif provider == "azure":
        # Foundry has no automatic model fallback -> pin the model ids.
        os.environ["CLAUDE_CODE_USE_FOUNDRY"] = "1"
        os.environ.setdefault("ANTHROPIC_DEFAULT_OPUS_MODEL", settings.verifier_model)
        os.environ.setdefault("ANTHROPIC_DEFAULT_SONNET_MODEL", settings.specialist_model)
    elif provider == "subscription":
        # CLAUDE_CODE_OAUTH_TOKEN is read directly by the Agent SDK.
        # Make sure we don't accidentally also send an API key.
        os.environ.pop("ANTHROPIC_API_KEY", None)
    else:  # anthropic
        # ANTHROPIC_API_KEY is read directly by the Agent SDK.
        pass

    return provider
