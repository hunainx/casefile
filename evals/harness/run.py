#!/usr/bin/env python3
"""
Casefile evaluation harness — PRD §61.

Runs a capability against a corpus, computes its metrics, and compares them to
evals/thresholds.yaml. This is the gate referenced by requirement type `ai_eval`.

    python evals/harness/run.py --list
    python evals/harness/run.py --capability extraction --corpus entities
    python evals/harness/run.py --all                    # the CI gate
    python evals/harness/run.py --all --json

Exit codes:
    0  every gate that could be evaluated passed
    1  a gate failed
    2  a HARD GATE failed — the release is blocked, no exceptions, no override
    3  harness or corpus error

Session-1 state: the runner, the gate comparison, and the reporting are real. The
capability adapters are stubs that report `skipped` with a reason, because the
capabilities they would call do not exist until E5–E9. A stub reports `skipped`, never
a passing score — an eval harness that reports green against nothing is worse than no
harness at all.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Callable

# Windows consoles default to a legacy code page (cp1252 on most systems) that cannot
# encode the box-drawing and ellipsis characters this script prints, so the process dies
# with UnicodeEncodeError before reporting anything. Force UTF-8 on the streams so the
# gate behaves identically on every platform. A verification tool that crashes on one
# operating system is a verification tool people stop running.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parents[2]
THRESHOLDS = ROOT / "evals" / "thresholds.yaml"
CORPORA = ROOT / "evals" / "corpora"


# ---------------------------------------------------------------------------
# Threshold loading. Deliberately dependency-free: a minimal reader for the
# subset of YAML thresholds.yaml uses, so the gate never fails to run because a
# package is missing in a deployment pipeline.
# ---------------------------------------------------------------------------

@dataclass
class Gate:
    id: str
    capability: str
    metric: str
    corpus: str
    direction: str          # "min" | "max"
    mvp: float
    target: float
    hard_gate: bool = False
    human_graded: bool = False
    note: str = ""


def load_gates(path: Path = THRESHOLDS) -> list[Gate]:
    try:
        import yaml  # type: ignore
        doc = yaml.safe_load(path.read_text(encoding="utf-8"))
        return [Gate(**{k: v for k, v in g.items() if k in Gate.__dataclass_fields__})
                for g in doc.get("gates", [])]
    except ImportError:
        pass

    gates: list[Gate] = []
    cur: dict[str, object] = {}
    key: str | None = None
    for raw in path.read_text(encoding="utf-8").splitlines():
        if raw.strip().startswith("#") or not raw.strip():
            continue
        if raw.startswith("  - id:"):
            if cur:
                gates.append(_gate_from(cur))
            cur, key = {"id": raw.split(":", 1)[1].strip()}, None
            continue
        if not cur:
            continue
        if raw.startswith("    ") and ":" in raw and not raw.startswith("      "):
            k, v = raw.strip().split(":", 1)
            v = v.strip()
            if v in (">", "|", ">-", "|-"):
                key = k
                cur[k] = ""
                continue
            key = None
            cur[k] = _scalar(v)
        elif key and raw.startswith("      "):
            cur[key] = f"{cur.get(key, '')} {raw.strip()}".strip()
    if cur:
        gates.append(_gate_from(cur))
    return gates


def _scalar(v: str) -> object:
    if v in ("true", "false"):
        return v == "true"
    try:
        return float(v) if ("." in v or "e" in v.lower()) else int(v)
    except ValueError:
        return v.strip('"')


def _gate_from(d: dict[str, object]) -> Gate:
    fields = Gate.__dataclass_fields__
    kwargs = {k: v for k, v in d.items() if k in fields}
    kwargs.setdefault("capability", "")
    kwargs.setdefault("metric", "")
    kwargs.setdefault("corpus", "")
    kwargs.setdefault("direction", "min")
    kwargs.setdefault("mvp", 0.0)
    kwargs.setdefault("target", 0.0)
    return Gate(**kwargs)  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Corpus
# ---------------------------------------------------------------------------

@dataclass
class Corpus:
    name: str
    path: Path
    target_size: int
    unit: str
    documents: int
    labels: int
    provenance: str

    @property
    def actual_size(self) -> int:
        """Measured in the manifest's own unit, so `actual/target` compares like with like.

        A corpus of 500 documents carrying 2,617 labels is at 500/500, not 2617/500 —
        reporting the label count against a document target reads as five times complete
        when it is exactly complete."""
        return self.documents if self.unit == "documents" else self.labels

    @property
    def ready(self) -> bool:
        return self.actual_size > 0


def load_corpus(name: str) -> Corpus | None:
    d = CORPORA / name
    m = d / "manifest.json"
    if not m.exists():
        return None
    meta = json.loads(m.read_text(encoding="utf-8"))
    labels_file = d / "labels.jsonl"
    labels = sum(1 for line in labels_file.read_text(encoding="utf-8").splitlines() if line.strip()) \
        if labels_file.exists() else 0
    docs_dir = d / "documents"
    documents = sum(1 for f in docs_dir.iterdir() if f.is_file() and not f.name.startswith(".")) \
        if docs_dir.is_dir() else 0
    return Corpus(name=name, path=d, target_size=int(meta.get("target_size", 0)),
                  unit=str(meta.get("unit", "items")), documents=documents, labels=labels,
                  provenance=str(meta.get("provenance", "unknown")))


# ---------------------------------------------------------------------------
# Capability adapters
#
# Each returns (value, detail) or raises NotBuiltYet. Registered here so that the
# set of capabilities the harness knows about is visible in one place and cannot
# drift from thresholds.yaml — `--list` cross-checks the two.
# ---------------------------------------------------------------------------

class NotBuiltYet(Exception):
    """The capability this gate measures does not exist yet. Report skipped, never green."""


Adapter = Callable[[Gate, Corpus], tuple[float, str]]


def _pending(epic: str) -> Adapter:
    def run(gate: Gate, corpus: Corpus) -> tuple[float, str]:
        raise NotBuiltYet(f"{gate.capability} lands in {epic}")
    return run


ADAPTERS: dict[str, Adapter] = {
    "extraction": _pending("E5"),
    "resolution": _pending("E5"),
    "relationships": _pending("E5"),
    "retrieval": _pending("E6"),
    "qa": _pending("E8"),
    "verification": _pending("E8"),
    "contradiction": _pending("E9"),
    "timeline": _pending("E10"),
    "summarization": _pending("E8"),
    "gaps": _pending("E9"),
    "hypotheses": _pending("E10"),
    "injection": _pending("E8"),
}


def adapter_for(gate: Gate) -> Adapter:
    return ADAPTERS.get(gate.id.split(".", 1)[0], _pending("unassigned"))


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------

@dataclass
class Result:
    gate: str
    capability: str
    metric: str
    status: str              # pass | fail | skipped | error
    value: float | None
    mvp: float
    target: float
    direction: str
    hard_gate: bool
    detail: str = ""

    @property
    def meets_target(self) -> bool:
        if self.value is None:
            return False
        return self.value >= self.target if self.direction == "min" else self.value <= self.target


def evaluate(gate: Gate) -> Result:
    base = dict(gate=gate.id, capability=gate.capability, metric=gate.metric,
                mvp=gate.mvp, target=gate.target, direction=gate.direction,
                hard_gate=gate.hard_gate)
    corpus = load_corpus(gate.corpus)
    if corpus is None:
        return Result(**base, status="error", value=None,
                      detail=f"corpus '{gate.corpus}' has no manifest")
    if not corpus.ready:
        return Result(**base, status="skipped", value=None,
                      detail=f"corpus '{gate.corpus}' is empty (0/{corpus.target_size} {corpus.unit})")
    try:
        value, detail = adapter_for(gate)(gate, corpus)
    except NotBuiltYet as e:
        return Result(**base, status="skipped", value=None, detail=str(e))
    except Exception as e:  # noqa: BLE001 — a broken adapter must not read as a pass
        return Result(**base, status="error", value=None, detail=f"{type(e).__name__}: {e}")

    ok = value >= gate.mvp if gate.direction == "min" else value <= gate.mvp
    return Result(**base, status="pass" if ok else "fail", value=value, detail=detail)


# ---------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Run Casefile AI evaluations against §61.3 thresholds.")
    ap.add_argument("--capability")
    ap.add_argument("--corpus")
    ap.add_argument("--gate")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    if not THRESHOLDS.exists():
        print(f"FATAL: {THRESHOLDS} not found", file=sys.stderr)
        return 3

    gates = load_gates()

    if args.list:
        print(f"{len(gates)} gates in evals/thresholds.yaml\n")
        for g in gates:
            c = load_corpus(g.corpus)
            if c is None:
                size = "NO MANIFEST"
            else:
                size = f"{c.actual_size}/{c.target_size} {c.unit}"
                if c.unit == "documents" and c.labels:
                    size += f", {c.labels} labels"
            mark = "🔒" if g.hard_gate else "  "
            print(f"  {mark} {g.id:<40} {g.direction:>3} {g.mvp:<8} corpus={g.corpus:<15} {size}")
        print(f"\n  🔒 = hard gate ({sum(1 for g in gates if g.hard_gate)} total)")
        return 0

    selected = gates
    if args.gate:
        selected = [g for g in gates if g.id == args.gate]
    elif args.capability:
        selected = [g for g in gates if g.id.startswith(args.capability + ".")]
    if args.corpus:
        selected = [g for g in selected if g.corpus == args.corpus]

    if not selected:
        print("no gates matched the selection", file=sys.stderr)
        return 3

    results = [evaluate(g) for g in selected]

    if args.json:
        print(json.dumps([asdict(r) for r in results], indent=2))
    else:
        print("\nCASEFILE EVALUATION  (PRD §61.3)")
        print("─" * 78)
        for r in results:
            icon = {"pass": "✅", "fail": "❌", "skipped": "⏭ ", "error": "⚠️ "}[r.status]
            lock = "🔒" if r.hard_gate else "  "
            val = "  —  " if r.value is None else f"{r.value:.4f}"
            bound = f"{'≥' if r.direction == 'min' else '≤'} {r.mvp}"
            print(f"  {icon}{lock} {r.gate:<40} {val:>8}  {bound:<10} {r.detail}")

        failed = [r for r in results if r.status == "fail"]
        hard = [r for r in failed if r.hard_gate]
        errors = [r for r in results if r.status == "error"]
        skipped = [r for r in results if r.status == "skipped"]
        print("─" * 78)
        print(f"  {sum(1 for r in results if r.status == 'pass')} pass · {len(failed)} fail · "
              f"{len(skipped)} skipped · {len(errors)} error")
        if hard:
            print("\n  ██  HARD GATE FAILURE — this version does not ship.")
            for r in hard:
                print(f"  ██  {r.gate}: {r.value} vs {r.direction} {r.mvp}")
            print("  ██  There is no override. PRD §61.3.\n")

    if any(r.status == "fail" and r.hard_gate for r in results):
        return 2
    if any(r.status in ("fail", "error") for r in results):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
