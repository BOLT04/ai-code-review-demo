# Code Guidelines

These guidelines apply when writing or reviewing code under `src/js-codebase/`. All paths below are relative to that directory. Cite the relevant rule in PR comments when necessary.

## 1. Error Handling

- Modules in `domain/` and `transport/` throw or return rejected promises. They do not call `process.exit` and do not swallow errors. Only server entry points decide how the process exits.
- Validate inputs at the boundary: HTTP handlers (`api.js`, `gateway/`, and the servers in `transport/`) and exported functions in `contracts/`. Do not re-validate the same input deep inside `domain/`.
- Check error types with `instanceof` or a documented error `code`. Match on `err.message` only when a third-party API offers no documented type or code.
- Every promise is awaited, returned, or explicitly handled.

## 2. Consistency with the Codebase

- Add a third-party dependency only when existing code and the standard library cannot reasonably cover the need. Explain why in the PR.
- Follow existing patterns and reuse existing utilities, such as the shared cache and single-flight helpers in `domain/`, before writing new ones.
- Log messages are static strings. Put dynamic values in structured fields, for example, `logger.info({ productId }, 'product fetched')`.
- Every log line written while handling a request carries the request's correlation ID, propagated through helpers, retries, and fan-out calls.

## 3. Code comments

Prefer clear names, types, named constants, and small functions over comments. Add a comment only when it explains why something is done, or behavior that is not obvious to a reader familiar with the codebase (for example, a non-obvious performance optimization). Do not restate what the code does.

- Write comments as full sentences that start with a capital letter and end with punctuation. `TODO` markers are the exception.
