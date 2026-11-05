# Copilot instructions

## Scope

- Application code lives in `src/js-codebase/`. The code guidelines, team standards, and ADRs apply only there.
- The source documents are authoritative: [code guidelines](./code-guidelines.md), [team standards](../docs/architecture/team-standards.md), [quality goals](../docs/architecture/quality-goals.md), [security](../docs/architecture/security.md), and [ADRs](../docs/adrs/README.md). Read them when available. If you cannot read them, apply the summary below and do not invent their contents.

## When writing code

- Follow the [code guidelines](./code-guidelines.md): validate input at boundaries, propagate errors instead of swallowing them, await or handle every promise, and branch on error types or codes, not messages.
- Reuse existing utilities, clients, and middleware before adding new ones or a dependency.
- Keep changes compliant with the team standards and with Accepted, active ADRs.

## When reviewing code

- Report only problems that the change creates, worsens, or directly modifies. Do not report unrelated legacy gaps or personal preferences.
- A demonstrated violation of an applicable team standard (SCAL-\*, OBS-\*, COMP-\*) or an Accepted, active ADR is a bug, even if the code otherwise works. In the comment:
  - point to the violating application code, not the documentation;
  - cite the rule ID or the ADR decision;
  - explain the impact;
  - propose a concrete compliant alternative.
- Before reporting a missing control, check shared middleware, clients, callers, and infrastructure. Do not require each function to repeat a control that is already shared.
- Enforce only Accepted, active ADRs. Ignore proposed, rejected, deprecated, and superseded ones. An Accepted ADR that deprecates an implementation is still active.
- An exception is valid only when an Accepted, active ADR cites the exact rule ID, scope, reason, and alternative controls with acceptance evidence. Quality-goal priorities never waive a rule. Explain unresolved conflicts instead of guessing which rule wins.

## Architecture assessment

- Assess only Scalability, Observability, and Regulatory & Compliance, using documented requirements and code evidence. Report active ADR violations in other areas as normal findings.
- Per category:
  - **Not compliant**: at least one demonstrated violation, even if other rules lack evidence.
  - **Compliant**: evidence for every applicable rule.
  - **Not assessed**: no applicable rule, or insufficient evidence. Say which evidence is missing.
- Do not infer regulations, SLOs, tenancy, or retention periods. Engineering controls are not legal certification, so always state that legal compliance is not assessed.
