# ADR 0002: Deprecate domain models as HTTP contracts

**Date:** 2026-10-19

**Status:** Accepted

**Scope:** Product HTTP traffic in `src/js-codebase/`. Paths in this ADR are relative to that directory.

**Tags:** product, contracts, deprecation

---

### Context

The origin exposes the product through `GET /products/sku-demo`. It previously returned `domain/product.ts` directly, coupling the HTTP response shape to an internal model. A future domain-only field could then silently become part of the response, while a change made for one internal use could break consumers.

TypeScript types do not validate JSON received over HTTP at runtime. The client needs to validate the response shape before treating it as a `Product`; the origin also needs an explicit mapping so internal model changes do not accidentally alter the wire format.

This follows the API design practice of keeping an API contract independent from internal implementation details. See [Azure's API design best practices](https://learn.microsoft.com/en-us/azure/architecture/best-practices/api-design).

### Decision

`domain/product.ts` is not the HTTP contract. Product HTTP traffic uses `contracts/product.ts` (`ProductResponse`), with explicit mapping and runtime validation in `transport/`.

Direct serialization of domain objects is deprecated. Keep the existing JSON fields and meanings unchanged.

### Consequences

- Product HTTP shape changes are made in `contracts/product.ts` and tested at both transport boundaries.
- Internal domain changes do not change the wire response unless the contract is deliberately updated.
- The product contract is shared source code, not a generated OpenAPI or AsyncAPI document.