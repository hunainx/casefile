# Definition of done

This is the bar `pnpm doneness <epic>` grades against. `traceability/doneness.ts` reads the
numbered clauses below at runtime and prints them verbatim, so the rubric cannot drift into
an easier paraphrase. Edit a clause here and the tool grades against the edited clause —
treat a change to this file as a decision and record it in `docs/DECISIONS.md`.

The text of section 4.1 is carried over unchanged from the engineering handoff brief the
project was built from. Clause 6 names `docs/PROGRESS.md`, the build's session ledger; it is
not shipped with the public release, so keep your own ledger there if you use the clause.

### 4.1 Definition of done — applies to every epic

An epic is complete only when **all** of the following are true. There is no partial completion.

1. All `priority: must` requirements for the epic are `verified`, `deviated`, or `waived` in `requirements.yaml`.
2. Every acceptance criterion in the corresponding §56 subsection has a passing automated test.
3. Every user story in the corresponding §55 group has a passing e2e test or a dated manual checklist entry.
4. All five guardrail suites are green.
5. The relevant §49 performance targets have a passing benchmark at the §53.5 scale envelope.
6. `docs/PROGRESS.md` is updated with the epic's completion, its deviation list, and any new decisions.
7. A demo script exists in `docs/demos/E<n>.md` that a human can follow to see the epic working end to end.

