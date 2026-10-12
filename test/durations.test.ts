import { assert, describe, it } from "@effect/vitest"
import { extractDurations, extractStepDurations, LONG_WAIT_MINUTES, mentionsLongWait } from "../src/parser/durations.ts"

/** `[text, minMinutes, maxMinutes]` of each mention. */
const mentions = (text: string) => extractDurations(text).map((d) => [d.text, d.minMinutes, d.maxMinutes] as const)

describe("extractDurations: the forms of the spec", () => {
  it.each([
    ["30 минут", "30 минут", 30, 30],
    ["1,5 часа", "1,5 часа", 90, 90],
    ["40–50 минут", "40–50 минут", 40, 50],
    ["2-3 часа", "2-3 часа", 120, 180],
    ["1 час 20 минут", "1 час 20 минут", 80, 80],
    ["в течение 10 минут", "10 минут", 10, 10],
    ["полчаса", "полчаса", 30, 30]
  ])("reads %s", (text, fragment, min, max) => {
    assert.deepStrictEqual(mentions(text), [[fragment, min, max]])
  })

  it.each([
    "Нарезать лук кубиками.",
    "Запекать при температуре 180 градусов до золотистой корочки.",
    "Добавить 2 ст.л. масла и 150 г муки.",
    "Взбить 3 яйца.",
    "",
    "Это займет некоторое время."
  ])("finds no time in %j", (text) => {
    assert.deepStrictEqual(mentions(text), [])
  })
})

describe("extractDurations: other forms of the pages", () => {
  it("reads a decimal number with a full stop", () => {
    assert.deepStrictEqual(mentions("Запекать в течение 1.5–2 часов."), [["1.5–2 часов", 90, 120]])
  })

  it("reads hours with minutes in the longer forms", () => {
    assert.deepStrictEqual(mentions("Печь 2 часа 30 минут."), [["2 часа 30 минут", 150, 150]])
    assert.deepStrictEqual(mentions("Оставить на 1 час и 15 минут."), [["1 час и 15 минут", 75, 75]])
  })

  it("reads number words", () => {
    assert.deepStrictEqual(mentions("Варить в течение двух минут."), [["двух минут", 2, 2]])
    assert.deepStrictEqual(mentions("Тушить две-три минуты."), [["две-три минуты", 2, 3]])
    assert.deepStrictEqual(mentions("Оставить на пять минут."), [["пять минут", 5, 5]])
  })

  it("reads 'от … до …'", () => {
    assert.deepStrictEqual(mentions("Выпекать от 20 до 30 минут."), [["от 20 до 30 минут", 20, 30]])
  })

  it("reads the forms of the unit: минуту, мин., мин", () => {
    assert.deepStrictEqual(mentions("Подержать 1 минуту."), [["1 минуту", 1, 1]])
    assert.deepStrictEqual(mentions("Готовить 10 мин. на среднем огне."), [["10 мин.", 10, 10]])
    assert.deepStrictEqual(mentions("Готовить 10 мин на среднем огне."), [["10 мин", 10, 10]])
  })

  it("reads полтора часа and half an hour in two spellings", () => {
    assert.deepStrictEqual(mentions("Варить полтора часа."), [["полтора часа", 90, 90]])
    assert.deepStrictEqual(mentions("Подержать пол часа."), [["пол часа", 30, 30]])
    assert.deepStrictEqual(mentions("Подержать пол-часа."), [["пол-часа", 30, 30]])
  })

  it("reads a unit without a number after a preposition", () => {
    assert.deepStrictEqual(mentions("Оставить на час."), [["час", 60, 60]])
    assert.deepStrictEqual(mentions("Варить около часа."), [["часа", 60, 60]])
    assert.deepStrictEqual(mentions("Настаивать в течение суток."), [["суток", 1440, 1440]])
  })

  it("reads days", () => {
    assert.deepStrictEqual(mentions("Оставить на 2 дня."), [["2 дня", 2880, 2880]])
    assert.deepStrictEqual(mentions("Хранить 2–3 суток."), [["2–3 суток", 2880, 4320]])
    assert.deepStrictEqual(mentions("Оставить на сутки."), [["сутки", 1440, 1440]])
  })

  it("does not read seconds", () => {
    assert.deepStrictEqual(mentions("Опустить листья на 5–10 секунд."), [])
  })

  it("does not read a bare number word or a bare unit without a preposition", () => {
    assert.deepStrictEqual(mentions("Взять три яйца."), [])
    assert.deepStrictEqual(mentions("Это занимает час пик."), [])
    assert.deepStrictEqual(mentions("Часть теста убрать."), [])
  })

  it("does not take the number of a longer number", () => {
    assert.deepStrictEqual(mentions("Взять 1,5 л воды, варить 10 минут."), [["10 минут", 10, 10]])
  })

  it("reads each mention of a text, in order", () => {
    assert.deepStrictEqual(mentions("Жарить 5 минут, затем тушить 15–20 минут и оставить на 2 часа."), [
      ["5 минут", 5, 5],
      ["15–20 минут", 15, 20],
      ["2 часа", 120, 120]
    ])
  })

  it("puts the smaller number first and rounds to whole minutes", () => {
    assert.deepStrictEqual(mentions("5–3 минуты"), [["5–3 минуты", 3, 5]])
    assert.deepStrictEqual(mentions("0,25 часа"), [["0,25 часа", 15, 15]])
  })

  it("skips a time of 0", () => {
    assert.deepStrictEqual(mentions("0 минут"), [])
  })

  it("is not case sensitive", () => {
    assert.deepStrictEqual(mentions("Варить 20 Минут. Полчаса отдыхать."), [["20 Минут", 20, 20], ["Полчаса", 30, 30]])
  })
})

describe("extractStepDurations", () => {
  it("collects the mentions step by step", () => {
    const found = extractStepDurations(["Варить 10 минут.", "Нарезать.", "Остудить 1 час."])
    assert.deepStrictEqual(found.map((d) => d.text), ["10 минут", "1 час"])
  })

  it("does not join text across the end of a step", () => {
    assert.deepStrictEqual(extractStepDurations(["Оставить на 1 час", "20 минут отдыхать"]).map((d) => d.text), [
      "1 час",
      "20 минут"
    ])
  })
})

describe("mentionsLongWait", () => {
  const long = (...steps: Array<string>) => mentionsLongWait(steps, extractStepDurations(steps))

  it("is true for a wait of 6 hours or more", () => {
    assert.strictEqual(LONG_WAIT_MINUTES, 360)
    assert.isTrue(long("Фасоль замочить на 6 часов."))
    assert.isTrue(long("Оставить на 8–10 часов."))
    assert.isTrue(long("Оставить на 12 часов."))
  })

  it("uses the longest end of a range", () => {
    assert.isTrue(long("Поставить в холодильник на 4–6 часов."))
    assert.isFalse(long("Поставить в холодильник на 3–5 часов."))
  })

  it("is false for a shorter wait", () => {
    assert.isFalse(long("Оставить на 5 часов 59 минут."))
    assert.isFalse(long("Оставить на 2 часа."))
  })

  it("is true for an overnight wait", () => {
    assert.isTrue(long("Убрать в холодильник на ночь."))
    assert.isTrue(long("Оставить в течение ночи."))
    assert.isTrue(long("Оставить на всю ночь."))
    assert.isTrue(long("Оставить до утра."))
  })

  it("is true for a day", () => {
    assert.isTrue(long("Оставить на сутки."))
    assert.isTrue(long("Настаивать в течение суток."))
  })

  it("is false when the steps name no long wait", () => {
    assert.isFalse(long("Нарезать лук.", "Варить 20 минут."))
    assert.isFalse(mentionsLongWait([], []))
  })

  it("does not take a word that only contains the letters", () => {
    assert.isFalse(long("Добавить ночной соус."))
    assert.isFalse(long("Кафе работает круглосуточно."))
  })
})
