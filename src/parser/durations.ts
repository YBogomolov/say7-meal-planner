import type { StepDuration } from "../domain/parsed-recipe.ts"

/**
 * Time mentions in step texts (spec P2, fields `durations` and `longWait`).
 *
 * The extractor reads text that `cleanText` has cleaned. It finds:
 * - a number or a range with a unit: "30 минут", "1,5 часа", "40–50 минут", "2-3 часа", "1.5–2 часов",
 *   "от 20 до 30 минут", "2 дня", "двух минут", "две-три минуты";
 * - hours with minutes: "1 час 20 минут";
 * - "полчаса", "полтора часа";
 * - a unit without a number after a preposition: "на час", "в течение часа", "на сутки";
 * - "сутки" alone.
 * It does not read seconds ("на 5 секунд"): they do not matter for planning.
 * Minutes are whole numbers; the extractor rounds them.
 */

const MINUTES_PER_HOUR = 60
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR

/** A wait of this length or more sets `longWait`: 6 hours. */
export const LONG_WAIT_MINUTES = 6 * MINUTES_PER_HOUR

const NUMBER_WORDS: ReadonlyArray<readonly [string, number]> = [
  ["одного", 1],
  ["одной", 1],
  ["одну", 1],
  ["одна", 1],
  ["один", 1],
  ["двух", 2],
  ["две", 2],
  ["два", 2],
  ["трех", 3],
  ["трёх", 3],
  ["три", 3],
  ["четырех", 4],
  ["четырёх", 4],
  ["четыре", 4],
  ["пяти", 5],
  ["пять", 5],
  ["шести", 6],
  ["шесть", 6],
  ["семи", 7],
  ["семь", 7],
  ["восьми", 8],
  ["восемь", 8],
  ["девяти", 9],
  ["девять", 9],
  ["десяти", 10],
  ["десять", 10],
  ["пятнадцати", 15],
  ["пятнадцать", 15],
  ["двадцати", 20],
  ["двадцать", 20],
  ["тридцати", 30],
  ["тридцать", 30],
]

const WORD_VALUES: ReadonlyMap<string, number> = new Map(NUMBER_WORDS)

const NUMBER_WORD_PATTERN = NUMBER_WORDS.map(([word]) => word)
  .toSorted((a, b) => b.length - a.length)
  .join("|")

/** A number: digits with an optional decimal part (`,` or `.`), or a short number word. */
const NUMBER = `(?:\\d+(?:[.,]\\d+)?|${NUMBER_WORD_PATTERN})`

const MINUTES = "(?:минут[а-яё]*|мин(?:\\.|(?![а-яё])))"
const HOURS = "(?:час(?:а|ов|у|ам)?(?![а-яё]))"
const DAYS = "(?:дня|дней|день|суток|сутки)(?![а-яё])"
const ANY_UNIT = `(?:${MINUTES}|${HOURS}|${DAYS})`

/** A dash between the two numbers of a range: hyphen, en dash, em dash or minus sign. */
const DASH = "[-–—−]"

const PREPOSITIONS = "(?:на|в\\s+течение|около|через|примерно|ещё|еще|за)"

const numberOf = (token: string): number => WORD_VALUES.get(token.toLowerCase()) ?? Number(token.replace(",", "."))

const factorOf = (unit: string): number => {
  const lower = unit.toLowerCase()
  if (lower.startsWith("мин")) {
    return 1
  }
  return lower.startsWith("час") ? MINUTES_PER_HOUR : MINUTES_PER_DAY
}

interface Candidate {
  readonly start: number
  readonly end: number
  readonly text: string
  readonly minMinutes: number
  readonly maxMinutes: number
}

type Minutes = readonly [min: number, max: number]

interface Matcher {
  readonly pattern: RegExp
  /** Minutes of one match, or `undefined` when the match is not a time mention. */
  readonly minutes: (groups: Readonly<Record<string, string | undefined>>) => Minutes | undefined
}

const range = (from: string | undefined, to: string | undefined, factor: number): Minutes | undefined => {
  if (from === undefined) {
    return undefined
  }
  const first = numberOf(from) * factor
  const second = to === undefined ? first : numberOf(to) * factor
  return [Math.round(Math.min(first, second)), Math.round(Math.max(first, second))]
}

const MATCHERS: ReadonlyArray<Matcher> = [
  // 1 час 20 минут
  {
    pattern: new RegExp(
      `(?<![\\d.,а-яё])(?<h>${NUMBER})\\s*${HOURS}\\s*(?:и\\s+)?(?<m>${NUMBER})\\s*${MINUTES}`,
      "giu"
    ),
    minutes: (g) => {
      const hours = range(g["h"], undefined, MINUTES_PER_HOUR)
      const minutes = range(g["m"], undefined, 1)
      return hours === undefined || minutes === undefined ? undefined : [hours[0] + minutes[0], hours[1] + minutes[1]]
    },
  },
  // от 20 до 30 минут
  {
    pattern: new RegExp(`(?<![а-яё])от\\s+(?<a>${NUMBER})\\s+до\\s+(?<b>${NUMBER})\\s*(?<unit>${ANY_UNIT})`, "giu"),
    minutes: (g) => range(g["a"], g["b"], factorOf(g["unit"] ?? "")),
  },
  // 30 минут, 1,5 часа, 40–50 минут, 2-3 часа
  {
    pattern: new RegExp(
      `(?<![\\d.,а-яё])(?<a>${NUMBER})(?:\\s*${DASH}\\s*(?<b>${NUMBER}))?\\s*(?<unit>${ANY_UNIT})`,
      "giu"
    ),
    minutes: (g) => range(g["a"], g["b"], factorOf(g["unit"] ?? "")),
  },
  // полчаса, полтора часа
  {
    pattern: /(?<![а-яё])(?<w>полчаса|пол[\s-]часа|полтора\s+часа)(?![а-яё])/giu,
    minutes: (g) => (g["w"]?.toLowerCase().startsWith("полтора") === true ? [90, 90] : [30, 30]),
  },
  // на час, в течение часа, на сутки, в течение суток
  {
    pattern: new RegExp(`(?<=(?<![а-яё])${PREPOSITIONS}\\s+)(?<unit>час|часа|сутки|суток)(?![а-яё])`, "giu"),
    minutes: (g) => range("1", undefined, factorOf(g["unit"] ?? "")),
  },
  // сутки
  {
    pattern: /(?<![а-яё])сутки(?![а-яё])/giu,
    minutes: () => [MINUTES_PER_DAY, MINUTES_PER_DAY],
  },
]

const candidatesOf = (text: string): ReadonlyArray<Candidate> =>
  MATCHERS.flatMap(({ pattern, minutes }) =>
    [...text.matchAll(pattern)].flatMap((match): ReadonlyArray<Candidate> => {
      const found = minutes(match.groups ?? {})
      return found === undefined || found[1] <= 0
        ? []
        : [
            {
              start: match.index,
              end: match.index + match[0].length,
              text: match[0],
              minMinutes: found[0],
              maxMinutes: found[1],
            },
          ]
    })
  )

/**
 * All time mentions in one text, in text order.
 * If two matches overlap, the one that starts first wins; of two that start together, the longer one wins.
 * So "1 час 20 минут" is one mention, not two.
 */
export const extractDurations = (text: string): ReadonlyArray<StepDuration> => {
  const ordered = candidatesOf(text).toSorted((a, b) => a.start - b.start || b.end - a.end)
  const kept: Array<Candidate> = []
  let lastEnd = 0
  for (const candidate of ordered) {
    if (candidate.start >= lastEnd) {
      kept.push(candidate)
      lastEnd = candidate.end
    }
  }
  return kept.map(({ text: fragment, minMinutes, maxMinutes }) => ({
    minMinutes,
    maxMinutes,
    text: fragment,
  }))
}

/** The time mentions of all steps, step by step. A mention never crosses the end of a step. */
export const extractStepDurations = (steps: ReadonlyArray<string>): ReadonlyArray<StepDuration> =>
  steps.flatMap(extractDurations)

/** "на ночь", "в течение ночи", "всю ночь", "до утра", "сутки", "суток". */
const OVERNIGHT =
  /(?<![а-яё])(?:на\s+(?:всю\s+)?ночь|всю\s+ночь|в\s+течение\s+(?:всей\s+)?ночи|до\s+утра|сутки|суток)(?![а-яё])/iu

/**
 * True when the steps name a wait of 6 hours or more (the longest end of a range counts),
 * an overnight wait, or a day.
 */
export const mentionsLongWait = (steps: ReadonlyArray<string>, durations: ReadonlyArray<StepDuration>): boolean =>
  durations.some((duration) => duration.maxMinutes >= LONG_WAIT_MINUTES) || steps.some((step) => OVERNIGHT.test(step))
