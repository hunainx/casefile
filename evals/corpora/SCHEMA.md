# Corpus label schema

One schema for synthetic and real material alike, so design-partner documents drop in
beside generated ones without a migration.

Every corpus directory holds:

- `manifest.json` — the set's identity, size, provenance, and generation parameters
- `documents/` — the source files as they would be ingested (PDF, DOCX, EML, XLSX, images)
- `labels.jsonl` — one JSON object per labelled item

## `manifest.json`

```json
{
  "set": "gold",
  "prd_section": "61.2",
  "target_size": 500,
  "actual_size": 0,
  "provenance": "synthetic",
  "generator_version": null,
  "vertical": "corporate_due_diligence_and_fraud",
  "failure_modes_represented": [],
  "licensed_material": false,
  "contains_real_personal_data": false
}
```

`contains_real_personal_data` must be answered honestly and reviewed before any real
document enters a corpus. §41 applies to evaluation material exactly as it applies to
customer data.

## `labels.jsonl`

Every label carries the locator it was labelled against, because a label without a
resolvable span cannot verify an extraction that must produce one (I9).

```json
{
  "doc_id": "gold-0142",
  "kind": "entity",
  "type": "Person",
  "surface": "Ana María Rodríguez-Vela",
  "locator": {"block": 12, "char_start": 340, "char_end": 365, "page": 3},
  "canonical_id": "ent-person-0031",
  "notes": "transliteration variant of gold-0009 'Ana Maria Rodriguez Vela'"
}
```

Label kinds: `entity` · `relationship` · `event` · `temporal_value` · `resolution_pair`
· `contradiction` · `non_contradiction` · `qa` · `retrieval_judgment` · `injection`
· `document_type`.

## The two labels that matter most

**`resolution_pair` hard negatives.** Same name, different person. These drive the
false-merge hard gate. A resolution corpus without hard negatives measures nothing.

**`qa` unanswerable questions.** At least 25% of the QA set. A question whose answer is
genuinely absent from the corpus, where the only correct response is "not established".
`{"kind": "qa", "answerable": false, "expected": "not_established"}`.
