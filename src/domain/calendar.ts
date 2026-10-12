import type { IsoDate } from "./recipe.ts"

/**
 * Date arithmetic on `YYYY-MM-DD` strings, without the `Date` class and without time zones.
 * The functions count days with the proleptic Gregorian calendar.
 */

const DATE_PARTS = /^(\d{4})-(\d{2})-(\d{2})$/

const isLeapYear = (year: number): boolean => (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0

const daysInMonth = (year: number, month: number): number =>
  month === 2 ? (isLeapYear(year) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31

/** The parts of a date, or `undefined` if the text is not a real calendar date (`2026-02-30` is not). */
const partsOf = (text: string): { readonly year: number; readonly month: number; readonly day: number } | undefined => {
  const match = DATE_PARTS.exec(text)
  if (match === null) {
    return undefined
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month) ? { year, month, day } : undefined
}

/** True if the text has the form `YYYY-MM-DD` and names a day that exists. */
export const isCalendarDate = (text: string): boolean => partsOf(text) !== undefined

/** Days since 1970-01-01 (negative before). The algorithm is `days_from_civil` of Howard Hinnant. */
const dayNumber = (year: number, month: number, day: number): number => {
  const y = month <= 2 ? year - 1 : year
  const era = Math.floor(y / 400)
  const yearOfEra = y - era * 400
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear
  return era * 146097 + dayOfEra - 719468
}

/** The date of a day number. The inverse of `dayNumber` (`civil_from_days` of Howard Hinnant). */
const dateOfDayNumber = (number: number): string => {
  const z = number + 719468
  const era = Math.floor(z / 146097)
  const dayOfEra = z - era * 146097
  const yearOfEra = Math.floor(
    (dayOfEra - Math.floor(dayOfEra / 1460) + Math.floor(dayOfEra / 36524) - Math.floor(dayOfEra / 146096)) / 365
  )
  const dayOfYear = dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100))
  const shifted = Math.floor((5 * dayOfYear + 2) / 153)
  const day = dayOfYear - Math.floor((153 * shifted + 2) / 5) + 1
  const month = shifted < 10 ? shifted + 3 : shifted - 9
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`
}

/** The day number of a valid date. A text that is not a real date gives 0 (1970-01-01): the schemas reject such text before. */
const numberOf = (date: string): number => {
  const parts = partsOf(date)
  return parts === undefined ? 0 : dayNumber(parts.year, parts.month, parts.day)
}

/** The date that is `days` after `date` (before, if `days` is negative). */
export const addDays = (date: IsoDate, days: number): IsoDate => dateOfDayNumber(numberOf(date) + days)

/** Whole days from `from` to `to`. The result is negative if `to` is earlier. */
export const daysBetween = (from: IsoDate, to: IsoDate): number => numberOf(to) - numberOf(from)

/** The weekday of a date: 0 Monday to 6 Sunday. */
export const weekdayOf = (date: IsoDate): number => (((numberOf(date) + 3) % 7) + 7) % 7
