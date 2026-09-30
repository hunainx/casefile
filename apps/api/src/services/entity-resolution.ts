import type {
  Entity,
  EntityIdentifier,
  MergeBand,
  MergeSignalBreakdown,
} from "@casefile/contracts";

/**
 * Jaro-Winkler String Distance Metric
 */
export function jaroWinkler(s1: string, s2: string): number {
  const str1 = s1.toLowerCase().trim();
  const str2 = s2.toLowerCase().trim();

  if (str1 === str2) return 1.0;
  if (str1.length === 0 || str2.length === 0) return 0.0;

  const matchWindow = Math.floor(Math.max(str1.length, str2.length) / 2) - 1;
  const str1Matches = new Array(str1.length).fill(false);
  const str2Matches = new Array(str2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < str1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, str2.length);

    for (let j = start; j < end; j++) {
      if (str2Matches[j] || str1[i] !== str2[j]) continue;
      str1Matches[i] = true;
      str2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  let k = 0;
  for (let i = 0; i < str1.length; i++) {
    if (!str1Matches[i]) continue;
    while (!str2Matches[k]) k++;
    if (str1[i] !== str2[k]) transpositions++;
    k++;
  }

  const jaro =
    (matches / str1.length +
      matches / str2.length +
      (matches - transpositions / 2) / matches) /
    3.0;

  // Prefix bonus
  let prefix = 0;
  const maxPrefix = Math.min(4, Math.min(str1.length, str2.length));
  for (let i = 0; i < maxPrefix; i++) {
    if (str1[i] === str2[i]) prefix++;
    else break;
  }

  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Normalizes corporate and organization names per PRD §15.2
 */
export function normalizeEntityName(name: string, type: string): string {
  let cleaned = name.trim().toLowerCase();

  if (type === "Organization") {
    cleaned = cleaned
      .replace(/\b(limited|ltd\.?)\b/gi, "ltd")
      .replace(/\b(corporation|corp\.?)\b/gi, "corp")
      .replace(/\b(incorporated|inc\.?)\b/gi, "inc")
      .replace(/\b(public limited company|plc\.?)\b/gi, "plc")
      .replace(/\b(llc|l\.l\.c\.)\b/gi, "llc")
      .replace(/\b(gmbh|g\.m\.b\.h\.)\b/gi, "gmbh")
      .replace(/\b(s\.?a\.?|societe anonyme)\b/gi, "sa")
      .replace(/[.,\-_/]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  } else if (type === "Person") {
    cleaned = cleaned
      .replace(/\b(mr|mrs|ms|dr|prof|sir|dame|lord|lady)\.?\b/gi, "")
      .replace(/[.,\-_/]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  return cleaned;
}

export interface MatchEvaluationResult {
  score: number;
  match_band: MergeBand;
  signals: MergeSignalBreakdown[];
  has_conflicting_identifiers: boolean;
  conflict_reason?: string | undefined;
  is_person_match: boolean;
  can_auto_merge: boolean;
}

/**
 * Multi-Signal Entity Resolution Matcher (PRD §15.4 / §56.5 AC-RES-01..05)
 */
export function evaluateEntityPair(
  a: Entity & { identifiers?: EntityIdentifier[] },
  b: Entity & { identifiers?: EntityIdentifier[] },
): MatchEvaluationResult {
  const signals: MergeSignalBreakdown[] = [];
  let hasConflictingIdentifiers = false;
  let conflictReason: string | undefined;

  const idsA = a.identifiers || [];
  const idsB = b.identifiers || [];

  // 1. Strong Identifier Matching & Conflict Detection (PRD §15.4, AC-RES-02)
  let strongIdentifierMatch = false;
  for (const idA of idsA) {
    for (const idB of idsB) {
      if (idA.scheme === idB.scheme) {
        const valA = idA.value.trim().toLowerCase();
        const valB = idB.value.trim().toLowerCase();
        const jurA = (idA.jurisdiction || "").trim().toLowerCase();
        const jurB = (idB.jurisdiction || "").trim().toLowerCase();

        const sameJurisdiction = !jurA || !jurB || jurA === jurB;

        if (valA === valB && sameJurisdiction) {
          strongIdentifierMatch = true;
          signals.push({
            signal: "exact_strong_identifier",
            value: `${idA.scheme}: ${idA.value}${idA.jurisdiction ? ` (${idA.jurisdiction})` : ""}`,
            weight: 1.0,
            contribution: 1.0,
            is_negative: false,
            description: `Exact match on identifier scheme '${idA.scheme}'.`,
          });
        } else if (valA !== valB && sameJurisdiction && (idA.is_strong || idB.is_strong || idA.scheme === "company_number" || idA.scheme === "national_id" || idA.scheme === "passport")) {
          hasConflictingIdentifiers = true;
          conflictReason = `Conflicting ${idA.scheme} identifiers in same jurisdiction: '${idA.value}' vs '${idB.value}'`;
          signals.push({
            signal: "conflicting_strong_identifier",
            value: `${idA.scheme}: '${idA.value}' vs '${idB.value}'`,
            weight: -1.0,
            contribution: -1.0,
            is_negative: true,
            description: conflictReason,
          });
        }
      }
    }
  }

  // 2. Name Similarity (Jaro-Winkler)
  const normA = normalizeEntityName(a.canonical_name, a.type);
  const normB = normalizeEntityName(b.canonical_name, b.type);
  const nameSim = jaroWinkler(normA, normB);

  signals.push({
    signal: "name_similarity_jaro_winkler",
    value: `${a.canonical_name} ~ ${b.canonical_name} (${nameSim.toFixed(3)})`,
    weight: 0.35,
    contribution: Number((nameSim * 0.35).toFixed(4)),
    is_negative: false,
    description: "Normalized Jaro-Winkler name similarity score.",
  });

  // 3. Aliases Cross-Check
  const aliasesA = (a.aliases || []).map((x) => normalizeEntityName(x.value, a.type));
  const aliasesB = (b.aliases || []).map((x) => normalizeEntityName(x.value, b.type));

  let maxAliasSim = 0;
  for (const aliasA of [normA, ...aliasesA]) {
    for (const aliasB of [normB, ...aliasesB]) {
      const sim = jaroWinkler(aliasA, aliasB);
      if (sim > maxAliasSim) maxAliasSim = sim;
    }
  }

  if (maxAliasSim > nameSim) {
    signals.push({
      signal: "alias_match",
      value: `Cross-alias peak similarity (${maxAliasSim.toFixed(3)})`,
      weight: 0.25,
      contribution: Number(((maxAliasSim - nameSim) * 0.25).toFixed(4)),
      is_negative: false,
      description: "Match detected between entity aliases.",
    });
  }

  // 4. Type Incompatibility
  if (a.type !== b.type) {
    signals.push({
      signal: "incompatible_types",
      value: `${a.type} != ${b.type}`,
      weight: -1.0,
      contribution: -1.0,
      is_negative: true,
      description: "Entities have different fundamental types.",
    });
  }

  // Compute final composite score
  let totalScore: number;
  if (a.type !== b.type) {
    totalScore = 0.0;
  } else if (hasConflictingIdentifiers) {
    totalScore = 0.0;
  } else if (strongIdentifierMatch) {
    totalScore = 1.0;
  } else {
    totalScore = Math.min(1.0, Math.max(0.0, nameSim * 0.65 + (maxAliasSim > 0.9 ? 0.35 : 0)));
  }

  // Classification Band (PRD §15.5)
  let band: MergeBand = "no_match";
  if (hasConflictingIdentifiers) {
    band = "no_match";
  } else if (strongIdentifierMatch || totalScore >= 0.95) {
    band = "deterministic";
  } else if (totalScore >= 0.85) {
    band = "high";
  } else if (totalScore >= 0.60) {
    band = "medium";
  } else if (totalScore >= 0.40) {
    band = "low";
  }

  const isPerson = a.type === "Person" || b.type === "Person";
  // PRD §15.5 / AC-RES-01: Auto-merge ONLY allowed for deterministic non-Person matches
  const canAutoMerge = band === "deterministic" && !isPerson && !hasConflictingIdentifiers;

  return {
    score: totalScore,
    match_band: band,
    signals,
    has_conflicting_identifiers: hasConflictingIdentifiers,
    conflict_reason: conflictReason,
    is_person_match: isPerson,
    can_auto_merge: canAutoMerge,
  };
}
