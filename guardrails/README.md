# Guardrails

Five suites. They run on **every** commit — not only when the area they cover changes —
and they are never allowed to be red.

| Suite | Asserts | Invariants |
|---|---|---|
| `tenancy.spec.ts` | Cross-tenant access is impossible via every API endpoint, retrieval path, AI tool, direct object reference, and cache key | I7 · T3 · AC-SEC-01 |
| `epistemic-authority.spec.ts` | AI and deterministic asserters cannot write `Verified`/`Refuted` at the DB, service, API, or tool layer | I2 · AC-EPI-01 |
| `grounding.spec.ts` | Assertions without resolvable evidence are rejected; extractions with non-matching spans are discarded; citations that fail hash verification render broken | I1, I4, I9 · AC-PRV-01/03 |
| `injection.spec.ts` | Zero behavioral change on the adversarial corpus; empty tool registry on content paths; no Class E tool name anywhere | I5, I6 · T4 · AC-INJ-01..04 |
| `audit-integrity.spec.ts` | Audit events are insert-only; the hash chain verifies; denials are recorded; deletion fails | I8 · AC-SEC-03/04/06 |

I3 (plane separation) and I10 (pre-filtered retrieval) are enforced by service-level
integration tests in `packages/assertions` and `packages/retrieval` respectively.

## Reading the state

`pnpm guardrails` writes `.last-run.json` mapping each suite to `green`, `red`, or
`absent`. `pnpm trace:report` reads it and applies failure rule **F5**.

- **green** — every non-todo test in the suite passed.
- **red** — at least one failed. **Stop the line.** Fix it before any other work continues.
- **absent** — the suite is still entirely `todo`. Honest, and not a false green.

Suites start `absent` and turn `green` as each area lands. `injection.spec.ts` is already
partly enforceable: the Class E absence tests are structural greps that run from commit 1.

## Budget

Under four minutes for all five. A guardrail that gets slow gets skipped, and a skipped
guardrail is worthless. If a suite approaches its share of the budget, make the fixture
cheaper — never reduce the number of crossings attempted.
