# Security (demo)

How we handle security in `src/js-codebase/`, for anyone changing transport, gateway, or domain code. Read the [code guidelines](../../.github/code-guidelines.md) first. Rule IDs refer to [team standards](team-standards.md). This page does not claim that existing code already complies.

## Configuration and secrets

- Load configuration in one validated place in `composition/`. Other code does not read `process.env` directly.
- Fail at startup on invalid configuration. The error names the bad setting but never prints its value.
- Never put secrets or raw bodies in logs, traces, metrics, or error text. This includes tokens, auth headers, cookies, and connection strings. Log only fields you select (COMP-01).
- Run every service as a non-root user

## Telemetry

- Validate a caller-supplied correlation ID before using it, and replace it if it is invalid. Carry it on every request log line (OBS-01).
- Metric labels are route templates or small fixed sets, never IDs or messages (OBS-03).

## Data access

- Where data is protected by user or tenant authorization, bind every read, write, and cache key to the verified principal. An ID from a query string or header is not verified (COMP-02, SCAL-03).

## Outbound calls

- Use HTTPS to remote services. Never disable certificate checks, not even in tests against shared environments.
- Give every call a deadline that aborts the local request. Retries are limited, backed off, and never repeat a non-idempotent effect (SCAL-02).
- Pass an upstream "not allowed" response on as a failure. Never turn it into a success (OBS-02).

## Inbound requests

- Enforce size and concurrency limits. Reject excess with a clear error code; never truncate (SCAL-01).
- Keep health and telemetry endpoints inside the service network unless a reviewed change exposes them.

**Sources:** [Azure security principles](https://learn.microsoft.com/en-us/azure/well-architected/security/principles), [Azure Key Vault secrets](https://learn.microsoft.com/en-us/azure/key-vault/secrets/secure-secrets), and [OWASP ASVS](https://asvs.owasp.org/).
