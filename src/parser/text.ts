/** Characters that have no width or no meaning in the page text: soft hyphen, zero-width spaces, joiner, BOM. */
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g

/** Hyphen variants that the page uses in place of `-`: U+2010 hyphen and U+2011 non-breaking hyphen (`&#8209;`). */
const HYPHENS = /[\u2010\u2011]/g

/**
 * Clean text from a page (spec P2, field `title`):
 * remove invisible characters, turn special hyphens into `-`,
 * turn each run of white space (also the no-break space `&nbsp;`) into one space, and trim.
 * Entities are already decoded by the HTML parser.
 */
export const cleanText = (text: string): string =>
  text.replace(INVISIBLE, "").replace(HYPHENS, "-").replace(/\s+/g, " ").trim()

/** Clean each line, and drop the lines that stay empty. */
export const cleanLines = (lines: ReadonlyArray<string>): ReadonlyArray<string> =>
  lines.map(cleanText).filter((line) => line !== "")

/**
 * A full stop, `!`, `?` or `…` followed by white space and then a capital letter, a digit, a quote or a bracket
 * ends a sentence. `т.д.` and `ч.л.` do not end a sentence, because no white space follows their inner full stops.
 */
const SENTENCE_END = /(?<=[.!?…])\s+(?=[«"“(\[]?[А-ЯЁA-Z0-9])/u

/** Split text into sentences. A line break always ends a sentence. Each sentence is clean. */
export const splitSentences = (text: string): ReadonlyArray<string> =>
  text
    .split(/\r?\n/)
    .flatMap((line) => cleanText(line).split(SENTENCE_END))
    .filter((sentence) => sentence !== "")
