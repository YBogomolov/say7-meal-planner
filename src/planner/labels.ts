import { addDays, weekdayOf } from "../domain/calendar.ts"
import type { Equipment, IngredientCategory, IngredientUnit, ProteinFamily } from "../domain/enriched-recipe.ts"
import type { MealName } from "../domain/household.ts"
import type { IsoDate } from "../domain/recipe.ts"

/** Russian words for the messages and the Markdown. */

const WEEKDAYS = ["понедельник", "вторник", "среда", "четверг", "пятница", "суббота", "воскресенье"] as const

export const MEAL_LABELS: Readonly<Record<MealName, string>> = { lunch: "обед", dinner: "ужин" }

/** The headings of the departments of the shop. */
export const CATEGORY_HEADINGS: Readonly<Record<IngredientCategory, string>> = {
  vegetable: "Овощи",
  herb: "Зелень",
  fruit: "Фрукты",
  poultry: "Птица",
  meat: "Мясо",
  fish: "Рыба",
  seafood: "Морепродукты",
  dairy: "Молочные продукты",
  eggs: "Яйца",
  bakery: "Хлеб и выпечка",
  grain: "Крупы",
  pasta: "Макароны",
  legume: "Бобовые",
  canned: "Консервы",
  frozen: "Замороженное",
  sauce: "Соусы",
  nuts: "Орехи",
  sweet: "Сладкое",
  spice: "Специи",
  oil: "Масла",
  other: "Прочее"
}

export const EQUIPMENT_LABELS: Readonly<Record<Equipment, string>> = {
  hob: "плита",
  oven: "духовка",
  microwave: "микроволновка",
  air_fryer: "аэрогриль",
  food_processor: "кухонный комбайн",
  blender: "блендер",
  immersion_blender: "погружной блендер",
  mixer: "миксер",
  grill: "гриль",
  slow_cooker: "мультиварка",
  deep_fryer: "фритюрница",
  special: "особое оборудование"
}

export const PROTEIN_LABELS: Readonly<Record<ProteinFamily, string>> = {
  chicken: "курица",
  turkey: "индейка",
  duck: "утка",
  pork: "свинина",
  beef: "говядина",
  lamb: "баранина",
  rabbit: "кролик",
  fish: "рыба",
  seafood: "морепродукты"
}

interface UnitForms {
  /** After 1, 21, 31 … */
  readonly one: string
  /** After 2 to 4, and after a fraction. */
  readonly few: string
  /** After 5 to 20, 25 … */
  readonly many: string
}

/** The units of the Markdown. `g` and `ml` are written by `formatAmount` (they turn into `кг` and `л`). */
const UNIT_FORMS: Readonly<Record<Exclude<IngredientUnit, "g" | "ml">, UnitForms>> = {
  pcs: { one: "шт.", few: "шт.", many: "шт." },
  tbsp: { one: "ст. л.", few: "ст. л.", many: "ст. л." },
  tsp: { one: "ч. л.", few: "ч. л.", many: "ч. л." },
  pinch: { one: "щепотка", few: "щепотки", many: "щепоток" },
  bunch: { one: "пучок", few: "пучка", many: "пучков" },
  clove: { one: "зубчик", few: "зубчика", many: "зубчиков" },
  slice: { one: "ломтик", few: "ломтика", many: "ломтиков" },
  pack: { one: "упаковка", few: "упаковки", many: "упаковок" }
}

const pluralForm = (value: number, forms: UnitForms): string => {
  if (!Number.isInteger(value)) {
    return forms.few
  }
  const lastTwo = value % 100
  const last = value % 10
  return lastTwo >= 11 && lastTwo <= 14 ? forms.many : last === 1 ? forms.one : last >= 2 && last <= 4 ? forms.few : forms.many
}

/** A number with a decimal comma and no trailing zeros: `1,5`, `2`, `0,25`. The value has at most 2 decimals. */
export const formatNumber = (value: number): string => String(Math.round(value * 100) / 100).replace(".", ",")

/** One decimal, always: `2,0`. */
const formatTenths = (value: number): string => (Math.round(value * 10) / 10).toFixed(1).replace(".", ",")

/**
 * An amount for the Markdown: `450 г`, `1,2 кг`, `250 мл`, `1,5 л`, `3 шт.`, `2 пучка`.
 * From 1000 g the unit is `кг` with 1 decimal, from 1000 ml it is `л`.
 */
export const formatAmount = (unit: IngredientUnit, value: number): string => {
  if (unit === "g" || unit === "ml") {
    const whole = Math.round(value)
    const big = whole >= 1000
    // Integer arithmetic for the tie: 1250 g is 1,3 kg.
    return big ? `${formatTenths(Math.floor((whole + 50) / 100) / 10)} ${unit === "g" ? "кг" : "л"}` : `${whole} ${unit === "g" ? "г" : "мл"}`
  }
  return `${formatNumber(value)} ${pluralForm(value, UNIT_FORMS[unit])}`
}

/** `день 4 (среда)`: a day of the plan week with its weekday. */
export const dayLabel = (weekStart: IsoDate, day: number): string =>
  `день ${day} (${WEEKDAYS[weekdayOf(addDays(weekStart, day))] ?? ""})`

/** `среда, 2026-10-21`: the weekday and the date of a day of the plan week. */
export const dateLabel = (weekStart: IsoDate, day: number): string => {
  const date = addDays(weekStart, day)
  return `${WEEKDAYS[weekdayOf(date)] ?? ""}, ${date}`
}
