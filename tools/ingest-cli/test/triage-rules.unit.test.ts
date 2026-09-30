import { describe, it, expect } from "vitest";

/**
 * BIGDATA-3 triage rules as pure functions (D99, D102): the junk names (answer 3: the listed names
 * and 0-byte files, nothing else), the filters the case owner chooses per run (answer 5), and what
 * each filter decides. Loaded per test, so each rule fails on its own until it exists.
 */
const rules = () => import("../src/triage-rules.js");

describe("BIGDATA-3 junk rules", () => {
  it("each listed name is junk, in any case: Thumbs.db, .DS_Store, desktop.ini, ~$ lock files, ~*.tmp temp files, LibreOffice .~lock.*#", async () => {
    const { junkRule } = await rules();
    for (const name of ["Thumbs.db", "THUMBS.DB", ".DS_Store", ".ds_store", "desktop.ini", "Desktop.INI", "~$Budget 2021.docx", "~$x.xlsx", "~WRL0001.tmp", "~WRD0042.tmp", "~DF1A2B.TMP", "~anything.tmp", ".~lock.report.odt#"]) {
      expect(junkRule(name, 10), name).toEqual({ rule: "junk-name", version: 1, reason: expect.stringContaining("junk file name") });
    }
  });

  it("names that only look like junk are not junk", async () => {
    const { junkRule } = await rules();
    for (const name of ["Thumbs.db.txt", "my Thumbs.db", "notes.tmp", "desktop.ini.bak", "budget~$.docx", "report~WRL.tmp.txt", ".DS_Store.txt", "~$", ".~lock.report.odt", "tmp"]) {
      expect(junkRule(name, 10), name).toBeNull();
    }
  });

  it("a 0-byte file is junk whatever its name; a 1-byte file is not", async () => {
    const { junkRule } = await rules();
    expect(junkRule("contract.pdf", 0)).toEqual({ rule: "junk-empty", version: 1, reason: "empty file (0 bytes)" });
    expect(junkRule("contract.pdf", 1)).toBeNull();
    expect(junkRule("Thumbs.db", 0)).toMatchObject({ rule: "junk-name" });
  });

  it("the documented list is the list in the code", async () => {
    const { JUNK_NAME_PATTERNS } = await rules();
    expect(JUNK_NAME_PATTERNS.map((p) => p.label)).toEqual(["Thumbs.db", ".DS_Store", "desktop.ini", "~$* (Office owner/lock file)", "~*.tmp (Office and Windows temp file, e.g. ~WRL0001.tmp, ~WRD0042.tmp, ~DF1A2B.tmp)", ".~lock.*# (LibreOffice lock file)"]);
  });
});

describe("BIGDATA-3 filters", () => {
  it("parses the CLI flags; the default is no filter; bad dates and an empty window are refused", async () => {
    const { parseFilterArgs, filtersToRecord } = await rules();
    expect(filtersToRecord(parseFilterArgs([]))).toEqual({});
    const f = parseFilterArgs(["--email-date-from", "2020-01-01", "--email-date-to", "2022-12-31", "--file-date-from", "2019-05-01", "--person", "a@x.example", "--person", "Nyra Pell", "--exclude-person", "news@y.example"]);
    expect(filtersToRecord(f)).toEqual({ email_date_from: "2020-01-01", email_date_to: "2022-12-31", file_date_from: "2019-05-01", persons: ["a@x.example", "Nyra Pell"], exclude_persons: ["news@y.example"] });
    expect(() => parseFilterArgs(["--email-date-from", "2020-13-01"])).toThrow(/YYYY-MM-DD/);
    expect(() => parseFilterArgs(["--file-date-from", "yesterday"])).toThrow(/YYYY-MM-DD/);
    expect(() => parseFilterArgs(["--email-date-from", "2022-01-02", "--email-date-to", "2022-01-01"])).toThrow(/after/);
    expect(() => parseFilterArgs(["--person"])).toThrow(/--person/);
  });

  it("email date: whole UTC days, both ends included; an unknown date is kept", async () => {
    const { emailFilterDecision } = await rules();
    const f = { emailDateFrom: "2020-01-01", emailDateTo: "2020-12-31" };
    const h = (date?: string) => ({ from: "a@x.example", to: "b@x.example", date });
    expect(emailFilterDecision(h("2020-01-01T00:00:00.000Z"), f)).toEqual({ skip: false });
    expect(emailFilterDecision(h("2020-12-31T23:59:59.999Z"), f)).toEqual({ skip: false });
    expect(emailFilterDecision(h("2019-12-31T23:59:59.999Z"), f)).toMatchObject({ skip: true, rule: "email-date", filter: { email_date_from: "2020-01-01", email_date_to: "2020-12-31", value: "2019-12-31T23:59:59.999Z" } });
    expect(emailFilterDecision(h("2021-01-01T00:00:00.000Z"), f)).toMatchObject({ skip: true, rule: "email-date" });
    expect(emailFilterDecision(h(undefined), f)).toEqual({ skip: false, reason: "email date unknown: kept" });
    expect(emailFilterDecision(h("not a date"), f)).toEqual({ skip: false, reason: "email date unknown: kept" });
  });

  it("person and exclude-person: From, To and Cc, as text containing the person, ignoring case", async () => {
    const { emailFilterDecision } = await rules();
    const h = { from: "Nyra Pell <nyra@delta.example>", to: "eli@beta.example", cc: "Watcher <WATCH@gamma.example>" };
    expect(emailFilterDecision(h, { persons: ["nyra pell"] })).toEqual({ skip: false });
    expect(emailFilterDecision(h, { persons: ["watch@gamma.example"] })).toEqual({ skip: false });
    expect(emailFilterDecision(h, { persons: ["beta.example"] })).toEqual({ skip: false });
    expect(emailFilterDecision(h, { persons: ["someone@else.example"] })).toMatchObject({ skip: true, rule: "person", filter: { persons: ["someone@else.example"] } });
    expect(emailFilterDecision(h, { excludePersons: ["delta.example"] })).toMatchObject({ skip: true, rule: "exclude-person", filter: { exclude_persons: ["delta.example"], matched: "delta.example" } });
    expect(emailFilterDecision(h, { excludePersons: ["omega.example"] })).toEqual({ skip: false });
  });

  it("BIGDATA-4 (owner's answer 2): person and exclude-person also look at Bcc, as rule version 2", async () => {
    const { emailFilterDecision, RULE_VERSIONS } = await rules();
    const h = { from: "sender@delta.example", to: "eli@beta.example", cc: "", bcc: "Quiet Reader <quiet@omega.example>" };
    // Only in Bcc: version 1 skipped this email for --person and kept it for --exclude-person.
    expect(emailFilterDecision(h, { persons: ["quiet@omega.example"] })).toEqual({ skip: false });
    expect(RULE_VERSIONS.person).toBe(2);
    expect(RULE_VERSIONS["exclude-person"]).toBe(2);
    expect(emailFilterDecision(h, { persons: ["quiet reader"] })).toEqual({ skip: false });
    expect(emailFilterDecision(h, { excludePersons: ["omega.example"] })).toMatchObject({ skip: true, rule: "exclude-person", version: 2, reason: expect.stringContaining("Bcc") });
    expect(emailFilterDecision(h, { persons: ["nobody@else.example"] })).toMatchObject({ skip: true, rule: "person", version: 2, reason: expect.stringContaining("Bcc") });
    // An email with no Bcc header is judged exactly as before.
    expect(emailFilterDecision({ from: "a@x.example", to: "b@y.example" }, { persons: ["b@y.example"] })).toEqual({ skip: false });
  });

  it("file date: whole UTC days; an unknown file date is kept; with no file-date filter nothing is judged", async () => {
    const { fileDateDecision } = await rules();
    const f = { fileDateFrom: "2020-01-01", fileDateTo: "2020-06-30" };
    expect(fileDateDecision(new Date("2020-03-03T00:00:00Z"), f)).toEqual({ skip: false });
    expect(fileDateDecision(new Date("2019-03-03T00:00:00Z"), f)).toMatchObject({ skip: true, rule: "file-date", filter: { file_date_from: "2020-01-01", file_date_to: "2020-06-30", value: "2019-03-03T00:00:00.000Z" } });
    expect(fileDateDecision(new Date("2020-07-01T00:00:00Z"), f)).toMatchObject({ skip: true, rule: "file-date" });
    expect(fileDateDecision(null, f)).toEqual({ skip: false, reason: "file date unknown: kept" });
    expect(fileDateDecision(null, {})).toEqual({ skip: false });
  });
});
