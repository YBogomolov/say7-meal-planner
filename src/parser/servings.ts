import { Option } from "effect"
import type { Servings } from "../domain/parsed-recipe.ts"
import { splitSentences } from "./text.ts"

const MENTION = /порци/iu

/**
 * A whole number or a range of two whole numbers just before the word "порци…".
 * A number inside a decimal number ("1,5") does not count.
 */
const SERVINGS = /(?<![\d.,])(\d+)(?![\d.,]\d)(?:\s*(?:[-–—−]|или)\s*(\d+)(?![\d.,]\d))?\s*порци/iu

export interface ServingsSources {
  /** The text of `.p-yield`. */
  readonly yieldText: Option.Option<string>
  readonly intro: ReadonlyArray<string>
  readonly steps: ReadonlyArray<string>
}

/** The first sentence of the texts that contains "порци". */
const firstSentenceWithServings = (texts: ReadonlyArray<string>): Option.Option<string> => {
  for (const text of texts) {
    const sentence = splitSentences(text).find((candidate) => MENTION.test(candidate))
    if (sentence !== undefined) {
      return Option.some(sentence)
    }
  }
  return Option.none()
}

/**
 * The text that tells the number of portions (spec P2, field `servingsText`). The sources, in this order:
 * (1) the yield text, if it contains "порци"; (2) the first intro sentence that contains "порци";
 * (3) the first step sentence that contains "порци".
 * A yield in pieces ("100–110 штук") is not a source.
 */
export const findServingsText = (sources: ServingsSources): Option.Option<string> =>
  sources.yieldText.pipe(
    Option.filter((text) => MENTION.test(text)),
    Option.orElse(() => firstSentenceWithServings(sources.intro)),
    Option.orElse(() => firstSentenceWithServings(sources.steps))
  )

/**
 * Numbers before "порци…": `"6–8 порций"` gives 6..8, `"4 порции"` gives 4..4.
 * `None` when the text has no whole number directly before the word, or when the number is 0.
 */
export const parseServings = (text: string): Option.Option<Servings> => {
  const match = SERVINGS.exec(text)
  if (match === null) {
    return Option.none()
  }
  const first = Number(match[1])
  const second = match[2] === undefined ? first : Number(match[2])
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(second)) {
    return Option.none()
  }
  const min = Math.min(first, second)
  return min > 0 ? Option.some({ min, max: Math.max(first, second) }) : Option.none()
}
