import { Option } from "effect"
import type { IsoDate } from "../domain/recipe.ts"

const RU_DATE = /(?<![\d.])(\d{1,2})\.(\d{1,2})\.(\d{4})(?![\d.]\d)/u

const ADDED = /Рецепт\s+добавлен:\s*(\d{1,2}\.\d{1,2}\.\d{4})/iu

const pad = (value: number, width: number): string => String(value).padStart(width, "0")

/**
 * The first date in the form `DD.MM.YYYY` as `YYYY-MM-DD`.
 * `None` when the text has no date, or when the date does not exist (for example `31.02.2024`).
 */
export const parseRuDate = (text: string): Option.Option<IsoDate> => {
  const match = RU_DATE.exec(text)
  if (match === null) {
    return Option.none()
  }
  const day = Number(match[1])
  const month = Number(match[2])
  const year = Number(match[3])
  const date = new Date(Date.UTC(year, month - 1, day))
  const exists = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  return exists ? Option.some(`${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`) : Option.none()
}

/** "Рецепт добавлен: 05.12.2023" gives `2023-12-05`. */
export const parseAddedAt = (text: string): Option.Option<IsoDate> =>
  Option.fromNullishOr(ADDED.exec(text)?.[1]).pipe(Option.flatMap(parseRuDate))
