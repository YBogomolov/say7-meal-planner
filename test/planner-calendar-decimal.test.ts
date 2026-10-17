import { assert, describe, it } from "@effect/vitest"
import { addDays, daysBetween, isCalendarDate, weekdayOf } from "../src/domain/calendar.ts"
import { add, decimalOf, multiply, roundTo, sum, ZERO } from "../src/planner/decimal.ts"

describe("calendar", () => {
  it("accepts real dates and rejects days that do not exist", () => {
    for (const date of ["2026-10-17", "2024-02-29", "2000-02-29", "2026-12-31", "2026-01-01"]) {
      assert.isTrue(isCalendarDate(date), date)
    }
    for (const date of [
      "2026-02-30",
      "2025-02-29",
      "1900-02-29",
      "2026-04-31",
      "2026-13-01",
      "2026-00-10",
      "2026-10-00",
      "2026-1-1",
      "26-10-17",
      "",
    ]) {
      assert.isFalse(isCalendarDate(date), date)
    }
  })

  it("adds days across months, years and leap days", () => {
    assert.strictEqual(addDays("2026-10-17", 0), "2026-10-17")
    assert.strictEqual(addDays("2026-10-17", 6), "2026-10-23")
    assert.strictEqual(addDays("2026-10-30", 2), "2026-11-01")
    assert.strictEqual(addDays("2026-12-30", 3), "2027-01-02")
    assert.strictEqual(addDays("2024-02-28", 1), "2024-02-29")
    assert.strictEqual(addDays("2025-02-28", 1), "2025-03-01")
    assert.strictEqual(addDays("2026-10-17", -28), "2026-09-19")
    assert.strictEqual(addDays("2026-01-01", -1), "2025-12-31")
  })

  it("counts the days between 2 dates", () => {
    assert.strictEqual(daysBetween("2026-09-19", "2026-10-17"), 28)
    assert.strictEqual(daysBetween("2026-10-17", "2026-09-19"), -28)
    assert.strictEqual(daysBetween("2026-10-17", "2026-10-17"), 0)
    assert.strictEqual(daysBetween("2025-12-31", "2026-01-01"), 1)
    assert.strictEqual(daysBetween("2024-01-01", "2025-01-01"), 366)
  })

  it("names the weekday, Monday as 0", () => {
    assert.strictEqual(weekdayOf("2026-10-17"), 5)
    assert.strictEqual(weekdayOf("2026-10-19"), 0)
    assert.strictEqual(weekdayOf("2026-10-18"), 6)
    assert.strictEqual(weekdayOf("1970-01-01"), 3)
    assert.strictEqual(weekdayOf("1969-12-31"), 2)
  })
})

describe("decimal", () => {
  it("reads a number from its shortest text, so 0,1 is exactly 1/10", () => {
    assert.deepStrictEqual(decimalOf(0.1), { units: 1n, scale: 1 })
    assert.deepStrictEqual(decimalOf(150), { units: 150n, scale: 0 })
    assert.deepStrictEqual(decimalOf(2.675), { units: 2675n, scale: 3 })
    assert.deepStrictEqual(decimalOf(1e-7), { units: 1n, scale: 7 })
    assert.deepStrictEqual(decimalOf(1e21), { units: 10n ** 21n, scale: 0 })
    assert.deepStrictEqual(decimalOf(-0.5), { units: -5n, scale: 1 })
  })

  it("gives zero for a number that is not finite", () => {
    assert.deepStrictEqual(decimalOf(Number.NaN), ZERO)
    assert.deepStrictEqual(decimalOf(Number.POSITIVE_INFINITY), ZERO)
  })

  it("adds and multiplies without error", () => {
    assert.strictEqual(roundTo(add(decimalOf(0.1), decimalOf(0.2)), 2), 0.3)
    assert.deepStrictEqual(add(decimalOf(0.1), decimalOf(0.2)), {
      units: 3n,
      scale: 1,
    })
    assert.deepStrictEqual(multiply(decimalOf(0.3), decimalOf(1.5)), {
      units: 45n,
      scale: 2,
    })
    assert.deepStrictEqual(sum([decimalOf(1.5), decimalOf(2.25), decimalOf(0.25)]), { units: 400n, scale: 2 })
  })

  it("rounds half away from zero, with the wanted decimals", () => {
    assert.strictEqual(roundTo(decimalOf(1.005), 2), 1.01)
    assert.strictEqual(roundTo(decimalOf(2.675), 2), 2.68)
    assert.strictEqual(roundTo(decimalOf(0.125), 2), 0.13)
    assert.strictEqual(roundTo(decimalOf(0.124), 2), 0.12)
    assert.strictEqual(roundTo(decimalOf(67.5), 0), 68)
    assert.strictEqual(roundTo(decimalOf(67.4), 0), 67)
    assert.strictEqual(roundTo(decimalOf(3), 2), 3)
    assert.strictEqual(roundTo(decimalOf(12.34), 2), 12.34)
    assert.strictEqual(roundTo(decimalOf(-1.005), 2), -1.01)
    assert.strictEqual(roundTo(ZERO, 2), 0)
  })
})
