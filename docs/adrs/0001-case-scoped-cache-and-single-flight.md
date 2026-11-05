# ADR 0001: Scope cache and single-flight per case

**Date:** 2026-10-19

**Status:** Accepted

**Scope:** `src/js-codebase/` Redis product cache and in-flight coordination for each case.

**Tags:** cache, concurrency

---

### Context

The demo compares request-local and shared in-flight coordination. Redis cache data is shared across requests, while each experiment is isolated by `caseId`.

### Decision

- Prefix every Redis product-cache key with its `caseId`.
- In `request` mode, create a coordinator for each request.
- In `shared` mode, reuse one coordinator for the case.
- Keep Redis caching independent of the selected coordinator scope.

### Consequences

Cases cannot reuse one another's cached values. Changing coordinator scope changes only request coalescing, not cache identity or lifetime.