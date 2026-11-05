# Quality goals

These are our top quality goals for `src/js-codebase/` and the trade-offs we accept to protect them. Rules live in [team-standards.md](team-standards.md). Architectural decisions and exceptions live in the [ADRs](../adrs/README.md).

Goals and trade-offs guide design choices and explain the impact of a finding. They do not create findings on their own, and they never waive an applicable rule. Only an exception ADR can do that, as described in [team-standards.md](team-standards.md#changing-standards-and-recording-exceptions).

## Goals, in priority order

| # | Goal | Scenario | Measure | Rules |
|---|---|---|---|---|
| 1 | Regulatory and compliance | A user requests another user's protected data and is denied before anything is exposed. Secrets and raw payloads never reach telemetry. | Pass applicable COMP-* acceptance scenarios: test secrets and sensitive body fields do not appear in telemetry or diagnostics; unauthorized access is denied before exposure; documented lifecycle and audit requirements are preserved. If no lifecycle or audit obligation is documented, COMP-03 is not applicable. Legal compliance is not assessed. | [COMP-01](team-standards.md#comp-01-keep-secrets-and-sensitive-payloads-out-of-telemetry), [COMP-02](team-standards.md#comp-02-preserve-authenticated-data-isolation), [COMP-03](team-standards.md#comp-03-preserve-documented-lifecycle-and-audit-controls) |
| 2 | Scalability | Load or a stalled dependency exceeds limits. Work stays bounded, excess work gets an explicit rejection, and callers finish within their deadline. | Pass applicable SCAL-* acceptance scenarios: admitted work and retained state stay within configured finite bounds; excess work has an explicit rejection or backpressure outcome; dependency attempts stay within configured budgets, local resources are released at expiry, and callers finish within their configured deadline. | [SCAL-01](team-standards.md#scal-01-bound-admitted-work-and-retained-input), [SCAL-02](team-standards.md#scal-02-bound-dependency-attempts-and-their-lifetime), [SCAL-03](team-standards.md#scal-03-bound-shared-state-growth-and-preserve-isolation) |
| 3 | Observability | A dependency fails during interleaved requests. An operator can identify the failed operation, its outcome, duration, and reason without exposing secrets. | Pass applicable OBS-* acceptance scenarios: events and downstream calls are attributed to the correct operation; failures are diagnosable from telemetry; outcomes and durations are observable without per-identifier metric series. | [OBS-01](team-standards.md#obs-01-correlate-work-across-boundaries), [OBS-02](team-standards.md#obs-02-make-operational-failures-diagnosable), [OBS-03](team-standards.md#obs-03-observe-outcomes-and-duration-without-unbounded-dimensions) |

When design options favor different goals, prefer the higher-priority goal. This priority applies to design choices only. If applicable rules cannot all be satisfied, report the conflict as an assessment limitation until an exception ADR resolves it.

## Accepted trade-offs

| We protect | At the expense of | In practice |
|---|---|---|
| Scalability | Cost | We pay for extra capacity when needed. Every autoscaling configuration has an explicit replica or resource ceiling, and the application still enforces bounded admission with rejection or backpressure (SCAL-01). |
| Scalability | Simplicity | We partition data only for components whose measured capacity or hotspot limits require it. Record the affected component, partition key, consistency consequences, and validation thresholds in an ADR. |
| Observability | Cost | We keep sanitized failure events (OBS-02) unsampled. We may sample high-volume successful traces under a documented policy. Telemetry never includes secrets or raw payloads (COMP-01). |

## Using and changing this document

Describe trade-offs that a change makes in its PR description. A rule exception needs an Accepted ADR, as described in [team-standards.md](team-standards.md#changing-standards-and-recording-exceptions). Changing a goal or trade-off requires approval from the team and stakeholders; update this file afterwards.
