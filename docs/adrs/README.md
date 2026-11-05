# Architecture Decision Records

We use [ADRs](https://adr.github.io/) for our codebase. An Architectural Decision (AD) is a justified design choice that addresses a functional or non-functional requirement that is architecturally significant. An Architecturally Significant Requirement (ASR) is a requirement that has a measurable effect on the architecture and quality of a software or hardware system. An Architectural Decision Record (ADR) captures a single AD and its rationale. Put simply, an ADR helps you understand the reasons for a chosen architectural decision, along with its trade-offs and consequences. The collection of ADRs in a project forms its decision log. All of this falls under Architectural Knowledge Management (AKM), and ADR practice can extend to design and other decisions ("any decision record").

| ADR | Decision |
| --- | --- |
| [0001](0001-case-scoped-cache-and-single-flight.md) | Namespace Redis cache entries by case; select request-local or shared coalescing per case. |
| [0002](0002-product-wire-contract.md) | Deprecate domain models as HTTP contracts; use a shared product response contract. |

## Review policy

Accepted, active decisions are review requirements. Any evidenced violation that a change creates, worsens, or directly modifies is a finding on the violating application code, with an ADR citation and a concrete compliant alternative. This applies to all decisions, not only non-functional requirements.

Each ADR should state its status and scope. When you replace a decision, mark the old ADR as superseded and link to its replacement. Do not enforce superseded, deprecated, rejected, or proposed decisions. Keep historical records so reviewers can follow the decision chain. An accepted decision that deprecates an implementation remains active.

The architecture assessment currently covers only Scalability, Observability, and Regulatory & Compliance. A category with no applicable documented requirement is "Not assessed," not automatically compliant or non-compliant. The recurring rules and acceptance scenarios are in [team architecture standards](../architecture/team-standards.md), and priorities and trade-offs are in [quality goals](../architecture/quality-goals.md). Keep significant decisions and their rationale here. An exception ADR must explicitly cite the standard's rule ID, scope, reason, and alternative controls with acceptance evidence. It does not override standards implicitly. Reviewers must not invent missing requirements.
