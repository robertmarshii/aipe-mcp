// Sanitiser for third-party text (plan §3.1, SAFETY 10). Applied to every untrusted string in
// structuredContent, the text block and elicitation summaries:
//   1. NFKC normalisation;
//   2. removal of invisible and formatting characters (list below);
//   3. a "(cleaned)" mark when anything was removed;
//   4. a length cap (4000 by default, about 200 in elicitation summaries).

export const DEFAULT_CAP = 4000;
export const ELICITATION_CAP = 200;
export const CLEANED_MARK = ' (cleaned)';
export const TRUNCATED_MARK = '…(truncated)';

// Unicode Cf (format: bidi overrides and isolates, zero-width characters, U+FEFF, tag characters,
// U+2060–2064, U+200E/F, U+061C, U+00AD, U+180E, U+FFF9–FFFB), Co (private use), Cs (lone
// surrogates), C0/C1 controls except LF, variation selectors (Mn), U+034F (Mn), Hangul fillers (Lo).
const REMOVE = new RegExp(
  [
    '[\\p{Cf}\\p{Co}\\p{Cs}]',
    '[\\u0000-\\u0009\\u000B-\\u001F\\u007F-\\u009F]',
    '[\\uFE00-\\uFE0F]',
    '[\\u{E0100}-\\u{E01EF}]',
    '[\\u{E0000}-\\u{E007F}]',
    '[\\u2060-\\u2064\\u200E\\u200F\\u061C\\u00AD\\u034F\\u180E]',
    '[\\u115F\\u1160\\u3164\\uFFA0]',
    '[\\uFFF9-\\uFFFB]',
  ].join('|'),
  'gu',
);

export interface Sanitised {
  text: string;
  cleaned: boolean;
  truncated: boolean;
}

/** Cleans one string. The cap counts code points, not UTF-16 units. */
export function sanitiseString(input: string, cap: number = DEFAULT_CAP): Sanitised {
  const normal = input.normalize('NFKC');
  const stripped = normal.replace(REMOVE, '');
  const cleaned = stripped !== normal;
  const points = Array.from(stripped);
  const truncated = points.length > cap;
  let text = truncated ? points.slice(0, cap).join('') + TRUNCATED_MARK : stripped;
  if (cleaned) text += CLEANED_MARK;
  return { text, cleaned, truncated };
}

/** Cleans every string (and object key) in a JSON-like value. */
export function sanitiseDeep<T>(value: T, cap: number = DEFAULT_CAP): { value: T; cleaned: boolean } {
  let any = false;
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const s = sanitiseString(v, cap);
      if (s.cleaned) any = true;
      return s.text;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, inner] of Object.entries(v)) {
        const key = sanitiseString(k, 200);
        if (key.cleaned) any = true;
        out[key.text] = walk(inner);
      }
      return out;
    }
    return v;
  };
  const value2 = walk(value) as T;
  return { value: value2, cleaned: any };
}

/** Untrusted text quoted inside an elicitation summary: cleaned, capped at about 200, quoted. */
export function quoteForElicitation(input: string): string {
  return JSON.stringify(sanitiseString(input, ELICITATION_CAP).text);
}
