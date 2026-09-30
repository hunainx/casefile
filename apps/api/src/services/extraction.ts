import type { ExtractionItem } from "@casefile/contracts";

export interface VerifiedExtractionItem {
  item: ExtractionItem;
  verified: boolean;
  discard_reason?: string;
  actual_start?: number;
  actual_end?: number;
}

/**
 * Invariant I9 Quote Verification Engine (PRD §5.2 Stage 5, Invariant I9)
 *
 * "An extraction whose quoted span does not verify is discarded, not stored."
 */
export function verifyExtractionQuotes(
  sourceText: string,
  items: ExtractionItem[],
): { verifiedItems: VerifiedExtractionItem[]; discardedCount: number } {
  const verifiedItems: VerifiedExtractionItem[] = [];
  let discardedCount = 0;

  for (const item of items) {
    const quotedSpan = item.quoted_span.trim();
    if (!quotedSpan) {
      verifiedItems.push({
        item,
        verified: false,
        discard_reason: "empty_quoted_span",
      });
      discardedCount++;
      continue;
    }

    // Check exact span at given offset
    const sliceAtOffset = sourceText.slice(item.char_start, item.char_end).trim();
    if (sliceAtOffset.toLowerCase() === quotedSpan.toLowerCase()) {
      verifiedItems.push({
        item,
        verified: true,
        actual_start: item.char_start,
        actual_end: item.char_end,
      });
      continue;
    }

    // Fallback: search anywhere in sourceText
    const foundIdx = sourceText.toLowerCase().indexOf(quotedSpan.toLowerCase());
    if (foundIdx !== -1) {
      verifiedItems.push({
        item,
        verified: true,
        actual_start: foundIdx,
        actual_end: foundIdx + quotedSpan.length,
      });
    } else {
      // Invariant I9: Discard extraction because quoted span does not verify against source text
      verifiedItems.push({
        item,
        verified: false,
        discard_reason: "quoted_span_not_found_in_source (Invariant I9 violation)",
      });
      discardedCount++;
    }
  }

  return { verifiedItems, discardedCount };
}
