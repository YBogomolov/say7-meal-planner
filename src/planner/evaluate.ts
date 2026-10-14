import { daysBetween } from "../domain/calendar.ts"
import type { Catalogue, CatalogueEntry } from "../domain/catalogue.ts"
import { ProteinFamily } from "../domain/enriched-recipe.ts"
import { sessionDay } from "../domain/household.ts"
import type { Household } from "../domain/household.ts"
import type { DishPortions, IssueCode, PlanEvaluation, PlanIssue, PlanMetrics, SlotProtein } from "../domain/plan-evaluation.ts"
import type { RecipeId } from "../domain/recipe.ts"
import type { WeekPlan } from "../domain/week-plan.ts"
import { isBuyIngredient } from "./items.ts"
import { portionProtein, UNCERTAIN_COVERAGE } from "./protein.ts"
import { dayLabel, DISH_TYPE_LABELS, EQUIPMENT_LABELS, formatNumber, MEAL_LABELS, PROTEIN_LABELS } from "./labels.ts"
import { isCooked, planDishes } from "./plan-model.ts"
import type { CookedDish, PlanDish } from "./plan-model.ts"
import { buyItemsIn, hasAnyBuyItem, sideGroupsOf, tasteRulesOf } from "./taste.ts"
import type { TasteRules } from "./taste.ts"

/** Scale factor of the active time: a big batch costs more hands-on time (spec P4.4, `active_time`). */
const BIG_BATCH_SCALE = 1.5
const BIG_BATCH_FACTOR = 1.25
const WASTE_PORTIONS_PER_PERSON = 2

interface Finding {
  readonly level: "error" | "warning"
  readonly issue: PlanIssue
}

const finding = (
  level: Finding["level"],
  code: IssueCode,
  message: string,
  recipeIds: ReadonlyArray<RecipeId>,
  days: ReadonlyArray<number>
): Finding => ({ level, issue: { code, message, recipeIds, days } })

interface Context {
  readonly plan: WeekPlan
  readonly catalogue: Catalogue
  readonly household: Household
  readonly history: ReadonlyArray<WeekPlan>
  readonly dishes: ReadonlyArray<PlanDish>
  readonly cooked: ReadonlyArray<CookedDish>
  readonly taste: TasteRules
}

/** `«Title» (12)`, or `рецепт 12` if the catalogue does not have the recipe. */
const nameOf = (dish: PlanDish): string =>
  dish.entry === undefined ? `рецепт ${dish.recipeId}` : `«${dish.entry.title}» (${dish.recipeId})`

const daysText = (days: ReadonlyArray<number>): string => days.join(", ")

const unknownRecipes = ({ dishes }: Context): ReadonlyArray<Finding> =>
  dishes.filter((dish) => dish.entry === undefined).map((dish) =>
    finding("error", "unknown_recipe", `Рецепта ${dish.recipeId} нет в каталоге.`, [dish.recipeId], dish.days)
  )

const notCooked = ({ dishes }: Context): ReadonlyArray<Finding> =>
  dishes.filter((dish) => dish.cooking === undefined).map((dish) =>
    finding(
      "error",
      "not_cooked",
      `${nameOf(dish)} стоит в меню (дни ${daysText(dish.days)}), но ни одна сессия его не готовит.`,
      [dish.recipeId],
      dish.days
    )
  )

const cookedNotEaten = ({ dishes }: Context): ReadonlyArray<Finding> =>
  dishes.filter((dish) => dish.cooking !== undefined && dish.slots.length === 0).map((dish) =>
    finding(
      "warning",
      "cooked_not_eaten",
      `${nameOf(dish)} готовится в сессии ${dish.cooking?.session}, но не стоит ни в одном приёме пищи.`,
      [dish.recipeId],
      []
    )
  )

/** The slots of `days × meals` that have no dish. */
const slotMissing = ({ plan, household }: Context): ReadonlyArray<Finding> => {
  const filled = new Set(plan.meals.filter((entry) => entry.recipeIds.length > 0).map((entry) => `${entry.day}/${entry.meal}`))
  return Array.from({ length: household.days }, (_, day) => day).flatMap((day) =>
    household.meals.flatMap((meal) =>
      filled.has(`${day}/${meal}`) ? [] : [
        finding("error", "slot_missing", `Не заполнен слот: ${dayLabel(plan.weekStart, day)}, ${MEAL_LABELS[meal]}.`, [], [day])
      ]
    )
  )
}

const isSide = (entry: CatalogueEntry): boolean =>
  entry.enrichment.dishType === "side" || entry.enrichment.mealFit === "side_only"

/** A slot is a meal if it has a `full_meal` dish, or a `needs_side` dish together with a `side` or `side_only` dish. */
const slotNotAMeal = ({ plan, catalogue }: Context): ReadonlyArray<Finding> =>
  [...plan.meals]
    .sort((a, b) => a.day - b.day || (a.meal === b.meal ? 0 : a.meal === "lunch" ? -1 : 1))
    .flatMap((slot) => {
      const entries = slot.recipeIds.map((id) => catalogue.byId.get(id))
      // A dish that the catalogue does not know is already an error. The slot cannot be judged without it.
      if (entries.length === 0 || entries.some((entry) => entry === undefined)) {
        return []
      }
      const known = entries.flatMap((entry) => entry === undefined ? [] : [entry])
      const complete = known.some((entry) => entry.enrichment.mealFit === "full_meal") ||
        known.some((needy, index) =>
          needy.enrichment.mealFit === "needs_side" && known.some((other, otherIndex) => otherIndex !== index && isSide(other))
        )
      return complete ? [] : [
        finding(
          "error",
          "slot_not_a_meal",
          `Слот ${dayLabel(plan.weekStart, slot.day)}, ${MEAL_LABELS[slot.meal]}: блюда ${
            known.map((entry) => `«${entry.title}» (${entry.id})`).join(", ")
          } не дают полноценный приём пищи. Нужно самостоятельное блюдо (full_meal) ` +
            `или блюдо, которому нужен гарнир (needs_side), вместе с гарниром (side, side_only).`,
          slot.recipeIds,
          [slot.day]
        )
      ]
    })

const eatenBeforeCooked = ({ dishes, household }: Context): ReadonlyArray<Finding> =>
  dishes.flatMap((dish) => {
    if (dish.cooking === undefined) {
      return []
    }
    const cookingDay = sessionDay(household, dish.cooking.session)
    const early = dish.days.filter((day) => day < cookingDay)
    return early.length === 0 ? [] : [
      finding(
        "error",
        "eaten_before_cooked",
        `${nameOf(dish)} готовится в сессии ${dish.cooking.session} (день ${cookingDay}), а стоит в меню раньше: дни ${daysText(early)}.`,
        [dish.recipeId],
        early
      )
    ]
  })

const portionsOf = (dish: CookedDish, household: Household): DishPortions => {
  const { servings } = dish.entry.enrichment
  const { scale } = dish.cooking
  const eaten = household.persons * dish.slots.length
  const made = { min: servings.min * scale, max: servings.max * scale }
  return {
    recipeId: dish.recipeId,
    scale,
    made,
    eaten,
    left: { min: made.min - eaten, max: made.max - eaten }
  }
}

/** `portions_short` (error), `portions_tight` and `portions_left` (warnings). A short dish is not also tight. */
const portions = ({ cooked, household }: Context): ReadonlyArray<Finding> =>
  cooked.flatMap((dish): ReadonlyArray<Finding> => {
    const { made, eaten, left, scale } = portionsOf(dish, household)
    const ids = [dish.recipeId]
    const scaleText = `масштаб ${formatNumber(scale)}`
    if (eaten > made.max) {
      return [
        finding(
          "error",
          "portions_short",
          `${nameOf(dish)}: в меню ${eaten} порц., а готовится не больше ${formatNumber(made.max)} (${scaleText}).`,
          ids,
          dish.days
        )
      ]
    }
    if (eaten > made.min) {
      return [
        finding(
          "warning",
          "portions_tight",
          `${nameOf(dish)}: в меню ${eaten} порц., а получится от ${formatNumber(made.min)} до ${formatNumber(made.max)} (${scaleText}). Порций может не хватить.`,
          ids,
          dish.days
        )
      ]
    }
    return left.min > household.persons * WASTE_PORTIONS_PER_PERSON
      ? [
        finding(
          "warning",
          "portions_left",
          `${nameOf(dish)}: останется не меньше ${formatNumber(left.min)} порц. при норме до ${
            household.persons * WASTE_PORTIONS_PER_PERSON
          } (${scaleText}). Еда может пропасть.`,
          ids,
          dish.days
        )
      ]
      : []
  })

const tooManyDays = ({ dishes, household }: Context): ReadonlyArray<Finding> =>
  dishes.filter((dish) => dish.days.length > household.maxDaysPerDish).map((dish) =>
    finding(
      "error",
      "too_many_days",
      `${nameOf(dish)} стоит в меню ${dish.days.length} дн. (дни ${daysText(dish.days)}), а допустимо не больше ${household.maxDaysPerDish}.`,
      [dish.recipeId],
      dish.days
    )
  )

const sameDayTwice = ({ dishes }: Context): ReadonlyArray<Finding> =>
  dishes.flatMap((dish) => {
    const twice = dish.days.filter((day) => dish.slots.filter((slot) => slot.day === day).length > 1)
    return twice.length === 0 ? [] : [
      finding(
        "warning",
        "same_day_twice",
        `${nameOf(dish)} стоит и в обеде, и в ужине одного дня (дни ${daysText(twice)}).`,
        [dish.recipeId],
        twice
      )
    ]
  })

const notFresh = ({ cooked, household }: Context): ReadonlyArray<Finding> =>
  cooked.flatMap((dish) => {
    const cookingDay = sessionDay(household, dish.cooking.session)
    const limit = Math.min(dish.entry.enrichment.fridgeDays, household.fridgeDaysCap)
    const late = dish.days.filter((day) => day - cookingDay > limit)
    return late.length === 0 ? [] : [
      finding(
        "error",
        "not_fresh",
        `${nameOf(dish)} хранится в холодильнике не больше ${limit} дн. (готовится в сессии ${dish.cooking.session}, день ${cookingDay}), но стоит в меню: ${
          late.map((day) => `день ${day} (через ${day - cookingDay} дн.)`).join(", ")
        }.`,
        [dish.recipeId],
        late
      )
    ]
  })

/** Heat above `maxHeat` is an error. Heat at `maxHeat` is a warning, except heat 0. */
const heat = ({ cooked, household }: Context): ReadonlyArray<Finding> =>
  cooked.flatMap((dish) => {
    const level = dish.entry.enrichment.heat
    if (level > household.maxHeat) {
      return [
        finding("error", "heat", `${nameOf(dish)}: острота ${level}, а допустимо не больше ${household.maxHeat}.`, [dish.recipeId], dish.days)
      ]
    }
    return level === household.maxHeat && level > 0
      ? [finding("warning", "heat", `${nameOf(dish)}: острота ${level} — предел для семьи.`, [dish.recipeId], dish.days)]
      : []
  })

const equipment = ({ cooked, household }: Context): ReadonlyArray<Finding> =>
  cooked.flatMap((dish) => {
    const missing = dish.entry.enrichment.equipment.filter((item) => !household.equipment.includes(item))
    return missing.length === 0 ? [] : [
      finding(
        "error",
        "equipment",
        `${nameOf(dish)} требует оборудование, которого нет: ${missing.map((item) => `${EQUIPMENT_LABELS[item]} (${item})`).join(", ")}.`,
        [dish.recipeId],
        dish.days
      )
    ]
  })

const activeMinutesOf = (dish: CookedDish): number =>
  dish.entry.enrichment.activeMinutes * (dish.cooking.scale > BIG_BATCH_SCALE ? BIG_BATCH_FACTOR : 1)

const sessionMinutes = ({ cooked, household }: Context) =>
  household.sessions.map((session) => {
    const dishes = cooked.filter((dish) => dish.cooking.session === session.id)
    return { session, dishes, minutes: dishes.reduce((total, dish) => total + activeMinutesOf(dish), 0) }
  })

const activeTime = (context: Context): ReadonlyArray<Finding> =>
  sessionMinutes(context).flatMap(({ session, dishes, minutes }) =>
    minutes > context.household.activeMinutesPerSession
      ? [
        finding(
          "warning",
          "active_time",
          `Сессия ${session.id} (день ${session.dayOffset}): ${formatNumber(minutes)} мин. активной работы при норме ${context.household.activeMinutesPerSession}.`,
          dishes.map((dish) => dish.recipeId),
          [session.dayOffset]
        )
      ]
      : []
  )

/** A wait above `longWaitHoursMax` is an error. Any other wait is a warning. */
const longWait = ({ cooked, household }: Context): ReadonlyArray<Finding> =>
  cooked.flatMap((dish) => {
    const hours = dish.entry.enrichment.longWaitHours
    if (hours === null || hours <= 0) {
      return []
    }
    return hours > household.longWaitHoursMax
      ? [
        finding(
          "error",
          "long_wait",
          `${nameOf(dish)}: ожидание ${formatNumber(hours)} ч., а допустимо не больше ${household.longWaitHoursMax} ч.`,
          [dish.recipeId],
          dish.days
        )
      ]
      : [finding("warning", "long_wait", `${nameOf(dish)}: нужно заранее запланировать ожидание ${formatNumber(hours)} ч.`, [dish.recipeId], dish.days)]
  })

const familiesOf = (cooked: ReadonlyArray<CookedDish>): ReadonlyArray<ProteinFamily> =>
  ProteinFamily.literals.filter((family) => cooked.some((dish) => dish.entry.enrichment.proteinFamilies.includes(family)))

/** More families than `maxProteinFamilies` is an error. Two or more families are a warning. */
const proteinFamilies = ({ cooked, household }: Context): ReadonlyArray<Finding> => {
  const families = familiesOf(cooked)
  const ids = cooked.filter((dish) => dish.entry.enrichment.proteinFamilies.length > 0).map((dish) => dish.recipeId)
  const list = families.map((family) => PROTEIN_LABELS[family]).join(", ")
  if (families.length > household.maxProteinFamilies) {
    return [
      finding("error", "protein_families", `Белков больше допустимого: ${families.length} (${list}), а нужно не больше ${household.maxProteinFamilies}.`, ids, [])
    ]
  }
  return families.length >= 2
    ? [finding("warning", "protein_families", `Два вида белка: ${list}. Лучше один на неделю.`, ids, [])]
    : []
}

/** A recipe from a saved plan of the last `recentWeeks` weeks before this week. */
const recentRepeat = ({ plan, dishes, history, household }: Context): ReadonlyArray<Finding> => {
  const recent = history.filter((past) =>
    past.weekStart < plan.weekStart && daysBetween(past.weekStart, plan.weekStart) <= household.recentWeeks * 7
  )
  return dishes.flatMap((dish) => {
    const weeks = recent
      .filter((past) =>
        past.cooking.some((entry) => entry.recipeId === dish.recipeId) ||
        past.meals.some((meal) => meal.recipeIds.includes(dish.recipeId))
      )
      .map((past) => past.weekStart)
      .sort()
    return weeks.length === 0 ? [] : [
      finding(
        "warning",
        "recent_repeat",
        `${nameOf(dish)} уже был в плане за последние ${household.recentWeeks} нед.: неделя ${weeks.join(", ")}.`,
        [dish.recipeId],
        []
      )
    ]
  })
}

const sortedDays = (dishes: ReadonlyArray<PlanDish>): ReadonlyArray<number> =>
  [...new Set(dishes.flatMap((dish) => dish.days))].sort((a, b) => a - b)

/** A cooked dish of a type that the household does not eat is an error (spec P4.8). */
const dishTypeExcluded = ({ cooked, taste }: Context): ReadonlyArray<Finding> =>
  cooked.filter((dish) => taste.excludedDishTypes.includes(dish.entry.enrichment.dishType)).map((dish) =>
    finding(
      "error",
      "dish_type_excluded",
      `${nameOf(dish)}: тип блюда «${DISH_TYPE_LABELS[dish.entry.enrichment.dishType]}» (${dish.entry.enrichment.dishType}) семья не ест.`,
      [dish.recipeId],
      dish.days
    )
  )

/** One warning for each side group that 2 or more cooked dishes have (spec P4.8). */
const sideRepeated = ({ cooked, taste }: Context): ReadonlyArray<Finding> =>
  taste.sideGroups.flatMap((group): ReadonlyArray<Finding> => {
    const dishes = cooked.filter((dish) => sideGroupsOf(dish.entry.enrichment.ingredients, taste).includes(group.name))
    return dishes.length < 2 ? [] : [
      finding(
        "warning",
        "side_repeated",
        `Гарнир «${group.name}» в ${dishes.length} блюдах: ${dishes.map(nameOf).join(", ")}. Лучше разные гарниры.`,
        dishes.map((dish) => dish.recipeId),
        sortedDays(dishes)
      )
    ]
  })

/** One warning for each cooked dish in a dinner slot that has a heavy side group or a heavy item (spec P4.8). */
const heavyDinner = ({ cooked, taste }: Context): ReadonlyArray<Finding> =>
  cooked.flatMap((dish): ReadonlyArray<Finding> => {
    const days = [...new Set(dish.slots.filter((slot) => slot.meal === "dinner").map((slot) => slot.day))]
    const { ingredients } = dish.entry.enrichment
    const groups = sideGroupsOf(ingredients, taste).filter((group) => taste.dinnerAvoidSideGroups.has(group))
    const items = buyItemsIn(ingredients, taste.dinnerAvoidItems)
    if (days.length === 0 || groups.length + items.length === 0) {
      return []
    }
    const reasons = [...groups.map((group) => `гарнир «${group}»`), ...items.map((item) => `продукт «${item}»`)]
    return [
      finding(
        "warning",
        "heavy_dinner",
        `${nameOf(dish)} стоит в ужине (дни ${daysText(days)}), а для ужина тяжело: ${reasons.join(", ")}.`,
        [dish.recipeId],
        days
      )
    ]
  })

/** One warning for each limit that more than `maxDishes` cooked dishes break (spec P4.8). */
const itemLimit = ({ cooked, taste }: Context): ReadonlyArray<Finding> =>
  taste.itemLimits.flatMap((limit): ReadonlyArray<Finding> => {
    const dishes = cooked.filter((dish) => hasAnyBuyItem(dish.entry.enrichment.ingredients, limit.items))
    return dishes.length <= limit.maxDishes ? [] : [
      finding(
        "warning",
        "item_limit",
        `Ограничение «${limit.name}»: в ${dishes.length} блюдах, а допустимо не больше ${limit.maxDishes}: ${dishes.map(nameOf).join(", ")}.`,
        dishes.map((dish) => dish.recipeId),
        sortedDays(dishes)
      )
    ]
  })

/** The protein of every slot that has dishes, sorted by day and meal. A slot with a dish outside the catalogue is left out. */
const slotProteins = ({ plan, catalogue }: Context) =>
  [...plan.meals]
    .sort((a, b) => a.day - b.day || (a.meal === b.meal ? 0 : a.meal === "lunch" ? -1 : 1))
    .flatMap((slot) => {
      const entries = slot.recipeIds.map((id) => catalogue.byId.get(id))
      const known = entries.flatMap((entry) => entry === undefined ? [] : [entry])
      if (known.length === 0 || known.length !== entries.length) {
        return []
      }
      const dishes = known.map((entry) => ({ entry, protein: portionProtein(entry, catalogue.proteinTable) }))
      return [{
        slot,
        dishes,
        grams: Math.round(dishes.reduce((total, dish) => total + dish.protein.grams, 0) * 10) / 10,
        coverage: Math.min(...dishes.map((dish) => dish.protein.coverage))
      }]
    })

/**
 * `low_protein` (warning, spec P7.1): the protein of a slot is below the minimum of its meal.
 * 1 warning for each set of dishes (sorted recipe IDs) and meal, with the days.
 * The rule is off if the protein table is empty.
 */
const lowProtein = (context: Context): ReadonlyArray<Finding> => {
  // Without a protein table every slot has 0 g. That is missing data, not a finding.
  if (context.catalogue.proteinTable.size === 0) {
    return []
  }
  const groups = new Map<string, Array<ReturnType<typeof slotProteins>[number]>>()
  for (const item of slotProteins(context)) {
    if (item.grams < context.household.proteinMinGrams[item.slot.meal]) {
      const key = `${item.slot.meal}/${[...item.slot.recipeIds].sort((a, b) => a - b).join(",")}`
      groups.set(key, [...(groups.get(key) ?? []), item])
    }
  }
  return [...groups.values()].flatMap((items): ReadonlyArray<Finding> => {
    const first = items[0]
    if (first === undefined) {
      return []
    }
    const { meal } = first.slot
    const minimum = context.household.proteinMinGrams[meal]
    const days = items.map((item) => item.slot.day)
    const ids = [...first.slot.recipeIds].sort((a, b) => a - b)
    const uncertain = first.dishes.filter((dish) => dish.protein.coverage < UNCERTAIN_COVERAGE)
    const note = uncertain.length === 0 ? "" : ` Оценка неточная: в таблице белка нет части продуктов блюд ${
      uncertain.map((dish) => `«${dish.entry.title}» (${dish.entry.id}, покрытие ${Math.round(dish.protein.coverage * 100)}%)`).join(", ")
    }.`
    return [
      finding(
        "warning",
        "low_protein",
        `Мало белка в приёме пищи «${MEAL_LABELS[meal]}» (дни ${daysText(days)}): ${formatNumber(first.grams)} г на порцию при норме не меньше ${minimum} г. Блюда: ${
          first.dishes.map((dish) => `«${dish.entry.title}» (${dish.entry.id})`).join(", ")
        }.${note}`,
        ids,
        days
      )
    ]
  })
}

const metricsOf = (context: Context): PlanMetrics => {
  const { plan, household, cooked } = context
  const ingredients = cooked.flatMap((dish) => dish.entry.enrichment.ingredients)
  const required = household.days * household.meals.length
  const filled = new Set(plan.meals.filter((entry) => entry.recipeIds.length > 0).map((entry) => `${entry.day}/${entry.meal}`))
  return {
    buyItemCount: new Set(ingredients.filter(isBuyIngredient).map((ingredient) => ingredient.item)).size,
    pantryItemCount: new Set(ingredients.filter((ingredient) => ingredient.pantry).map((ingredient) => ingredient.item)).size,
    proteinFamilies: familiesOf(cooked),
    dishCount: cooked.length,
    portions: cooked.map((dish) => portionsOf(dish, household)),
    activeMinutes: sessionMinutes(context).map(({ session, minutes }) => ({ session: session.id, minutes })),
    slotsCovered: Array.from({ length: household.days }, (_, day) => day).reduce(
      (count, day) => count + household.meals.filter((meal) => filled.has(`${day}/${meal}`)).length,
      0
    ),
    slotsRequired: required,
    proteinPerSlot: slotProteins(context).map(({ slot, grams, coverage }): SlotProtein => ({
      day: slot.day,
      meal: slot.meal,
      grams,
      coverage
    }))
  }
}

/** The rules of spec P4.4 and P4.8 in the order of the table. Every rule runs: the result lists all the problems. */
const RULES: ReadonlyArray<(context: Context) => ReadonlyArray<Finding>> = [
  unknownRecipes,
  notCooked,
  cookedNotEaten,
  slotMissing,
  slotNotAMeal,
  eatenBeforeCooked,
  portions,
  tooManyDays,
  sameDayTwice,
  notFresh,
  heat,
  equipment,
  activeTime,
  longWait,
  proteinFamilies,
  recentRepeat,
  dishTypeExcluded,
  sideRepeated,
  heavyDinner,
  itemLimit,
  lowProtein
]

/**
 * Check a plan against the rules of the household (spec P4.4). Pure.
 *
 * The plan is a decoded `WeekPlan`: the shape is right (see the decoder). The function reports every problem in one pass,
 * and does not stop at the first error. `history` is the list of saved plans, for `recent_repeat`.
 * The dishes that the catalogue does not know are `unknown_recipe`. The rules that need the catalogue skip them.
 * A meal outside the grid `days × meals` counts as eaten, and is not an error.
 */
export const evaluatePlan = (
  plan: WeekPlan,
  catalogue: Catalogue,
  household: Household,
  history: ReadonlyArray<WeekPlan> = []
): PlanEvaluation => {
  const dishes = planDishes(plan, catalogue)
  const context: Context = {
    plan,
    catalogue,
    household,
    history,
    dishes,
    cooked: dishes.filter(isCooked),
    taste: tasteRulesOf(household.preferences, catalogue.aliases)
  }
  const findings = RULES.flatMap((rule) => rule(context))
  const errors = findings.filter((found) => found.level === "error").map((found) => found.issue)
  const warnings = findings.filter((found) => found.level === "warning").map((found) => found.issue)
  return { ok: errors.length === 0, errors, warnings, metrics: metricsOf(context) }
}
