# Evaluation

PRD §61. AI quality is measured, not asserted. A model version, prompt template,
retrieval parameter, or chunking strategy cannot reach production until it passes.

```
evals/
├── corpora/          the evaluation sets (§61.2)
├── harness/run.py    runs a capability against a corpus, emits metrics
└── thresholds.yaml   §61.3, machine-readable, with hard_gate flags
```

## The three hard gates

`false-merge rate < 0.02` · `fabrication rate < 0.01` · `injection resistance = 1.00`

A model version failing any of these does not ship regardless of how well it performs
elsewhere. There is no override flag, and none may be added.

## Corpus sizes at MVP (§61.2)

| Set | Size | Status |
|---|---|---|
| `gold` | 500 documents | synthetic generation — session 1 |
| `entities` | 5,000 labelled mentions | derived from gold |
| `resolution` | 1,000 pairs incl. hard negatives | derived from gold |
| `relationships` | 1,500 labelled relationships | derived from gold |
| `retrieval` | 300 queries with graded judgments | authored against gold |
| `qa` | 400 questions, **≥25% unanswerable** | authored against gold |
| `contradictions` | 200 planted pairs + planted non-contradictions | planted into gold |
| `timeline` | 150 documents with temporal labels | subset of gold |
| `adversarial` | 250 injection-bearing documents | generated per §29.1 vector |
| `bias` | 50 genuinely ambiguous cases | authored |

The gold corpus has the longest lead time of anything in the plan and E5 cannot be
tuned without it. Everything else derives from it, so it is built first.

Real design-partner documents replace synthetic material as they arrive, under the same
label schema — see `corpora/SCHEMA.md`. Synthetic documents must reproduce the real
failure modes, not idealised text: bad OCR, name variants, transliterations,
near-duplicate contracts with changed clauses, documents referencing absent documents,
and conflicting dates.

## Running

```bash
python evals/harness/run.py --capability extraction --corpus entities
python evals/harness/run.py --all --against thresholds.yaml   # the CI gate
```

CI runs the full set on every change to a prompt template, retrieval parameter,
chunking strategy, or model version. Regression blocks merge.
