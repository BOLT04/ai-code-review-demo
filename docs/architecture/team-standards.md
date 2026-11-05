# Team architecture standards

This is the team's engineering baseline for Scalability, Observability, and Regulatory & Compliance. It applies only to code under `src/js-codebase/`. It contains concrete rules and acceptance scenarios. [ADRs](../adrs/README.md) record significant decisions, their rationale, and explicit exceptions. [Quality goals](quality-goals.md) set priorities and accepted trade-offs; they do not add rules or waive them. These requirements are not a claim that the existing codebase already complies.

## How to apply these requirements

- Each rule below is mandatory when its applicability condition is met. Review changed behavior and its relevant execution paths, not unrelated legacy gaps.
- Shared middleware, infrastructure, and callers can satisfy a rule. Trace them before reporting missing controls; do not require duplicate instrumentation, another limiter, or another authentication check in each function.
- Cite the stable rule ID, the violating changed code, the triggering scenario, and a concrete compliant alternative. A standards violation is a finding even if no ADR covers it; cite a broken ADR only when one actually applies.
- Rule applicability is "Applicable" or "Not applicable". Category results are "Compliant", "Not compliant", or "Not assessed". Evaluate all applicable rules per category. One demonstrated violation makes the category "Not compliant", even if other rules lack evidence. Use "Compliant" only with evidence for all applicable rules. Use "Not assessed" when no rule in the category applies or the evidence is insufficient. Explain unassessed rules and evidence limitations, including within a failing category.
- Tests and code inspection can establish these scenarios. Do not claim a load test, telemetry capture, or runtime check unless it was actually performed. Do not treat the absence of a new test alone as proof of a runtime defect.

## Scalability

### SCAL-01: Bound admitted work and retained input

**Applies when:** A request, message, or job controls batch size, fan-out, concurrency, queue length, or retained input size.

**Rule:** Enforce finite limits before retaining or starting the controlled work. Use bounded concurrency and bounded queues or backpressure. Reject, paginate, stream with bounded buffering, or defer excess work through a bounded mechanism. A limit on active workers alone does not bound an unbounded pending queue. Reuse existing repository/configuration limits; this baseline sets no universal batch size or concurrency number.

**Acceptance scenario:** Submit more items/bytes than the configured limit and saturate the workers. Active and retained work stay within the documented bounds, and excess work has an explicit rejection/backpressure outcome. The change must not silently truncate accepted input.

### SCAL-02: Bound dependency attempts and their lifetime

**Applies when:** Changed code creates or configures a remote call, its deadline, or its retry policy. A shared client or wrapper with an evidenced finite deadline and retry budget satisfies this rule for its callers.

**Rule:** Remote work must have a finite deadline. On expiry, cancel the local I/O and release local resources, and propagate the deadline or cancellation to the dependency when the protocol supports it. Never use a late result after the deadline. If a client cannot be cancelled, bound the number of outstanding attempts and document that remote execution may continue. Retries must have a finite attempt/time budget, respect the caller's deadline and cancellation, and must not multiply across layers. Do not retry non-idempotent effects without an established idempotency or deduplication contract. Back off between attempts to a failing dependency instead of retrying in a tight loop.

**Acceptance scenario:** Hold the dependency open or make it fail repeatedly. The caller finishes within its configured budget, local I/O and resources are released, outstanding and total attempts stay within the combined budget, and a retried operation cannot duplicate an externally visible effect.

### SCAL-03: Bound shared-state growth and preserve isolation

**Applies when:** Changed code retains cache entries, in-flight work, or other shared state across requests/jobs.

**Rule:** Bound retained state through finite capacity with eviction/rejection or a bounded admission mechanism; TTL alone is insufficient when arrivals can grow without a practical bound. Clean up in-flight state on both success and failure. Keys must distinguish all inputs affecting results and preserve documented case/user/tenant isolation. Do not assume a shared process or add distributed coordination unless the deployment/consistency contract requires it.

**Acceptance scenario:** Exercise distinct keys beyond capacity and failed requests. Retained state remains bounded and failed work can be attempted again. Two requests with different result-affecting inputs cannot reuse the wrong result. For case-specific cache/coalescing decisions, also apply [ADR 0001](../adrs/0001-case-scoped-cache-and-single-flight.md).

## Observability

### OBS-01: Correlate work across boundaries

**Applies when:** Changed request/message/job handling initiates downstream work or emits operational events.

**Rule:** Establish a bounded, validated request/trace/job correlation identifier at the entry boundary and propagate it through relevant downstream work and operational events. Reuse an existing correlation mechanism. Do not trust an arbitrary inbound identifier or substitute a sensitive user identifier for it.

**Acceptance scenario:** Interleave two operations, including one failure. Their events and downstream calls can be attributed to the correct operation; an invalid/oversized inbound identifier is rejected or replaced safely, not copied unchecked into telemetry or outbound headers.

### OBS-02: Make operational failures diagnosable

**Applies when:** Changed code handles an unexpected failure, dependency timeout, exhausted retry budget, or failed background job.

**Rule:** Preserve or emit a structured failure event through the existing logging/tracing mechanism with operation, outcome, safe error classification, and correlation context where available. Do not swallow the failure or convert it into success-shaped output. Record it at the responsible boundary rather than duplicating the same error at every layer. Routine validation failures do not require noisy error-level logs.

**Acceptance scenario:** Inject a dependency failure or job exception. The caller/job receives the failure outcome and an operator can identify the failed operation and reason from telemetry without exposing secrets or raw payloads.

### OBS-03: Observe outcomes and duration without unbounded dimensions

**Applies when:** A change adds a service operation, job, or dependency integration, or changes the outcome, failure, duration, or telemetry behavior of an existing one. Refactoring that leaves observable behavior unchanged does not trigger this rule.

**Rule:** Preserve/provide operation identity, outcome, and elapsed duration through existing structured events, spans, or metrics. Metrics dimensions must have a bounded set of values: use route templates and bounded outcome/error classes, never raw URLs, request/trace/user/case IDs, payload values, or arbitrary exception messages as metric labels. Correlation IDs belong in appropriate logs/traces, not metric dimensions.

**Acceptance scenario:** Exercise a successful operation and a failed operation. Their outcomes and durations are observable. Sending many distinct IDs/paths does not create a new metric series per identifier/path. An existing wrapper that supplies these signals satisfies the rule; no new telemetry backend or OpenTelemetry SDK is mandated.

## Regulatory & Compliance

This category assesses the repository's documented engineering controls, not legal certification. No particular regulatory framework, data residency, retention period, or audit obligation is established here. Do not infer one from an industry name, technology choice, or the presence of user records. State that legal compliance is not assessed even when applicable engineering controls are compliant.

### COMP-01: Keep secrets and sensitive payloads out of telemetry

**Applies when:** Changed code emits logs, traces, metrics, diagnostic errors, or audit events containing request/dependency/application data.

**Rule:** Select diagnostic fields explicitly. Never emit credentials, authorization/cookie headers, access/refresh tokens, connection-string secrets, or raw request/response bodies. Redact sensitive fields before emission, not only at display time. Treat data as sensitive based on its actual content or documented classification; do not invent classifications. Sanitized error classes and the non-sensitive correlation context required above remain useful.

**Acceptance scenario:** Supply recognizable test secrets and sensitive body fields through success and failure paths. They do not appear in captured telemetry or diagnostic responses; useful operation/outcome information remains.

### COMP-02: Preserve authenticated data isolation

**Applies when:** Changed code accesses data protected by an established user/tenant authorization boundary.

**Rule:** Bind data operations and shared-cache identity to the verified principal/scope, enforcing authorization before access or reuse. Do not treat an unverified request parameter/header as authorization. Check existing middleware and data-layer controls before claiming a missing check. This does not create multi-tenancy or an authentication requirement for intentionally public data or health endpoints; demo `caseId` separation alone is not tenant authentication.

**Acceptance scenario:** With two principals/scopes, attempt to read or mutate the other's protected data and reuse its cached result. Access is denied before the data/effect is exposed; missing or forged scope cannot bypass the boundary.

### COMP-03: Preserve documented lifecycle and audit controls

**Applies when:** Changed persistence, deletion, export, or sensitive mutation paths are covered by a documented retention/deletion/audit requirement.

**Rule:** Preserve the required lifecycle and audit behavior across affected stores/caches and failure paths. Cite the requirement/ADR that establishes the obligation; do not invent retention periods, mandated storage locations, audit events, or regulations. No lifecycle obligation is established by this rule alone.

**Acceptance scenario:** Exercise the documented action and a failed/retried attempt. Data is retained/deleted/exported as required and the required audit outcome is recorded without sensitive payloads. If no applicable obligation is documented, mark this rule "Not applicable". A missing obligation is not a finding.

## Changing standards and recording exceptions

Change this document through normal team review. Keep rule IDs stable; mark retired/replaced rules explicitly and link their successors. Proposed, deprecated, or superseded rules are not active requirements.

An exception requires an Accepted, active ADR that cites the exact rule ID, affected scope, reason, and alternative controls with acceptance evidence. It waives only that explicit scope, not the whole category. An ADR does not implicitly waive a rule because it is newer or more specific, and a quality-goal priority never waives a rule. Explain unresolved conflicts as assessment limitations, not as invented precedence. Link requirements and decisions rather than copying their text into prompts.

## References

These sources informed the standards. They are background only: do not fetch them during review, and do not enforce their contents. To adopt a practice from them, add it to this document with a stable rule ID and acceptance scenario.

- [Azure Well-Architected Framework pillars](https://learn.microsoft.com/en-us/azure/well-architected/pillars): general reliability, security, cost, operational excellence, and performance guidance.
- [arc42 crosscutting concepts](https://docs.arc42.org/section-8/): centralize rules used by multiple components.
- [arc42 quality requirements and scenarios](https://docs.arc42.org/section-10/): express requirements using context, stimulus, and measurable acceptance.
- [arc42 architecture decisions](https://docs.arc42.org/section-9/): retain choices, status, rationale, and consequences as ADRs.
- [OpenTelemetry signals](https://opentelemetry.io/docs/concepts/signals/) and [metrics conventions](https://opentelemetry.io/docs/specs/semconv/general/metrics/): reuse observability concepts without prescribing a vendor or SDK.
