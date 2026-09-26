# ADR-0001: Record architecture decisions

- Status: Accepted
- Date: 2026-09-24

## Context

Manuling will be built over several phases, by humans and AI builders working in many sessions. Decisions made early (tenancy, ledgers, events) constrain every later module. Unless the reasoning is written down, it gets lost and later work re-argues it.

## Decision

Record every significant architectural decision as an ADR in `/docs/adr`, numbered sequentially, using the sections Context / Decision / Consequences / Alternatives considered. "Significant" means one of: hard to reverse, crosses more than one module, adds infrastructure, or deviates from PRD §9.

## Consequences

- ADRs are reviewed in the same PR as the code that implements them.
- An accepted ADR is changed only to fix typos. A new decision supersedes it.
