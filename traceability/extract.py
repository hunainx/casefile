#!/usr/bin/env python3
"""
Casefile requirements extractor.

Mechanical first pass over docs/PRD.md producing traceability/requirements.yaml:
the machine-readable index of every normative statement in the specification.

Per HANDOFF.md §3.2 this pass is expected to capture roughly 60% of the final
database. The remaining prose invariants are added by hand, section by section,
as each epic is reached. The extractor is idempotent and MERGE-SAFE: re-running
it never destroys hand-authored fields (see merge_preserving()).

Usage:
    python traceability/extract.py docs/PRD.md                 # write requirements.yaml
    python traceability/extract.py docs/PRD.md --stdout        # print instead
    python traceability/extract.py docs/PRD.md --stats         # counts only
"""

from __future__ import annotations

import argparse
import io
import re
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path

# Windows consoles default to a legacy code page (cp1252 on most systems) that cannot
# encode the box-drawing and ellipsis characters this script prints, so the process dies
# with UnicodeEncodeError before reporting anything. Force UTF-8 on the streams so the
# gate behaves identically on every platform. A verification tool that crashes on one
# operating system is a verification tool people stop running.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8", errors="replace")


# --------------------------------------------------------------------------
# Epic map — HANDOFF.md §1.2 "Section map"
# --------------------------------------------------------------------------

EPIC_BY_SECTION: dict[int, str] = {}


def _assign(epic: str, *sections: int) -> None:
    for s in sections:
        EPIC_BY_SECTION.setdefault(s, epic)


# Most specific first: a section claimed by an earlier call keeps that epic.
_assign("E4", 6, 7)                          # knowledge model, source of truth — the spine
_assign("E2", 8, 9)                          # investigation object + lifecycle
_assign("E3", 5, 10, 11)                     # pipeline stages 1-4, sources, ingestion
_assign("E5", 14, 15, 16)                    # entity intelligence, resolution, relationships
_assign("E6", 12, 27)                        # search, retrieval architecture
_assign("E7", 19, 33)                        # evidence system, evidence viewer
_assign("E8", 13, 21, 26, 28, 29, 43, 60, 61)  # memory, AI engine, agents, defenses, gateway
_assign("E9", 24, 25)                        # contradictions, gaps
_assign("E10", 17, 18, 22, 23)               # graph, temporal, multi-hop, hypotheses
_assign("E11", 35, 36)                       # brief-as-deliverable, reporting
_assign("E12", 30, 31, 32, 34, 37)           # workspace UX, command centre, entity page, copilot, collab
_assign("E1", 20, 38, 39, 40, 41, 42, 44, 45, 46, 47, 48, 50, 59)  # platform
# Everything else is cross-cutting context or governance.

CONTINUOUS_SECTIONS = {49, 62, 63, 66, 67}


def epic_for(section: int) -> str:
    return EPIC_BY_SECTION.get(section, "E0")


# --------------------------------------------------------------------------
# E0 and the rule against falling back to it
# --------------------------------------------------------------------------
#
# E0 means "cross-cutting — owned by the whole build, not by one epic". Threats (§62),
# risks (§63), decisions (§66), assumptions (§65), open questions (§64), the §67 quality
# bar and the §3/§4 definitional invariants belong there honestly: no single epic closes
# them.
#
# Nothing else does. A story, an acceptance criterion, a table, a performance target or
# an endpoint that lands in E0 is a MAPPING BUG, and it is an invisible one, because
# `pnpm doneness` runs per epic and E0 is not in the build order. That is how 224 `must`
# requirements — 18% of the specification — sat unowned for nine sessions while every
# epic reported its own coverage honestly.
#
# So the mappable types do not fall back. They raise. A wrong guess now costs one failed
# extraction run instead of a silently unowned fifth of the product.


class UnmappedRequirement(RuntimeError):
    pass


def owner(table: dict[str, str], key: str, what: str, table_name: str) -> str:
    epic = table.get(key)
    if epic is None:
        raise UnmappedRequirement(
            f"{what}: key {key!r} is not in {table_name}. Add it — do not let it fall "
            f"through to E0, which no `pnpm doneness` run ever inspects."
        )
    return epic


# Every §59.2 table, mapped to the epic that owns its write path. Tenancy tables are
# handled separately (TENANCY_TABLES → E1) and are not listed here.
SCHEMA_EPIC: dict[str, str] = {
    "investigations": "E2",
    # ingestion pipeline, §5.2 stages 1-4
    "sources": "E3", "source_instances": "E3", "artifacts": "E3",
    "content_documents": "E3", "content_blocks": "E3", "injection_flags": "E3",
    "chunks": "E3", "embeddings": "E3",
    # the assertion spine, §6/§7 — E4 owns the only write path
    "assertions": "E4", "assertion_evidence": "E4", "events": "E4",
    # entity intelligence and resolution, §14-§16
    "entities": "E5", "entity_identifiers": "E5", "entity_aliases": "E5",
    "entity_mentions": "E5", "merge_candidates": "E5", "merge_records": "E5",
    # search and investigation memory, §12/§27
    "searches": "E6", "saved_searches": "E6",
    # evidence and provenance, §19/§33
    "evidence": "E7", "source_assessments": "E7", "source_derivations": "E7",
    # AI gateway, §13/§21/§26/§28/§29/§43/§60/§61
    "ai_results": "E8", "context_manifests": "E8", "ai_citations": "E8",
    "prompt_templates": "E8", "model_registry": "E8", "agent_runs": "E8",
    # correlation, §24/§25
    "contradictions": "E9", "suppression_rules": "E9", "research_gaps": "E9",
    # analysis, §17/§18/§22/§23
    "hypotheses": "E10", "ach_matrices": "E10", "ach_cells": "E10",
    # findings and reporting, §8.9/§35/§36
    "findings": "E11", "finding_evidence": "E11", "finding_versions": "E11",
    "dissent_notes": "E11", "reports": "E11", "report_versions": "E11", "exports": "E11",
    # command center and collaboration, §30-§34/§37
    "notes": "E12", "tasks": "E12", "comments": "E12", "notifications": "E12",
    # platform infrastructure, §38-§48
    "outbox": "E1", "jobs": "E1", "cost_ledger": "E1",
}

# §49 performance targets, matched on the operation name in the table's first column.
# Longest match wins, so "Evidence viewer, first PDF page render" does not collide with
# "Evidence viewer open (cached)" — both are E7 here, but the ordering matters if they
# ever diverge.
PERF_EPIC: list[tuple[str, str]] = [
    ("command center", "E12"),
    ("investigation open", "E2"),
    ("keyword search", "E6"),
    ("hybrid search", "E6"),
    ("entity page", "E5"),
    ("evidence viewer", "E7"),
    ("graph", "E10"),
    ("timeline", "E10"),
    ("multi-hop", "E10"),
    ("ai grounded answer", "E8"),
    ("report generation", "E11"),
    ("export package", "E11"),
    ("ingestion", "E3"),
]


def perf_epic(operation: str) -> str:
    low = operation.lower()
    for needle, epic in sorted(PERF_EPIC, key=lambda kv: -len(kv[0])):
        if needle in low:
            return epic
    raise UnmappedRequirement(
        f"§49 performance target {operation!r} matches no entry in PERF_EPIC. Add one. "
        f"A perf requirement in E0 is measured against every epic and closed by none."
    )


# Types that must always name an owning epic. Anything here in E0 is a mapping bug.
MAPPABLE_TYPES = frozenset({
    "story", "acceptance", "schema", "perf", "api", "event", "rbac", "tool",
})


# --------------------------------------------------------------------------
# The ten invariants — HANDOFF.md §1.3
# --------------------------------------------------------------------------

INVARIANTS: list[dict[str, str]] = [
    dict(ref="I1", section="6.6", epic="E4",
         statement="No assertion above `Possible` exists without a resolvable evidence locator. "
                   "Enforced at Assertion Service write path step 2.",
         methods="integration_test,arch_test"),
    dict(ref="I2", section="6.5", epic="E4",
         statement="A `model` or `deterministic` asserter can never write `Verified` or `Refuted`. "
                   "Enforced by a database CHECK constraint and by the Assertion Service.",
         methods="db_constraint,integration_test,arch_test"),
    dict(ref="I3", section="6.3", epic="E4",
         statement="Machine-plane recomputation never mutates record-plane rows; it emits a "
                   "DivergenceNotice instead.",
         methods="integration_test"),
    dict(ref="I4", section="6.8", epic="E7",
         statement="Every citation resolves to a span whose hash matches, or renders as broken. "
                   "Enforced by the citation resolver and a nightly integrity job.",
         methods="integration_test,e2e_test"),
    dict(ref="I5", section="29.2", epic="E8",
         statement="Content-processing model calls are made with an empty tool registry.",
         methods="arch_test,integration_test"),
    dict(ref="I6", section="26.2", epic="E8",
         statement="Class E tools do not exist as callable functions anywhere in the codebase.",
         methods="arch_test"),
    dict(ref="I7", section="38.5", epic="E1",
         statement="Every query is tenant-scoped at the data layer via Postgres RLS, never in "
                   "application filters alone.",
         methods="db_constraint,integration_test"),
    dict(ref="I8", section="39.4", epic="E1",
         statement="Audit events are insert-only, hash-chained, and undeletable by any application role.",
         methods="db_constraint,integration_test"),
    dict(ref="I9", section="5.2", epic="E5",
         statement="An extraction whose quoted span does not verify is discarded, not stored.",
         methods="unit_test,integration_test"),
    dict(ref="I10", section="12.4", epic="E6",
         statement="Search results the user cannot see are filtered before scoring, never after.",
         methods="integration_test"),
]



# --------------------------------------------------------------------------
# Resource ownership for endpoints and events.
#
# §45 (API) and §46 (events) are platform sections, so the section-level map above
# files every endpoint and every event under E1. That is wrong, and it is wrong in a
# way that hides: `/v1/investigations/{id}/sources` is E3 work and
# `ContradictionDetected` is E9 work, but both were counted against E1's definition
# of done. The effect was that E1 carried 193 outstanding `must` requirements, 118 of
# which belong to epics that have not started — making E1 structurally unclosable and
# every other epic's progress invisible.
#
# An endpoint belongs to the epic that owns its resource. An event belongs to the epic
# that owns its producer. Ordered longest-prefix-first so the specific wins.
# --------------------------------------------------------------------------

API_OWNER: list[tuple[str, str]] = [
    ("/v1/investigations/{id}/sources", "E3"),
    ("/v1/investigations/{id}/search", "E6"),
    ("/v1/investigations/{id}/searches", "E6"),
    ("/v1/investigations/{id}/saved-searches", "E6"),
    ("/v1/investigations/{id}/entities", "E5"),
    ("/v1/investigations/{id}/relationships", "E5"),
    ("/v1/investigations/{id}/merge-candidates", "E5"),
    ("/v1/investigations/{id}/evidence", "E7"),
    ("/v1/investigations/{id}/assertions", "E4"),
    ("/v1/investigations/{id}/contradictions", "E9"),
    ("/v1/investigations/{id}/gaps", "E9"),
    ("/v1/investigations/{id}/hypotheses", "E10"),
    ("/v1/investigations/{id}/timeline", "E10"),
    ("/v1/investigations/{id}/graph", "E10"),
    ("/v1/investigations/{id}/findings", "E11"),
    ("/v1/investigations/{id}/reports", "E11"),
    ("/v1/investigations/{id}/exports", "E11"),
    ("/v1/investigations/{id}/brief", "E12"),
    ("/v1/investigations/{id}/health", "E12"),
    ("/v1/investigations/{id}/questions", "E2"),
    ("/v1/investigations/{id}/transition", "E2"),
    ("/v1/investigations", "E2"),
    ("/v1/sources", "E3"),
    ("/v1/entities", "E5"),
    ("/v1/relationships", "E5"),
    ("/v1/assertions", "E4"),
    ("/v1/evidence", "E7"),
    ("/v1/citations", "E7"),
    ("/v1/contradictions", "E9"),
    ("/v1/gaps", "E9"),
    ("/v1/hypotheses", "E10"),
    ("/v1/findings", "E11"),
    ("/v1/reports", "E11"),
    ("/v1/exports", "E11"),
    ("/v1/ai", "E8"),
    ("/v1/analyses", "E8"),
    ("/v1/memory", "E8"),
    ("/v1/notes", "E12"),
    ("/v1/tasks", "E12"),
    ("/v1/command-center", "E12"),
    # Everything left is genuinely platform: auth, me, organizations, workspaces, audit.
]

EVENT_OWNER: dict[str, str] = {
    "Investigation": "E2", "Source": "E3", "Artifact": "E3", "Content": "E3",
    "Document": "E3", "Sensitive": "E3", "Injection": "E8", "Extraction": "E5",
    "Entity": "E5", "Entities": "E5", "Merge": "E5", "Relationship": "E5",
    "Index": "E6", "Evidence": "E7", "Assertion": "E4", "Contradiction": "E9",
    "Gap": "E9", "Hypothesis": "E10", "Disconfirming": "E10", "Analysis": "E8",
    "Finding": "E11", "Report": "E11", "Export": "E11", "Policy": "E1",
}


def epic_for_endpoint(path: str) -> str:
    for prefix, epic in API_OWNER:
        if path.startswith(prefix):
            return epic
    return "E1"


def epic_for_event(name: str) -> str:
    for stem, epic in EVENT_OWNER.items():
        if name.startswith(stem):
            return epic
    return "E1"


# --------------------------------------------------------------------------
# Requirement record
# --------------------------------------------------------------------------

VALID_TYPES = {
    "invariant", "acceptance", "story", "schema", "api", "event", "perf",
    "security", "ai_eval", "ux", "behavior", "rbac", "tool", "threat",
    "risk", "assumption", "decision", "open_question", "quality", "context",
}

VALID_STATUS = {
    "not_started", "in_progress", "implemented", "verified", "deviated", "waived",
}


@dataclass
class Requirement:
    id: str
    prd_section: str
    prd_anchor: str
    statement: str
    type: str
    epic: str
    priority: str = "must"
    invariant_ref: str | None = None
    verification: dict = field(default_factory=lambda: {"method": [], "artifacts": []})
    status: str = "not_started"
    verified_at: str | None = None
    notes: str = ""


# --------------------------------------------------------------------------
# PRD parsing
# --------------------------------------------------------------------------

H2 = re.compile(r"^## (\d+)\.\s+(.*)$")
H2_UNNUMBERED = re.compile(r"^## (?!\d)(.*)$")
H3 = re.compile(r"^### (\d+)\.(\d+)\s+(.*)$")
FENCE = re.compile(r"^```")


@dataclass
class Block:
    """A subsection of the PRD: its heading, its prose lines, and its fenced code."""
    section: int
    subsection: str          # "6.5" or "6" when text sits directly under the H2
    title: str
    lines: list[str] = field(default_factory=list)      # prose + tables, no fences
    fences: list[tuple[str, list[str]]] = field(default_factory=list)  # (lang, body)


def parse_blocks(text: str) -> list[Block]:
    blocks: list[Block] = []
    cur: Block | None = None
    section = 0
    title = ""
    in_fence = False
    fence_lang = ""
    fence_body: list[str] = []

    for raw in text.splitlines():
        if FENCE.match(raw):
            if in_fence:
                if cur is not None:
                    cur.fences.append((fence_lang, fence_body))
                in_fence, fence_lang, fence_body = False, "", []
            else:
                in_fence = True
                fence_lang = raw.strip("` ").strip()
                fence_body = []
            continue

        if in_fence:
            fence_body.append(raw)
            continue

        m2 = H2.match(raw)
        if m2:
            section, title = int(m2.group(1)), m2.group(2).strip()
            cur = Block(section=section, subsection=str(section), title=title)
            blocks.append(cur)
            continue

        if H2_UNNUMBERED.match(raw):
            # Table of contents, PART dividers, etc. Stop collecting into the prior block.
            cur = None
            continue

        m3 = H3.match(raw)
        if m3 and int(m3.group(1)) == section:
            cur = Block(section=section,
                        subsection=f"{m3.group(1)}.{m3.group(2)}",
                        title=m3.group(3).strip())
            blocks.append(cur)
            continue

        if cur is not None:
            cur.lines.append(raw)

    return blocks


# --------------------------------------------------------------------------
# Structured extractors
# --------------------------------------------------------------------------

STORY = re.compile(r"^\s*[-*]\s+\*\*([A-Z]{2,8}-\d{1,3})\*\*\s*[—–-]\s*(.+?)\s*$")
AC_HEAD = re.compile(r"^\s*\*\*(AC-[A-Z]{2,8}-\d{1,3})\s*[—–-]\s*(.+?)\*\*\s*$")
# Some criteria are written inline rather than as a heading + Given/When/Then bullets
# (e.g. the §56 performance block). Both forms are acceptance criteria.
AC_INLINE = re.compile(r"^\s*\*\*(AC-[A-Z]{2,8}-\d{1,3})\*\*\s*[—–-]\s*(.+?)\s*$")
SQL_TABLE = re.compile(r"^([a-z][a-z0-9_]{2,})\s{2,}\(")
ENDPOINT = re.compile(r"^(GET|POST|PATCH|PUT|DELETE)\s+(/\S+)\s*(.*)$")
TABLE_ROW = re.compile(r"^\|(.+)\|\s*$")
BACKTICKED = re.compile(r"`([^`]+)`")
TOOL_HEAD = re.compile(r"^\*\*`([a-z_]+)`\*\*\s*$")


def cells(row: str) -> list[str]:
    return [c.strip() for c in row.strip().strip("|").split("|")]


def is_separator(row: str) -> bool:
    return bool(re.fullmatch(r"[\s|:\-]+", row))


def slug(s: str, maxlen: int = 44) -> str:
    s = re.sub(r"\{[^}]*\}", "id", s)
    s = re.sub(r"[^A-Za-z0-9]+", "-", s).strip("-").upper()
    return s[:maxlen].strip("-")


def clean(s: str) -> str:
    """Strip markdown emphasis for a readable statement, keep backticks."""
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"\1", s)
    return re.sub(r"\s+", " ", s).strip()


# --------------------------------------------------------------------------
# Normative prose detection
# --------------------------------------------------------------------------

# Ordered strongest-first: the first pattern that matches decides the type.
HARD_NORMATIVE = [
    r"\bnever\b", r"\bcannot\b", r"\bmust not\b", r"\bmay not\b", r"\bis prohibited\b",
    r"\bno .{0,40}\bwithout\b", r"\bis rejected\b", r"\bare rejected\b",
    r"\bis discarded\b", r"\bare discarded\b", r"\bis blocked\b", r"\bare blocked\b",
    r"\bis refused\b", r"\bdo not exist\b", r"\bdoes not exist\b",
    r"\bunder no circumstances\b", r"\bis undeletable\b", r"\bimmutable\b",
]

SOFT_NORMATIVE = [
    r"\bmust\b", r"\bshall\b", r"\balways\b", r"\bis required\b", r"\bare required\b",
    r"\brequires\b", r"\bis enforced\b", r"\benforced by\b", r"\bonly\b",
    r"\bevery\b", r"\bis mandatory\b", r"\bmandatory\b", r"\bhard gate\b",
    r"\bblocks\b", r"\brejects\b", r"\bdiscards\b", r"\bis capped\b",
    r"\bdefaults? to\b", r"\bis recorded\b", r"\bis audited\b", r"\bis logged\b",
]

HARD_RE = re.compile("|".join(HARD_NORMATIVE), re.I)
SOFT_RE = re.compile("|".join(SOFT_NORMATIVE), re.I)

# Prose that reads normative but is commentary, not a requirement on the system.
NON_NORMATIVE_HINTS = re.compile(
    r"\b(for example|e\.g\.|i\.e\.|in other words|this section|the following table|"
    r"see §|as described|competitors|the market|investors|arguably|we believe)\b", re.I)

SENTENCE_SPLIT = re.compile(r"(?<=[.;:])\s+(?=[A-Z`\"(*])")


def sentences(line: str) -> list[str]:
    line = line.strip()
    if not line:
        return []
    # Bullets and table cells are already statement-sized; don't over-split them.
    line = re.sub(r"^\s*[-*•]\s+", "", line)
    parts = SENTENCE_SPLIT.split(line)
    return [p.strip() for p in parts if p.strip()]


SEC_PREFIX: dict[int, str] = {
    5: "PIPE", 6: "KNW", 7: "SOT", 8: "INV", 9: "LIFE", 10: "SRC", 11: "ING",
    12: "SRCH", 13: "MEM", 14: "ENT", 15: "RES", 16: "REL", 17: "GRAPH",
    18: "TIME", 19: "EVID", 20: "SRCQ", 21: "AIE", 22: "HOP", 23: "HYP",
    24: "CON", 25: "GAP", 26: "AGT", 27: "RAG", 28: "HALL", 29: "INJ",
    30: "UX", 31: "CC", 32: "EPAGE", 33: "VIEW", 34: "COPI", 35: "BRIEF",
    36: "RPT", 37: "COLLAB", 38: "RBAC", 39: "AUDIT", 40: "SEC", 41: "PRIV",
    42: "CONN", 43: "GATE", 44: "STOR", 45: "API", 46: "EVT", 47: "BG",
    48: "OBS", 49: "PERF", 50: "RET", 51: "ANLY", 52: "MONEY", 53: "MVP",
    54: "LOOP", 3: "DEF", 4: "NORTH",
}


def prefix_for(section: int) -> str:
    return SEC_PREFIX.get(section, f"S{section}")


# --------------------------------------------------------------------------
# Extraction
# --------------------------------------------------------------------------

class Extractor:
    def __init__(self) -> None:
        self.reqs: list[Requirement] = []
        self._seen: set[str] = set()
        self._counters: dict[str, int] = {}

    def add(self, req: Requirement) -> None:
        if req.id in self._seen:
            return
        self._seen.add(req.id)
        self.reqs.append(req)

    def next_id(self, prefix: str) -> str:
        self._counters[prefix] = self._counters.get(prefix, 0) + 1
        return f"REQ-{prefix}-{self._counters[prefix]:03d}"

    # -- invariants ------------------------------------------------------
    def invariants(self) -> None:
        for inv in INVARIANTS:
            self.add(Requirement(
                id=f"REQ-INV-{inv['ref']}",
                prd_section=inv["section"],
                prd_anchor=f"Invariant {inv['ref']}",
                statement=inv["statement"],
                type="invariant",
                epic=inv["epic"],
                priority="must",
                invariant_ref=inv["ref"],
                verification={"method": inv["methods"].split(","), "artifacts": []},
            ))

    # -- stories ---------------------------------------------------------
    def stories(self, blocks: list[Block]) -> None:
        for b in (b for b in blocks if b.section == 55):
            for line in b.lines:
                m = STORY.match(line)
                if not m:
                    continue
                sid, body = m.group(1), clean(m.group(2))
                self.add(Requirement(
                    id=f"REQ-{sid}",
                    prd_section=b.subsection,
                    prd_anchor=b.title,
                    statement=body,
                    type="story",
                    epic=self._epic_for_story(sid),
                    priority="must",
                    verification={"method": ["e2e_test"], "artifacts": []},
                ))

    # Keyed on the ACTUAL §55 story-id prefixes in PRD.md. An earlier version of this
    # table was written from guessed prefixes — EVID/TIME/GRAPH/FIND/COLLAB/ADMIN — none
    # of which the PRD uses. Eighty-one stories fell silently to E0, where no `pnpm
    # doneness` run could ever see them. Verify a key against the PRD before adding it.
    STORY_EPIC = {
        "AUTH": "E1", "WS": "E1", "SEC": "E1", "ADM": "E1",
        "INV": "E2",
        "SRC": "E3", "ING": "E3",
        "RES": "E5", "ENT": "E5", "REL": "E5",
        "SRCH": "E6",
        "EVI": "E7",
        "AI": "E8", "MEM": "E8",
        "CON": "E9", "GAP": "E9",
        "HYP": "E10", "TML": "E10", "GRF": "E10",
        "FND": "E11", "RPT": "E11", "EXP": "E11",
        "CC": "E12", "COL": "E12", "NOTE": "E12", "TASK": "E12",
    }

    def _epic_for_story(self, sid: str) -> str:
        return owner(self.STORY_EPIC, sid.split("-")[0], f"story {sid}", "STORY_EPIC")

    # -- acceptance criteria ---------------------------------------------
    def acceptance(self, blocks: list[Block]) -> None:
        for b in (b for b in blocks if b.section == 56):
            pending: Requirement | None = None
            body: list[str] = []
            for line in b.lines + [""]:
                mi = AC_INLINE.match(line)
                if mi and not AC_HEAD.match(line):
                    if pending:
                        pending.statement = " ".join(body).strip() or pending.statement
                        self.add(pending)
                        pending, body = None, []
                    acid = mi.group(1)
                    self.add(Requirement(
                        id=f"REQ-AC-{acid[3:]}",
                        prd_section=b.subsection,
                        prd_anchor=acid,
                        statement=clean(mi.group(2)),
                        type="acceptance",
                        epic=self._epic_for_ac(acid),
                        priority="must",
                        verification={"method": ["benchmark"] if "-PERF-" in acid else ["e2e_test"],
                                      "artifacts": []},
                    ))
                    continue
                m = AC_HEAD.match(line)
                if m:
                    if pending:
                        pending.statement = " ".join(body).strip() or pending.statement
                        self.add(pending)
                    acid, title = m.group(1), clean(m.group(2))
                    body = []
                    pending = Requirement(
                        id=f"REQ-AC-{acid[3:]}",
                        prd_section=b.subsection,
                        prd_anchor=f"{acid} — {title}",
                        statement=title,
                        type="acceptance",
                        epic=self._epic_for_ac(acid),
                        priority="must",
                        verification={"method": ["e2e_test"], "artifacts": []},
                    )
                    continue
                if pending and line.strip().startswith(("-", "*")):
                    body.append(clean(line))
            if pending:
                pending.statement = " ".join(body).strip() or pending.statement
                self.add(pending)

    AC_EPIC = {
        "DEF": "E2", "ING": "E3", "EPI": "E4", "PRV": "E7", "SRCH": "E6",
        "ENT": "E5", "RES": "E5", "REL": "E5", "AI": "E8", "INJ": "E8",
        "CON": "E9", "GAP": "E9", "HYP": "E10", "TIME": "E10", "TML": "E10",
        "FND": "E11", "FIND": "E11", "RPT": "E11", "EXP": "E11",
        "SEC": "E1", "AUD": "E1", "CC": "E12", "COLLAB": "E12", "COL": "E12",
        "MEM": "E8",
        # AC-PERF-01..06 measure the whole system at the §53.5 envelope, not one epic.
        # This is the one deliberate E0 acceptance mapping.
        "PERF": "E0",
    }

    def _epic_for_ac(self, acid: str) -> str:
        return owner(self.AC_EPIC, acid.split("-")[1], f"acceptance criterion {acid}", "AC_EPIC")

    # -- schema ----------------------------------------------------------
    def schema(self, blocks: list[Block]) -> None:
        for b in (b for b in blocks if b.section == 59):
            for lang, body in b.fences:
                if lang.lower() not in ("sql", "", "text"):
                    continue
                for line in body:
                    m = SQL_TABLE.match(line)
                    if not m:
                        continue
                    table = m.group(1)
                    self.add(Requirement(
                        id=f"REQ-SCH-{table.upper().replace('_', '-')}",
                        prd_section=b.subsection,
                        prd_anchor=f"table {table}",
                        statement=f"Table `{table}` exists with the columns, types, foreign keys, "
                                  f"indexes and constraints specified in PRD §{b.subsection}, "
                                  f"carries the §59.1 conventional columns, and has RLS enabled "
                                  f"with a policy keyed to current_setting('app.tenant_id').",
                        type="schema",
                        epic="E1" if table in TENANCY_TABLES
                             else owner(SCHEMA_EPIC, table, f"table {table}", "SCHEMA_EPIC"),
                        priority="must",
                        verification={"method": ["db_constraint", "integration_test"], "artifacts": []},
                    ))

    # -- api -------------------------------------------------------------
    def api(self, blocks: list[Block]) -> None:
        for b in (b for b in blocks if b.section == 45):
            for _lang, body in b.fences:
                for line in body:
                    m = ENDPOINT.match(line.strip())
                    if not m:
                        continue
                    method, path, note = m.group(1), m.group(2), clean(m.group(3))
                    self.add(Requirement(
                        id=f"REQ-API-{method}-{slug(path)}",
                        prd_section=b.subsection,
                        prd_anchor=f"{method} {path}",
                        statement=f"`{method} {path}` exists, matches the generated OpenAPI 3.1 "
                                  f"contract, enforces tenant scoping and the §38.3 permission for "
                                  f"the operation, and returns the §45.4 error envelope on failure."
                                  + (f" Note: {note}" if note else ""),
                        type="api",
                        epic=epic_for_endpoint(path),
                        priority="must",
                        verification={"method": ["integration_test"], "artifacts": []},
                    ))

    # -- events ----------------------------------------------------------
    def events(self, blocks: list[Block]) -> None:
        for b in (b for b in blocks if b.section == 46):
            for line in b.lines:
                m = TABLE_ROW.match(line)
                if not m or is_separator(m.group(1)):
                    continue
                c = cells(m.group(1))
                if len(c) < 3 or c[0].lower().startswith("event"):
                    continue
                names = BACKTICKED.findall(c[0])
                if not names:
                    continue
                producer, consumers = clean(c[1]), clean(c[2])
                for name in names:
                    self.add(Requirement(
                        id=f"REQ-EVT-{slug(name)}",
                        prd_section=b.subsection,
                        prd_anchor=f"event {name}",
                        statement=f"`{name}` is produced by {producer} with the documented payload "
                                  f"and is consumed by: {consumers}. Producer and consumer are each "
                                  f"covered by a test; the event is emitted transactionally via the "
                                  f"outbox.",
                        type="event",
                        epic=epic_for_event(name),
                        priority="must",
                        verification={"method": ["integration_test"], "artifacts": []},
                    ))

    # -- rbac ------------------------------------------------------------
    def rbac(self, blocks: list[Block]) -> None:
        for b in (b for b in blocks if b.subsection == "38.3"):
            header: list[str] = []
            for line in b.lines:
                m = TABLE_ROW.match(line)
                if not m:
                    continue
                if is_separator(m.group(1)):
                    continue
                c = cells(m.group(1))
                if not header:
                    header = c
                    continue
                perms = BACKTICKED.findall(c[0])
                if not perms:
                    continue
                perm = perms[0]
                matrix = ", ".join(f"{role}={verdict}" for role, verdict in zip(header[1:], c[1:]))
                self.add(Requirement(
                    id=f"REQ-RBAC-{slug(perm)}",
                    prd_section="38.3",
                    prd_anchor=f"permission {perm}",
                    statement=f"Permission `{perm}` resolves exactly as the §38.3 matrix specifies "
                              f"({matrix}), decided by a single policy implementation, denied by "
                              f"default, and every denial is audited.",
                    type="rbac",
                    epic="E1",
                    priority="must",
                    verification={"method": ["unit_test", "integration_test"], "artifacts": []},
                ))

    # -- ai evaluation thresholds ---------------------------------------
    def ai_evals(self, blocks: list[Block]) -> None:
        for b in (b for b in blocks if b.subsection == "61.3"):
            capability = ""
            for line in b.lines:
                m = TABLE_ROW.match(line)
                if not m or is_separator(m.group(1)):
                    continue
                c = cells(m.group(1))
                if len(c) < 4 or c[0].startswith("Capability"):
                    continue
                if clean(c[0]):
                    capability = clean(c[0])
                metric, mvp, target = clean(c[1]), clean(c[2]), clean(c[3])
                if not metric:
                    continue
                hard = any(k in metric.lower() for k in
                           ("false-merge", "fabrication", "injection resistance"))
                self.add(Requirement(
                    id=self.next_id("EVAL"),
                    prd_section="61.3",
                    prd_anchor=f"{capability} — {metric}",
                    statement=f"{capability}: {metric} meets the MVP threshold {mvp} "
                              f"(target {target}) on the §61.2 evaluation set."
                              + (" HARD GATE — a model version failing this does not ship." if hard else ""),
                    type="ai_eval",
                    epic="E8",
                    priority="must",
                    verification={"method": ["eval"], "artifacts": []},
                ))

    # -- performance targets --------------------------------------------
    def perf(self, blocks: list[Block]) -> None:
        for b in (b for b in blocks if b.section == 49):
            for line in b.lines:
                m = TABLE_ROW.match(line)
                if not m or is_separator(m.group(1)):
                    continue
                c = cells(m.group(1))
                if len(c) < 4 or c[0].startswith("Operation"):
                    continue
                op, p50, p95, p99 = clean(c[0]), clean(c[1]), clean(c[2]), clean(c[3])
                if not op:
                    continue
                self.add(Requirement(
                    id=self.next_id("PERF"),
                    prd_section="49",
                    prd_anchor=op,
                    statement=f"{op}: p50 ≤ {p50}, p95 ≤ {p95}, p99 ≤ {p99}, measured at the "
                              f"§49 scale assumptions (10,000 sources, 2M chunks, 50,000 entities, "
                              f"200,000 assertions, 100 concurrent users per tenant).",
                    type="perf",
                    epic=perf_epic(op),
                    priority="must",
                    verification={"method": ["benchmark"], "artifacts": []},
                ))

    # -- AI tool contracts ------------------------------------------------
    def tools(self, blocks: list[Block]) -> None:
        for b in (b for b in blocks if b.section == 60):
            klass = b.title
            current: str | None = None
            body: list[str] = []
            for line in b.lines + [""]:
                m = TOOL_HEAD.match(line.strip())
                if m:
                    if current:
                        self._emit_tool(current, klass, b.subsection, body)
                    current, body = m.group(1), []
                    continue
                if current and line.strip().startswith("-"):
                    body.append(clean(line))
            if current:
                self._emit_tool(current, klass, b.subsection, body)

    def _emit_tool(self, name: str, klass: str, subsection: str, body: list[str]) -> None:
        self.add(Requirement(
            id=f"REQ-TOOL-{slug(name)}",
            prd_section=subsection,
            prd_anchor=f"tool {name} ({klass})",
            statement=f"Tool `{name}` ({klass}) implements its §60 contract exactly: "
                      + " ".join(body)[:900],
            type="tool",
            epic="E8",
            priority="must",
            verification={"method": ["unit_test", "integration_test", "arch_test"], "artifacts": []},
        ))

    # -- governance tables ------------------------------------------------
    def governance(self, blocks: list[Block]) -> None:
        specs = [
            (62, r"^T\d+$", "THR", "threat", "must", ["integration_test", "arch_test"], "E0"),
            (63, r"^R\d+$", "RSK", "risk", "should", ["review"], "E0"),
            (66, r"^D\d+$", "DEC", "decision", "must", ["review"], "E0"),
            (64, r"^Q\d+$", "OQ", "open_question", "should", ["review"], "E0"),
        ]
        for section, idpat, prefix, rtype, priority, methods, epic in specs:
            pat = re.compile(idpat)
            for b in (b for b in blocks if b.section == section):
                for line in b.lines:
                    m = TABLE_ROW.match(line)
                    if not m or is_separator(m.group(1)):
                        continue
                    c = cells(m.group(1))
                    if len(c) < 3 or not pat.match(clean(c[0])):
                        continue
                    ident = clean(c[0])
                    self.add(Requirement(
                        id=f"REQ-{prefix}-{ident}",
                        prd_section=str(section),
                        prd_anchor=f"{ident}",
                        statement=" | ".join(clean(x) for x in c[1:] if clean(x))[:900],
                        type=rtype,
                        epic=epic,
                        priority=priority,
                        verification={"method": list(methods), "artifacts": []},
                    ))

    def assumptions(self, blocks: list[Block]) -> None:
        pat = re.compile(r"^\s*[-*]\s+(A\d+)\s*(.*)$")
        for b in (b for b in blocks if b.section == 65):
            for line in b.lines:
                m = pat.match(line)
                if not m:
                    continue
                self.add(Requirement(
                    id=f"REQ-ASM-{m.group(1)}",
                    prd_section="65",
                    prd_anchor=m.group(1),
                    statement=clean(m.group(2)).lstrip("—– ").strip(),
                    type="assumption",
                    epic="E0",
                    priority="should" if "VALIDATE" in line else "may",
                    verification={"method": ["review"], "artifacts": []},
                ))

    def quality_bar(self, blocks: list[Block]) -> None:
        for b in (b for b in blocks if b.section == 67):
            for line in b.lines:
                m = TABLE_ROW.match(line)
                if not m or is_separator(m.group(1)):
                    continue
                c = cells(m.group(1))
                if len(c) < 2 or c[0].startswith("Property"):
                    continue
                prop, test = clean(c[0]), clean(c[1])
                if not prop:
                    continue
                self.add(Requirement(
                    id=f"REQ-QB-{slug(prop, 20)}",
                    prd_section="67",
                    prd_anchor=prop,
                    statement=f"{prop}: {test}",
                    type="quality",
                    epic="E0",
                    priority="must",
                    verification={"method": ["e2e_test", "manual"], "artifacts": []},
                ))

    # -- normative prose ---------------------------------------------------
    SKIP_SECTIONS = {1, 2, 45, 46, 49, 55, 56, 59, 60, 61, 62, 63, 64, 65, 66, 67, 68}

    def prose(self, blocks: list[Block]) -> None:
        for b in blocks:
            if b.section in self.SKIP_SECTIONS:
                continue
            prefix = prefix_for(b.section)
            for line in b.lines:
                if not line.strip() or line.strip().startswith("#"):
                    continue
                if TABLE_ROW.match(line) and is_separator(TABLE_ROW.match(line).group(1)):
                    continue
                source_lines = ([clean(x) for x in cells(TABLE_ROW.match(line).group(1))]
                                if TABLE_ROW.match(line) else [line])
                for chunk in source_lines:
                    for sent in sentences(clean(chunk)):
                        if len(sent) < 30 or len(sent) > 500:
                            continue
                        if NON_NORMATIVE_HINTS.search(sent):
                            continue
                        hard = bool(HARD_RE.search(sent))
                        soft = bool(SOFT_RE.search(sent))
                        if not (hard or soft):
                            continue
                        self.add(Requirement(
                            id=self.next_id(prefix),
                            prd_section=b.subsection,
                            prd_anchor=b.title,
                            statement=sent,
                            type="invariant" if hard else "behavior",
                            epic=epic_for(b.section),
                            priority="must" if hard else "should",
                            verification={"method": [], "artifacts": []},
                        ))

    # -- context backfill ---------------------------------------------------
    def context(self, blocks: list[Block]) -> None:
        """Guarantee HANDOFF §3.1 rule: every PRD section yields at least one entry."""
        covered = {r.prd_section.split(".")[0] for r in self.reqs}
        for b in blocks:
            if str(b.section) in covered:
                continue
            covered.add(str(b.section))
            self.add(Requirement(
                id=f"REQ-CTX-{b.section:02d}",
                prd_section=str(b.section),
                prd_anchor=b.title,
                statement=f"PRD §{b.section} ({b.title}) is narrative context. Reviewed for "
                          f"normative content; any normative statement found here must be "
                          f"promoted to its own requirement before the owning epic closes.",
                type="context",
                epic=epic_for(b.section),
                priority="may",
                verification={"method": ["review"], "artifacts": []},
            ))


TENANCY_TABLES = {
    "organizations", "workspaces", "users", "workspace_members", "ethical_walls",
    "audit_events", "api_keys", "sessions",
}


# --------------------------------------------------------------------------
# YAML emission (hand-rolled: no dependency, stable ordering, readable diffs)
# --------------------------------------------------------------------------

def yq(s: str) -> str:
    """Quote a scalar for YAML."""
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'


def block_scalar(s: str, indent: str) -> str:
    words, lines, cur = s.split(), [], ""
    for w in words:
        if len(cur) + len(w) + 1 > 88:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    body = "\n".join(indent + ln for ln in lines)
    return ">\n" + body


def emit(reqs: list[Requirement], out: io.TextIOBase) -> None:
    out.write("# Casefile requirements database — the verification index.\n")
    out.write("# Generated by traceability/extract.py; hand-completed per HANDOFF.md §3.2.\n")
    out.write("# Nothing is considered built until its entry here has a passing verification.\n")
    out.write("#\n")
    out.write("# status: not_started | in_progress | implemented | verified | deviated | waived\n")
    out.write("#   NOTE: 'implemented' is not a valid resting state. CI fails on it.\n")
    out.write("---\n")
    for r in reqs:
        d = asdict(r)
        out.write(f"- id: {d['id']}\n")
        out.write(f"  prd_section: {yq(str(d['prd_section']))}\n")
        out.write(f"  prd_anchor: {yq(d['prd_anchor'])}\n")
        out.write(f"  statement: {block_scalar(d['statement'], '    ')}\n")
        out.write(f"  type: {d['type']}\n")
        if d["invariant_ref"]:
            out.write(f"  invariant_ref: {d['invariant_ref']}\n")
        out.write(f"  epic: {d['epic']}\n")
        out.write(f"  priority: {d['priority']}\n")
        out.write("  verification:\n")
        methods = d["verification"].get("method", [])
        arts = d["verification"].get("artifacts", [])
        out.write(f"    method: [{', '.join(methods)}]\n")
        if arts:
            out.write("    artifacts:\n")
            for a in arts:
                out.write(f"      - {a}\n")
        else:
            out.write("    artifacts: []\n")
        out.write(f"  status: {d['status']}\n")
        out.write(f"  verified_at: {yq(d['verified_at']) if d['verified_at'] else 'null'}\n")
        out.write(f"  notes: {yq(d['notes'])}\n")


# --------------------------------------------------------------------------
# Merge: never clobber hand-authored state on re-run
# --------------------------------------------------------------------------

# `epic` is deliberately NOT preserved. The extractor owns epic assignment for
# generated requirements — that is the whole point of API_OWNER and EVENT_OWNER above,
# and preserving a stale assignment would silently defeat the remap. Hand-authored
# requirements keep their own epic because they live in manual.yaml, which the
# extractor never touches.
PRESERVE_KEYS = ("status", "verified_at", "notes", "priority")


def load_existing(path: Path) -> dict[str, dict[str, str]]:
    """Minimal reader for the fields we must preserve. Deliberately not a YAML parser."""
    if not path.exists():
        return {}
    out: dict[str, dict[str, str]] = {}
    cur_id, cur, artifacts, in_arts = None, {}, [], False
    for raw in path.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^- id:\s*(\S+)", raw)
        if m:
            if cur_id:
                cur["artifacts"] = artifacts
                out[cur_id] = cur
            cur_id, cur, artifacts, in_arts = m.group(1), {}, [], False
            continue
        if cur_id is None:
            continue
        if re.match(r"^\s*artifacts:\s*$", raw):
            in_arts = True
            continue
        if in_arts:
            ma = re.match(r"^\s*-\s*(\S.*)$", raw)
            if ma:
                artifacts.append(ma.group(1).strip())
                continue
            in_arts = False
        for k in PRESERVE_KEYS:
            mk = re.match(rf"^\s*{k}:\s*(.*)$", raw)
            if mk:
                v = mk.group(1).strip()
                if v.startswith('"') and v.endswith('"'):
                    v = v[1:-1]
                cur[k] = v
        mm = re.match(r"^\s*method:\s*\[(.*)\]\s*$", raw)
        if mm:
            cur["method"] = mm.group(1)
        elif re.match(r"^\s*method:\s*$", raw):
            pass
    if cur_id:
        cur["artifacts"] = artifacts
        out[cur_id] = cur
    return out


def merge_preserving(reqs: list[Requirement], existing: dict[str, dict]) -> tuple[list[Requirement], int]:
    kept = 0
    for r in reqs:
        prev = existing.get(r.id)
        if not prev:
            continue
        kept += 1
        for k in PRESERVE_KEYS:
            if k in prev and prev[k] not in ("", "null"):
                setattr(r, k, prev[k])
        if prev.get("artifacts"):
            r.verification["artifacts"] = prev["artifacts"]
        if prev.get("method"):
            r.verification["method"] = [m.strip() for m in prev["method"].split(",") if m.strip()]
        if r.verified_at in ("null", ""):
            r.verified_at = None
    return reqs, kept


# --------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser(description="Extract the Casefile requirements database from the PRD.")
    ap.add_argument("prd", type=Path)
    ap.add_argument("--out", type=Path, default=Path("traceability/requirements.yaml"))
    ap.add_argument("--stdout", action="store_true")
    ap.add_argument("--stats", action="store_true")
    args = ap.parse_args()

    if not args.prd.exists():
        print(f"PRD not found: {args.prd}", file=sys.stderr)
        return 2

    blocks = parse_blocks(args.prd.read_text(encoding="utf-8"))

    ex = Extractor()
    ex.invariants()
    ex.stories(blocks)
    ex.acceptance(blocks)
    ex.schema(blocks)
    ex.api(blocks)
    ex.events(blocks)
    ex.rbac(blocks)
    ex.ai_evals(blocks)
    ex.perf(blocks)
    ex.tools(blocks)
    ex.governance(blocks)
    ex.assumptions(blocks)
    ex.quality_bar(blocks)
    ex.prose(blocks)
    ex.context(blocks)

    reqs = ex.reqs

    # ---- E0 orphan check -------------------------------------------------
    # A mappable type in E0 is unowned: `pnpm doneness` runs per epic and never inspects
    # E0, so the requirement is invisible to every gate that would otherwise chase it.
    # AC-PERF-* is the one sanctioned exception (whole-system §53.5 measurement).
    orphans = [r for r in reqs
               if r.epic == "E0"
               and r.type in MAPPABLE_TYPES
               and not r.id.startswith("REQ-AC-PERF-")]
    if orphans:
        print(f"FATAL: {len(orphans)} mappable requirements have no owning epic.",
              file=sys.stderr)
        by_type: dict[str, list[str]] = {}
        for r in orphans:
            by_type.setdefault(r.type, []).append(r.id)
        for t in sorted(by_type):
            ids = by_type[t]
            print(f"  {t:<12} {len(ids):>4}  e.g. {', '.join(ids[:5])}", file=sys.stderr)
        print("\nAdd each to the relevant map (STORY_EPIC, AC_EPIC, SCHEMA_EPIC, "
              "PERF_EPIC,\nAPI_OWNER, EVENT_OWNER). E0 is for cross-cutting governance "
              "only — never a\nfallback for something an epic should own.", file=sys.stderr)
        return 2

    kept = 0
    if not args.stdout:
        reqs, kept = merge_preserving(reqs, load_existing(args.out))

    by_type: dict[str, int] = {}
    by_epic: dict[str, int] = {}
    for r in reqs:
        by_type[r.type] = by_type.get(r.type, 0) + 1
        by_epic[r.epic] = by_epic.get(r.epic, 0) + 1

    if args.stats:
        print(f"blocks parsed : {len(blocks)}")
        print(f"requirements  : {len(reqs)}")
        print("\nby type:")
        for k in sorted(by_type, key=lambda x: -by_type[x]):
            print(f"  {k:<14} {by_type[k]:>5}")
        print("\nby epic:")
        for k in sorted(by_epic):
            print(f"  {k:<5} {by_epic[k]:>5}")
        return 0

    if args.stdout:
        emit(reqs, sys.stdout)
        return 0

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as fh:
        emit(reqs, fh)

    print(f"wrote {args.out}: {len(reqs)} requirements "
          f"({kept} existing entries preserved)", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
