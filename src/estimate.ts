/**
 * Token estimation without a tokenizer, ported verbatim from
 * fast-jev-compaction: a word costs one token per six letters, a digit half
 * a token, any other symbol nine tenths. Calibrated against the usage Jev
 * reports for real transcripts, where it lands 2–18% above the true count;
 * a plain characters-per-token ratio undercounts JSON-heavy states by up to
 * 40%.
 *
 * @module fast-compaction-dsh/estimate
 */

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g

/**
 * Estimate the token cost of one text.
 * @param text - the text to price.
 * @returns a conservative (over-)estimate in tokens.
 */
export function estimateTokens(text: string): number {
  let tokens = 0
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0)
    if (first >= 48 && first <= 57) tokens += piece.length / 2
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6)
    } else tokens += 0.9
  }
  return Math.ceil(tokens)
}

/**
 * Truncate a text with an ellipsis.
 * @param text - text to truncate.
 * @param limit - maximum characters kept.
 * @returns the truncated text.
 */
export function truncateText(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`
}
