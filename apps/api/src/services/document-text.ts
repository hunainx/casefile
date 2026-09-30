/**
 * Text stored once (BIGDATA-2B, D94; docs/PLAN-BIG-DATA.md section 12).
 *
 * content_blocks.text is the one copy of a document's text. content_documents.full_text is
 * stored only when the blocks cannot give it back exactly; this is the one definition of
 * "give it back", used both when a document is written and when its text is read (the I9 quote
 * check of /extract reads it at exact character offsets, so an approximation would not do).
 */
export interface PositionedText {
  char_start: number;
  char_end: number;
  text: string;
}

/**
 * The document text the blocks describe: each block, in sequence order, placed at its
 * char_start, with every gap filled with "\n". Null when the blocks cannot describe one text
 * (a block starts before the previous one ends, or its offsets do not match its length).
 */
export function rebuildDocumentText(blocksInSequence: readonly PositionedText[]): string | null {
  let out = "";
  for (const b of blocksInSequence) {
    if (b.char_start < out.length || b.char_end - b.char_start !== b.text.length) return null;
    out += "\n".repeat(b.char_start - out.length) + b.text;
  }
  return out;
}

/** What to store in content_documents.full_text: null when the blocks give fullText back exactly. */
export function fullTextToStore(fullText: string, blocksInSequence: readonly PositionedText[]): string | null {
  return blocksInSequence.length > 0 && rebuildDocumentText(blocksInSequence) === fullText ? null : fullText;
}

/** A document's text for a reader: the stored full_text, or (text stored once) the rebuild. */
export function documentText(fullText: string | null, blocksInSequence: readonly PositionedText[]): string {
  return fullText ?? rebuildDocumentText(blocksInSequence) ?? "";
}
