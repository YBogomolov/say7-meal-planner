import type { Catalogue, CatalogueIngredient } from "../domain/catalogue.ts"
import type { IngredientCategory, IngredientUnit } from "../domain/enriched-recipe.ts"
import { SESSION_IDS, sessionDay } from "../domain/household.ts"
import type { Household, SessionId } from "../domain/household.ts"
import type { RecipeId } from "../domain/recipe.ts"
import { RAW_PROTEIN_CATEGORIES, SHOP_ORDER } from "../domain/shopping-list.ts"
import type {
  FreezeAction,
  ShoppingAmount,
  ShoppingCategory,
  ShoppingDish,
  ShoppingItem,
  ShoppingList,
  ShoppingSimple
} from "../domain/shopping-list.ts"
import type { WeekPlan } from "../domain/week-plan.ts"
import { decimalOf, multiply, roundTo, sum } from "./decimal.ts"
import type { Decimal } from "./decimal.ts"
import { compareText } from "./items.ts"
import { isCooked, isFresh, planDishes, planSimples, portionsEaten, sessionIdOf } from "./plan-model.ts"

/** A tablespoon is 15 ml and a teaspoon is 5 ml (spec P4.5.2). */
const ML_PER_SPOON: Readonly<Record<"tbsp" | "tsp", number>> = { tbsp: 15, tsp: 5 }

/** A tablespoon is 3 teaspoons. */
const TSP_PER_TBSP = 3

/** The places of the units in `amounts`. `spoons` is `tbsp`, `tsp`, or both of them. */
const AMOUNT_ORDER = ["g", "ml", "spoons", "pcs", "bunch", "clove", "slice", "pack", "pinch"] as const

/**
 * An ingredient line of one cooked dish, with the factor for its quantities.
 * The factor is the scale of the dish. For a fresh dish it is the scale times the number of cooking days (spec P7.2.2).
 * For a simple breakfast it is the persons of a slot (spec P7.2.3).
 */
export interface ShoppingLine {
  readonly ingredient: CatalogueIngredient
  readonly scale: number
}

export interface Aggregate {
  readonly amounts: ReadonlyArray<ShoppingAmount>
  readonly approximate: boolean
}

const isVolumeUnit = (unit: IngredientUnit | null): boolean => unit === "ml" || unit === "tbsp" || unit === "tsp"

/** Whole numbers for mass and volume, 2 decimals for the rest. */
const placesOf = (unit: IngredientUnit): number => (unit === "g" || unit === "ml" ? 0 : 2)

const scaled = (value: number, scale: number): Decimal => multiply(decimalOf(value), decimalOf(scale))

/**
 * Spoons as the shop list writes them: whole tablespoons, and the rest in teaspoons.
 * `4,5` teaspoons are 1 `tbsp` and 1,5 `tsp`; 9 teaspoons are 3 `tbsp`; 2 teaspoons stay 2 `tsp`.
 * The total is rounded to 2 decimals first, so the split is exact.
 */
const spoonAmounts = (teaspoons: Decimal): ReadonlyArray<ShoppingAmount> => {
  const total = decimalOf(roundTo(teaspoons, 2))
  const perTablespoon = BigInt(TSP_PER_TBSP) * 10n ** BigInt(total.scale)
  const tablespoons = total.units / perTablespoon
  const rest: Decimal = { units: total.units - tablespoons * perTablespoon, scale: total.scale }
  const amounts: ReadonlyArray<ShoppingAmount> = [
    ...(tablespoons > 0n ? [{ unit: "tbsp" as const, value: Number(tablespoons) }] : []),
    ...(rest.units > 0n ? [{ unit: "tsp" as const, value: roundTo(rest, 2) }] : [])
  ]
  return amounts.length === 0 ? [{ unit: "tsp", value: 0 }] : amounts
}

/**
 * The amount of one product over several lines (spec P4.5.2). The arithmetic is exact. The rounding is the last step.
 *
 * 1. If every line has `grams`: 1 sum of `grams × scale`, in `g`, or in `ml` if the lines are volumes (`ml`, `tbsp`, `tsp`).
 * 2. Otherwise: 1 sum of `quantity × scale` for each unit. A line without a unit counts as `pcs`.
 *    A line without a quantity adds nothing.
 *    - `tbsp` and `tsp` stay spoons: the sum is in teaspoons (1 `tbsp` is 3 `tsp`) and is written as whole `tbsp` and the rest in `tsp`.
 *    - `tbsp` and `tsp` turn into `ml` (15 and 5) only if the product also has a line in `ml`.
 *
 * `approximate` is true if the sums have 2 units or more (`tbsp` with its `tsp` rest is 1 sum), or if a line adds nothing to a sum that has data.
 */
export const aggregateAmounts = (lines: ReadonlyArray<ShoppingLine>): Aggregate => {
  if (lines.length > 0 && lines.every((line) => line.ingredient.grams !== null)) {
    const hasMass = lines.some((line) => line.ingredient.unit === "g")
    const hasVolume = lines.some((line) => isVolumeUnit(line.ingredient.unit))
    const unit: IngredientUnit = hasVolume && !hasMass ? "ml" : "g"
    const total = sum(lines.map((line) => scaled(line.ingredient.grams ?? 0, line.scale)))
    return { amounts: [{ unit, value: roundTo(total, placesOf(unit)) }], approximate: hasMass && hasVolume }
  }
  const sums = new Map<IngredientUnit, Array<Decimal>>()
  let withoutQuantity = 0
  for (const { ingredient, scale } of lines) {
    if (ingredient.quantity === null) {
      withoutQuantity += 1
      continue
    }
    const unit = ingredient.unit ?? "pcs"
    sums.set(unit, [...(sums.get(unit) ?? []), scaled(ingredient.quantity, scale)])
  }
  const parts = (unit: IngredientUnit): ReadonlyArray<Decimal> => sums.get(unit) ?? []
  const hasMillilitres = sums.has("ml")
  const hasSpoons = sums.has("tbsp") || sums.has("tsp")
  const spoonParts = (unit: "tbsp" | "tsp", factor: number): ReadonlyArray<Decimal> =>
    parts(unit).map((value) => multiply(value, decimalOf(factor)))
  const groups = AMOUNT_ORDER.map((place): ReadonlyArray<ShoppingAmount> => {
    if (place === "spoons") {
      return hasSpoons && !hasMillilitres
        ? spoonAmounts(sum([...spoonParts("tbsp", TSP_PER_TBSP), ...parts("tsp")]))
        : []
    }
    const own = parts(place)
    const spoonsAsMillilitres = place === "ml" && hasMillilitres ? [...spoonParts("tbsp", ML_PER_SPOON.tbsp), ...spoonParts("tsp", ML_PER_SPOON.tsp)] : []
    const all = [...own, ...spoonsAsMillilitres]
    return all.length === 0 ? [] : [{ unit: place, value: roundTo(sum(all), placesOf(place)) }]
  })
  const amounts = groups.flat()
  const sumCount = groups.filter((group) => group.length > 0).length
  return { amounts, approximate: sumCount > 1 || (sumCount > 0 && withoutQuantity > 0) }
}

/** Weight of one piece in grams (spec P4.5.7). The key is a normalised item name. */
export const PIECE_GRAMS: Readonly<Record<string, number>> = { яйца: 55, желток: 20, белок: 35 }

/** Density in grams per millilitre, for the items that have only a volume (spec P4.5.7). */
export const DENSITY_G_PER_ML: Readonly<Record<string, number>> = {
  гречка: 0.85,
  рис: 0.85,
  пшено: 0.85,
  булгур: 0.8,
  кускус: 0.75,
  манка: 0.65,
  мука: 0.6,
  сахар: 0.85
}

/**
 * The units for the shopper (spec P4.5.7).
 *
 * - An item with a piece weight and one sum in `g` gets the pieces first, rounded up, then the grams: `[pcs, g]`.
 *   The generic sums never have `pcs` before `g`, so this order marks the item. `approximate` is true.
 * - An item with a density and one sum in `ml` becomes one sum in `g`. `approximate` is true.
 * - Any other item does not change.
 */
export const shopperUnits = (item: string, aggregate: Aggregate): Aggregate => {
  const [only, ...rest] = aggregate.amounts
  if (only === undefined || rest.length > 0) {
    return aggregate
  }
  const pieceGrams = Object.hasOwn(PIECE_GRAMS, item) ? PIECE_GRAMS[item] : undefined
  if (only.unit === "g" && pieceGrams !== undefined) {
    return { amounts: [{ unit: "pcs", value: Math.ceil(only.value / pieceGrams) }, only], approximate: true }
  }
  const density = Object.hasOwn(DENSITY_G_PER_ML, item) ? DENSITY_G_PER_ML[item] : undefined
  if (only.unit === "ml" && density !== undefined) {
    return { amounts: [{ unit: "g", value: Math.round(only.value * density) }], approximate: true }
  }
  return aggregate
}

type Section = "buy" | "optional" | "check_at_home"

const sectionOf = (ingredient: CatalogueIngredient): Section =>
  ingredient.pantry ? "check_at_home" : ingredient.optional ? "optional" : "buy"

/** The department that most lines name. A tie goes to the department that comes first in the shop. */
const categoryOf = (lines: ReadonlyArray<ShoppingLine>): IngredientCategory => {
  const counts = new Map<IngredientCategory, number>()
  for (const { ingredient } of lines) {
    counts.set(ingredient.category, (counts.get(ingredient.category) ?? 0) + 1)
  }
  return SHOP_ORDER.reduce(
    (best, category) => (counts.get(category) ?? 0) > (counts.get(best) ?? 0) ? category : best
  )
}

/** A line of a recipe has `recipeId`, and `session` if the dish is cooked in a session (not fresh). A line of a simple breakfast has `simpleId`. */
interface DishLine extends ShoppingLine {
  readonly recipeId?: RecipeId
  readonly simpleId?: string
  readonly session?: SessionId
}

const recipeIdsOf = (lines: ReadonlyArray<DishLine>): Array<RecipeId> =>
  [...new Set(lines.flatMap((line) => line.recipeId === undefined ? [] : [line.recipeId]))].sort((a, b) => a - b)

const simpleIdsOf = (lines: ReadonlyArray<DishLine>): Array<string> =>
  [...new Set(lines.flatMap((line) => line.simpleId === undefined ? [] : [line.simpleId]))].sort(compareText)

const groupBy = <A>(values: ReadonlyArray<A>, key: (value: A) => string): ReadonlyMap<string, ReadonlyArray<A>> => {
  const groups = new Map<string, Array<A>>()
  for (const value of values) {
    const name = key(value)
    const group = groups.get(name)
    if (group === undefined) {
      groups.set(name, [value])
    } else {
      group.push(value)
    }
  }
  return groups
}

const itemOf = (item: string, lines: ReadonlyArray<DishLine>): ShoppingItem => {
  const { amounts, approximate } = shopperUnits(item, aggregateAmounts(lines))
  return {
    item,
    category: categoryOf(lines),
    amounts,
    approximate,
    recipeIds: recipeIdsOf(lines),
    simpleIds: simpleIdsOf(lines)
  }
}

const itemsOf = (lines: ReadonlyArray<DishLine>): ReadonlyArray<ShoppingItem> =>
  [...groupBy(lines, (line) => line.ingredient.item)].map(([item, group]) => itemOf(item, group))
    .sort((a, b) => compareText(a.item, b.item))

const FREEZE_TEXT = (session: SessionId): string =>
  `заморозить в день покупки, разморозить в холодильнике накануне сессии ${session}`

/**
 * Raw poultry, meat, fish and seafood that a session uses later than `rawProteinFridgeDays` after the shopping day (spec P4.5.5).
 * This is a heuristic: cured and smoked products in these categories get the action too.
 */
const freezeActions = (buyLines: ReadonlyArray<DishLine>, household: Household): ReadonlyArray<FreezeAction> =>
  SESSION_IDS.flatMap((session) => {
    if (sessionDay(household, session) - household.shoppingDayOffset <= household.rawProteinFridgeDays) {
      return []
    }
    const raw = buyLines.filter((line) => line.session === session && RAW_PROTEIN_CATEGORIES.includes(line.ingredient.category))
    return [...groupBy(raw, (line) => line.ingredient.item)]
      .sort(([a], [b]) => compareText(a, b))
      .map(([item, group]): FreezeAction => ({
        kind: "freeze",
        item,
        session,
        amounts: aggregateAmounts(group).amounts,
        recipeIds: recipeIdsOf(group),
        text: FREEZE_TEXT(session)
      }))
  })

const SHOPPING_SESSION_ORDER: ReadonlyArray<string> = [...SESSION_IDS, "fresh"]

/**
 * The shopping list of a plan (spec P4.5). Pure.
 *
 * It takes every ingredient of every cooked dish, multiplies by the scale, and groups by the normalised item.
 * A fresh dish (spec P7.2.2) is cooked on each day that it is eaten: its quantities are multiplied by the scale and by the number of days.
 * A fresh dish that is in no slot adds nothing. A simple breakfast (spec P7.2.3) adds its items times the persons of each slot.
 * A cooked recipe that the catalogue does not have is in `unknownRecipeIds`, a simple breakfast that the config does not have
 * is in `unknownSimpleIds`. They add nothing.
 */
export const shoppingList = (plan: WeekPlan, catalogue: Catalogue, household: Household): ShoppingList => {
  const dishes = planDishes(plan, catalogue).filter((dish) => dish.cooking !== undefined)
  const cooked = dishes.filter(isCooked)
  const dishLines: ReadonlyArray<DishLine> = cooked.filter((dish) => !isFresh(dish) || dish.days.length > 0).flatMap((dish) => {
    const factor = dish.cooking.scale * (isFresh(dish) ? dish.days.length : 1)
    const session = sessionIdOf(dish.cooking)
    return dish.entry.enrichment.ingredients.map((ingredient): DishLine => ({
      ingredient,
      scale: factor,
      recipeId: dish.recipeId,
      ...(session === undefined ? {} : { session })
    }))
  })
  const simples = planSimples(plan, catalogue)
  const simpleLines: ReadonlyArray<DishLine> = simples.flatMap((simple) => {
    const persons = portionsEaten(simple.slots, household, false)
    return (simple.entry?.items ?? []).map((item): DishLine => ({
      ingredient: {
        item: item.item,
        rawItem: item.item,
        line: 0,
        detail: null,
        category: item.category,
        pantry: item.pantry,
        quantity: item.grams,
        unit: "g",
        grams: item.grams,
        optional: false
      },
      scale: persons,
      simpleId: simple.simpleId
    }))
  })
  const lines = [...dishLines, ...simpleLines]
  const bySection = groupBy(lines, (line) => sectionOf(line.ingredient))
  const buyLines = bySection.get("buy") ?? []

  const buyItems = itemsOf(buyLines)
  const buy: ReadonlyArray<ShoppingCategory> = SHOP_ORDER.flatMap((category) => {
    const items = buyItems.filter((item) => item.category === category)
    return items.length === 0 ? [] : [{ category, items }]
  })

  const shoppingDishes: ReadonlyArray<ShoppingDish> = cooked
    .map((dish): ShoppingDish => {
      const session = sessionIdOf(dish.cooking)
      return {
        recipeId: dish.recipeId,
        title: dish.entry.title,
        url: dish.entry.url,
        session: dish.cooking.session,
        sessionDay: session === undefined ? null : sessionDay(household, session),
        freshDays: session === undefined ? dish.days : [],
        scale: dish.cooking.scale
      }
    })
    .sort((a, b) =>
      SHOPPING_SESSION_ORDER.indexOf(a.session) - SHOPPING_SESSION_ORDER.indexOf(b.session) || a.recipeId - b.recipeId
    )

  const shoppingSimples: ReadonlyArray<ShoppingSimple> = simples.flatMap((simple) =>
    simple.entry === undefined ? [] : [{
      id: simple.simpleId,
      title: simple.entry.title,
      portions: portionsEaten(simple.slots, household, false),
      days: simple.days
    }]
  )

  return {
    weekStart: plan.weekStart,
    shoppingDay: household.shoppingDayOffset,
    buy,
    optional: itemsOf(bySection.get("optional") ?? []),
    check_at_home: itemsOf(bySection.get("check_at_home") ?? []),
    actions: freezeActions(buyLines, household),
    dishes: shoppingDishes,
    unknownRecipeIds: dishes.filter((dish) => dish.entry === undefined).map((dish) => dish.recipeId),
    extras: household.weeklyExtras,
    simpleBreakfasts: shoppingSimples,
    unknownSimpleIds: simples.filter((simple) => simple.entry === undefined).map((simple) => simple.simpleId)
  }
}
