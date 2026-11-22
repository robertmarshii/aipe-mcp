// Numbered rule words (plan §2.2 aipe_rules_prepare, DEC24 D6, U13). Uses exactly the server's
// tokeniser, so word N of rule R here is word N of rule R when the server grades the answer.
// Shown after the full rules text, and never with answers filled in.

export const WORD_RE = /[A-Za-z0-9]+(?:'[A-Za-z0-9]+)?/g;

export function tokenize(body: string): string[] {
  return body.match(WORD_RE) ?? [];
}

export interface NumberedRule {
  rule: number;
  /** words[0] is word 1 */
  words: string[];
}

export function numberedWords(rules: readonly { number: string; body: string }[]): NumberedRule[] {
  return rules.map((r) => ({ rule: Number.parseInt(r.number, 10), words: tokenize(r.body) }));
}

/** "1:Do 2:not 3:voluntarily ..." for one rule, as shown to the model. */
export function renderNumbered(r: NumberedRule): string {
  return r.words.map((w, i) => `${i + 1}:${w}`).join(' ');
}
