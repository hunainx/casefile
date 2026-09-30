/**
 * BIGDATA-3 triage rules, as pure functions (docs/PLAN-BIG-DATA.md section 2 and section 14).
 * Deterministic code run by the operator, never an AI tool (PRD §60 Class E is unchanged); it
 * only decides, and triage.ts records what it decides. Nothing here reads or writes a bucket.
 *
 * Each rule has an id and a version, recorded on every decision and, all together, on the run,
 * so a report can say which version of which rule made each decision.
 */

export const RULE_VERSIONS = {
  "junk-name": 1,
  "junk-empty": 1,
  "exact-duplicate": 1,
  "near-duplicate": 1,
  "email-date": 1,
  "file-date": 1,
  /** BIGDATA-4 (owner's answer 2): version 2 also looks at Bcc; version 1 looked at From, To and Cc. */
  person: 2,
  "exclude-person": 2,
  "pipeline-sidecar": 1,
  "not-a-file": 1,
  reinclude: 1,
  /** BIGDATA-3B (D111): a message of a mailbox that is the same message as one the investigation holds. */
  "message-duplicate": 1,
} as const;
export type RuleId = keyof typeof RULE_VERSIONS;

export type DecisionKind = "ingest" | "skip-junk" | "skip-duplicate" | "skip-filter";

/** The filter that caught an object, as recorded on its decision (JSON). */
export type FilterRecord = Record<string, string | string[]>;

// ── Junk (answer 3: the listed names and 0-byte files only; no hash lists) ─────

/**
 * The junk names, matched against the file name (not the folder), ignoring case. The same list
 * is in docs/RUNBOOK-INGEST.md; triage-rules.unit.test.ts checks this list against it.
 */
export const JUNK_NAME_PATTERNS: ReadonlyArray<{ label: string; test: (lowerName: string) => boolean }> = [
  { label: "Thumbs.db", test: (n) => n === "thumbs.db" },
  { label: ".DS_Store", test: (n) => n === ".ds_store" },
  { label: "desktop.ini", test: (n) => n === "desktop.ini" },
  { label: "~$* (Office owner/lock file)", test: (n) => n.startsWith("~$") && n.length > 2 },
  { label: "~*.tmp (Office and Windows temp file, e.g. ~WRL0001.tmp, ~WRD0042.tmp, ~DF1A2B.tmp)", test: (n) => n.startsWith("~") && n.endsWith(".tmp") && n.length > 5 },
  { label: ".~lock.*# (LibreOffice lock file)", test: (n) => n.startsWith(".~lock.") && n.endsWith("#") && n.length > 8 },
];

export interface RuleHit {
  rule: RuleId;
  version: number;
  reason: string;
}

/** The junk rule a file falls under, or null. A listed name wins over the empty-file rule. */
export function junkRule(fileName: string, byteSize: number): RuleHit | null {
  const lower = fileName.toLowerCase();
  const hit = JUNK_NAME_PATTERNS.find((p) => p.test(lower));
  if (hit) return { rule: "junk-name", version: RULE_VERSIONS["junk-name"], reason: `junk file name (${fileName})` };
  if (byteSize === 0) return { rule: "junk-empty", version: RULE_VERSIONS["junk-empty"], reason: "empty file (0 bytes)" };
  return null;
}

// ── Filters (answer 5: chosen by the case owner per run; default none) ─────────

export interface TriageFilters {
  emailDateFrom?: string | undefined;
  emailDateTo?: string | undefined;
  fileDateFrom?: string | undefined;
  fileDateTo?: string | undefined;
  persons?: string[] | undefined;
  excludePersons?: string[] | undefined;
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A YYYY-MM-DD day as a UTC time: the start of the day, or (end) its last millisecond. */
function dayBound(day: string, flag: string, end: boolean): number {
  const m = DAY.exec(day);
  const t = m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  if (!m || Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== day) {
    throw new Error(`${flag} must be a date written YYYY-MM-DD (got "${day}")`);
  }
  return end ? t + 24 * 3600 * 1000 - 1 : t;
}

/**
 * The filter flags of `pnpm ingest` (repeatable --person / --exclude-person). Everything else in
 * argv is ignored here. Throws on a malformed date or an empty window, so a mistyped filter stops
 * the run before anything is recorded.
 */
export function parseFilterArgs(argv: readonly string[]): TriageFilters {
  const f: TriageFilters = {};
  const value = (i: number, flag: string) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--email-date-from") f.emailDateFrom = value(i++, a);
    else if (a === "--email-date-to") f.emailDateTo = value(i++, a);
    else if (a === "--file-date-from") f.fileDateFrom = value(i++, a);
    else if (a === "--file-date-to") f.fileDateTo = value(i++, a);
    else if (a === "--person") (f.persons ??= []).push(value(i++, a));
    else if (a === "--exclude-person") (f.excludePersons ??= []).push(value(i++, a));
  }
  validateFilters(f);
  return f;
}

export function validateFilters(f: TriageFilters): void {
  const pair = (from: string | undefined, to: string | undefined, name: string) => {
    const a = from !== undefined ? dayBound(from, `--${name}-from`, false) : undefined;
    const b = to !== undefined ? dayBound(to, `--${name}-to`, true) : undefined;
    if (a !== undefined && b !== undefined && a > b) throw new Error(`--${name}-from (${from}) is after --${name}-to (${to}): nothing could pass`);
  };
  pair(f.emailDateFrom, f.emailDateTo, "email-date");
  pair(f.fileDateFrom, f.fileDateTo, "file-date");
  for (const p of [...(f.persons ?? []), ...(f.excludePersons ?? [])]) {
    if (p.trim() === "") throw new Error("--person and --exclude-person need a non-empty value");
  }
}

/** The filters as recorded on the run (ingest_runs.filters): only what the owner set; {} = none. */
export function filtersToRecord(f: TriageFilters): Record<string, string | string[]> {
  const r: Record<string, string | string[]> = {};
  if (f.emailDateFrom !== undefined) r.email_date_from = f.emailDateFrom;
  if (f.emailDateTo !== undefined) r.email_date_to = f.emailDateTo;
  if (f.fileDateFrom !== undefined) r.file_date_from = f.fileDateFrom;
  if (f.fileDateTo !== undefined) r.file_date_to = f.fileDateTo;
  if (f.persons?.length) r.persons = [...f.persons];
  if (f.excludePersons?.length) r.exclude_persons = [...f.excludePersons];
  return r;
}

/** The filters again from what the run recorded (BIGDATA-4: every worker of a run reads them from the run). */
export function recordToFilters(r: Record<string, string | string[] | undefined>): TriageFilters {
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);
  const many = (v: string | string[] | undefined) => (Array.isArray(v) ? [...v] : undefined);
  const f: TriageFilters = {};
  if (one(r.email_date_from) !== undefined) f.emailDateFrom = one(r.email_date_from);
  if (one(r.email_date_to) !== undefined) f.emailDateTo = one(r.email_date_to);
  if (one(r.file_date_from) !== undefined) f.fileDateFrom = one(r.file_date_from);
  if (one(r.file_date_to) !== undefined) f.fileDateTo = one(r.file_date_to);
  if (many(r.persons)?.length) f.persons = many(r.persons);
  if (many(r.exclude_persons)?.length) f.excludePersons = many(r.exclude_persons);
  return f;
}

export function hasEmailFilters(f: TriageFilters): boolean {
  return f.emailDateFrom !== undefined || f.emailDateTo !== undefined || Boolean(f.persons?.length) || Boolean(f.excludePersons?.length);
}

export function hasFileDateFilter(f: TriageFilters): boolean {
  return f.fileDateFrom !== undefined || f.fileDateTo !== undefined;
}

export type FilterDecision =
  | { skip: false; reason?: string }
  | { skip: true; rule: RuleId; version: number; reason: string; filter: FilterRecord };

export interface EmailHeaders {
  from?: string | undefined;
  to?: string | undefined;
  cc?: string | undefined;
  /** BIGDATA-4: read by the person filters from version 2 on (owner's answer 2). */
  bcc?: string | undefined;
  /** An ISO date, as the parsers give it, or anything else (then the date is unknown). */
  date?: string | undefined;
}

/**
 * What the email filters decide for one email. The order: the date window, then --person (keep
 * only emails with one of the people in From, To, Cc or Bcc), then --exclude-person. A person
 * matches when the From, To, Cc or Bcc text contains it, ignoring case: an address, a name, or a
 * part such as a domain. Bcc is read since rule version 2 (BIGDATA-4, owner's answer 2); a decision
 * made by version 1 keeps its version and is not changed. An email whose date is unknown is kept (a
 * filter hides evidence only when it can show why).
 */
export function emailFilterDecision(h: EmailHeaders, f: TriageFilters): FilterDecision {
  let kept: string | undefined;
  if (f.emailDateFrom !== undefined || f.emailDateTo !== undefined) {
    const t = h.date ? Date.parse(h.date) : NaN;
    if (Number.isNaN(t)) {
      kept = "email date unknown: kept";
    } else {
      const from = f.emailDateFrom !== undefined ? dayBound(f.emailDateFrom, "--email-date-from", false) : -Infinity;
      const to = f.emailDateTo !== undefined ? dayBound(f.emailDateTo, "--email-date-to", true) : Infinity;
      if (t < from || t > to) {
        const iso = new Date(t).toISOString();
        return {
          skip: true,
          rule: "email-date",
          version: RULE_VERSIONS["email-date"],
          reason: `email date ${iso} is outside the run's email date filter (${f.emailDateFrom ?? "any"} to ${f.emailDateTo ?? "any"})`,
          filter: { ...(f.emailDateFrom !== undefined ? { email_date_from: f.emailDateFrom } : {}), ...(f.emailDateTo !== undefined ? { email_date_to: f.emailDateTo } : {}), value: iso },
        };
      }
    }
  }
  const people = `${h.from ?? ""}\n${h.to ?? ""}\n${h.cc ?? ""}\n${h.bcc ?? ""}`.toLowerCase();
  if (f.persons?.length && !f.persons.some((p) => people.includes(p.toLowerCase()))) {
    return {
      skip: true,
      rule: "person",
      version: RULE_VERSIONS.person,
      reason: `none of the run's --person values is in From, To, Cc or Bcc`,
      filter: { persons: [...f.persons] },
    };
  }
  const excluded = f.excludePersons?.find((p) => people.includes(p.toLowerCase()));
  if (excluded !== undefined) {
    return {
      skip: true,
      rule: "exclude-person",
      version: RULE_VERSIONS["exclude-person"],
      reason: `"${excluded}" (--exclude-person) is in From, To, Cc or Bcc`,
      filter: { exclude_persons: [...f.excludePersons!], matched: excluded },
    };
  }
  return kept ? { skip: false, reason: kept } : { skip: false };
}

/** What the file-date filter decides for a file that is not an email. Unknown date: kept. */
export function fileDateDecision(fileDate: Date | null, f: TriageFilters): FilterDecision {
  if (!hasFileDateFilter(f)) return { skip: false };
  if (!fileDate || Number.isNaN(fileDate.getTime())) return { skip: false, reason: "file date unknown: kept" };
  const t = fileDate.getTime();
  const from = f.fileDateFrom !== undefined ? dayBound(f.fileDateFrom, "--file-date-from", false) : -Infinity;
  const to = f.fileDateTo !== undefined ? dayBound(f.fileDateTo, "--file-date-to", true) : Infinity;
  if (t >= from && t <= to) return { skip: false };
  const iso = fileDate.toISOString();
  return {
    skip: true,
    rule: "file-date",
    version: RULE_VERSIONS["file-date"],
    reason: `file date ${iso} is outside the run's file date filter (${f.fileDateFrom ?? "any"} to ${f.fileDateTo ?? "any"})`,
    filter: { ...(f.fileDateFrom !== undefined ? { file_date_from: f.fileDateFrom } : {}), ...(f.fileDateTo !== undefined ? { file_date_to: f.fileDateTo } : {}), value: iso },
  };
}

/** Emails are judged by their headers; every other file by its file date. */
export function isEmailName(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return lower.endsWith(".eml") || lower.endsWith(".msg");
}
