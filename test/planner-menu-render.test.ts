import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { DEFAULT_HOUSEHOLD } from "../src/domain/household.ts"
import type { Household } from "../src/domain/household.ts"
import type { SimpleBreakfast } from "../src/domain/simple-breakfast.ts"
import { evaluatePlan } from "../src/planner/evaluate.ts"
import { renderMenu } from "../src/planner/menu-render.ts"
import { shoppingList } from "../src/planner/shopping.ts"
import { renderShoppingList, renderShoppingText } from "../src/planner/shopping-render.ts"
import {
  baseEntries,
  baseCatalogue,
  BASE_COOKING,
  BASE_MEALS,
  catalogueOf,
  entryOf,
  inGrams,
  planOf,
} from "./support/planner.ts"

/** The menu of the synthetic week of test/support/planner.ts. Dish 3 is cooked at scale 1,5. */
const menuOf = (
  notes: string | null,
  meals: typeof BASE_MEALS = BASE_MEALS,
  overrides: Parameters<typeof baseCatalogue>[0] = {}
): string => {
  const plan = planOf({
    cooking: BASE_COOKING.map((entry) => (entry.recipeId === 3 ? { ...entry, scale: 1.5 } : entry)),
    meals,
    notes,
  })
  const catalogue = baseCatalogue(overrides)
  return renderMenu({
    plan,
    catalogue,
    household: DEFAULT_HOUSEHOLD,
    evaluation: evaluatePlan(plan, catalogue, DEFAULT_HOUSEHOLD),
    list: shoppingList(plan, catalogue, DEFAULT_HOUSEHOLD),
  })
}

describe("renderMenu: golden week", () => {
  const rendered = menuOf("Неделя с курицей.")

  it("renders the whole synthetic week as in test/fixtures/planner/golden-menu.md", () => {
    const expected = readFileSync(new URL("./fixtures/planner/golden-menu.md", import.meta.url), "utf8")
    assert.strictEqual(rendered, expected)
  })

  it("ends with 1 newline and has no trailing spaces", () => {
    assert.isTrue(rendered.endsWith("\n"))
    assert.isFalse(rendered.endsWith("\n\n"))
    assert.notMatch(rendered, / +\n/)
  })

  it("has 1 H1 and the sections in order", () => {
    const lines = rendered.split("\n")
    assert.strictEqual(lines.filter((text) => text.startsWith("# ")).length, 1)
    assert.deepStrictEqual(
      lines.filter((text) => text.startsWith("## ")),
      ["## Меню по дням", "## Сессии готовки", "## Оценка плана", "## Список покупок: неделя с 2026-10-17"]
    )
  })
})

describe("renderMenu: details", () => {
  it("links every dish as [title](url) in the table", () => {
    const rendered = menuOf(null)
    assert.match(rendered, /^\| суббота, 2026-10-17 \| \[Суп Альфа\]\(https?:\/\/[^)]+\) \| \[Рагу Браво\]\(/m)
  })

  it("shows a dash for an empty slot and a note for an unknown recipe", () => {
    const rendered = menuOf(null, [...BASE_MEALS.slice(1, 13), { day: 6, meal: "dinner", recipeIds: [99] }])
    assert.match(rendered, /^\| суббота, 2026-10-17 \| — \|/m)
    assert.include(rendered, "рецепт 99 (нет в каталоге)")
  })

  it("escapes a pipe and brackets in a title", () => {
    const rendered = menuOf(null, BASE_MEALS, {
      1: { title: "Суп | [особый]" },
    })
    assert.include(rendered, "[Суп \\| \\[особый\\]](")
  })

  it("does not print a notes line when notes are null", () => {
    assert.notInclude(menuOf(null), "Неделя с курицей.")
  })
})

describe("renderMenu: breakfast (spec P7.2)", () => {
  const household: Household = {
    ...DEFAULT_HOUSEHOLD,
    meals: ["breakfast", "lunch", "dinner"],
    mealPersons: { breakfast: 2 },
  }
  const yogurt: SimpleBreakfast = {
    id: "yogurt",
    title: "Йогурт с бананом",
    meals: ["breakfast"],
    items: [
      {
        item: "греческий йогурт",
        grams: 200,
        category: "dairy",
        pantry: false,
      },
      { item: "мед", grams: 15, category: "sweet", pantry: true },
    ],
  }
  const toast: SimpleBreakfast = {
    id: "toast",
    title: "Тост | с брынзой",
    meals: ["breakfast"],
    items: [
      { item: "хлеб", grams: 60, category: "bakery", pantry: false },
      { item: "брынза", grams: 30, category: "dairy", pantry: false },
    ],
  }
  const syrniki = entryOf(8, {
    title: "Сырники Гольф",
    enrichment: {
      mealFit: "full_meal",
      servings: { min: 2, max: 4, source: "page" },
      activeMinutes: 15,
      fridgeDays: 1,
    },
    ingredients: [inGrams("творог", 400, { category: "dairy" }), inGrams("яйца", 110, { category: "eggs" })],
  })
  const catalogue = catalogueOf([...baseEntries(), syrniki], undefined, undefined, [yogurt, toast])
  const plan = planOf({
    cooking: [
      ...BASE_COOKING.map((entry) => (entry.recipeId === 3 ? { ...entry, scale: 1.5 as const } : entry)),
      { session: "fresh", recipeId: 8 },
    ],
    meals: [
      ...BASE_MEALS,
      { day: 0, meal: "breakfast", recipeIds: [8], simpleIds: [] },
      { day: 1, meal: "breakfast", recipeIds: [], simpleIds: ["yogurt"] },
      { day: 2, meal: "breakfast", recipeIds: [8], simpleIds: ["yogurt"] },
      { day: 3, meal: "breakfast", recipeIds: [], simpleIds: ["toast"] },
      { day: 4, meal: "breakfast", recipeIds: [8], simpleIds: [] },
      { day: 5, meal: "breakfast", recipeIds: [], simpleIds: ["toast"] },
      { day: 6, meal: "breakfast", recipeIds: [], simpleIds: ["yogurt"] },
    ],
    notes: "Неделя с завтраками.",
  })
  const evaluation = evaluatePlan(plan, catalogue, household)
  const list = shoppingList(plan, catalogue, household)
  const rendered = renderMenu({ plan, catalogue, household, evaluation, list })

  it("renders the whole week as in test/fixtures/planner/golden-menu-breakfast.md", () => {
    const expected = readFileSync(new URL("./fixtures/planner/golden-menu-breakfast.md", import.meta.url), "utf8")
    assert.strictEqual(rendered, expected)
  })

  it("has no error in the evaluation of the synthetic week", () => {
    assert.deepStrictEqual(evaluation.errors, [])
  })

  it("puts the breakfast column first, with a link for a recipe and a plain title for a simple breakfast", () => {
    assert.include(rendered, "| День | завтрак | обед | ужин |")
    assert.match(rendered, /^\| суббота, 2026-10-17 \| \[Сырники Гольф\]\(https?:\/\/[^)]+\) \| /m)
    assert.match(rendered, /^\| воскресенье, 2026-10-18 \| Йогурт с бананом \| /m)
    assert.match(rendered, /^\| понедельник, 2026-10-19 \| \[Сырники Гольф\]\([^)]+\) \+ Йогурт с бананом \| /m)
  })

  it("escapes a pipe in the title of a simple breakfast", () => {
    assert.include(rendered, "Тост \\| с брынзой")
  })

  it("lists the fresh dishes apart from the sessions, under the heading «Утром»", () => {
    const lines = rendered.split("\n")
    const fresh = lines.findIndex((text) => text === "### Утром (свежие блюда)")
    assert.isAbove(
      fresh,
      lines.findIndex((text) => text.startsWith("### Сессия B"))
    )
    assert.include(lines[fresh + 2] ?? "", "Сырники Гольф")
    assert.include(lines[fresh + 2] ?? "", "дни 0, 2, 4")
  })

  it("has no fresh section in a week without fresh dishes", () => {
    assert.notInclude(menuOf(null), "Утром")
  })

  it("renders the shopping list with the simple breakfasts and the fresh dish", () => {
    const text = renderShoppingList(list)
    // 400 g × 3 days and 500 g of dish 5.
    assert.include(text, "- [ ] творог — 1,7 кг (блюда: 5, 8)")
    // 200 g × 2 persons × 3 days.
    assert.include(text, "- [ ] греческий йогурт — 1,2 кг (завтраки: yogurt)")
    assert.include(text, "- мед — 90 г\n")
    assert.include(text, "## Простые завтраки")
    assert.include(text, "- Йогурт с бананом (yogurt): 6 порц., дни 1, 2, 6")
    assert.include(text, "Свежие блюда, утром в день еды:")
    assert.include(text, "(8), дни 0, 2, 4")
  })

  it("prints the new products in the plain text list", () => {
    const lines = renderShoppingText(list, { withOptional: false }).split("\n")
    assert.include(lines, "греческий йогурт — 1,2 кг")
  })
})

describe("renderMenu and shoppingList: simple entries at dinner (spec P7.4.4)", () => {
  const household: Household = {
    ...DEFAULT_HOUSEHOLD,
    meals: ["breakfast", "lunch", "dinner"],
    mealPersons: { breakfast: 2 },
  }
  const tvorog: SimpleBreakfast = {
    id: "tvorog",
    title: "Творог со сметаной",
    meals: ["breakfast", "dinner"],
    items: [{ item: "ряженка", grams: 200, category: "dairy", pantry: false }],
  }
  const catalogue = catalogueOf(baseEntries(), undefined, undefined, [tvorog])
  const plan = planOf({
    cooking: BASE_COOKING,
    meals: [
      ...BASE_MEALS.filter((slot) => !(slot.day === 2 && slot.meal === "dinner")),
      { day: 2, meal: "dinner", recipeIds: [], simpleIds: ["tvorog"] },
      { day: 3, meal: "breakfast", recipeIds: [], simpleIds: ["tvorog"] },
    ],
    notes: null,
  })
  const list = shoppingList(plan, catalogue, household)

  it("shows the entry in the dinner column of its day", () => {
    const rendered = renderMenu({
      plan,
      catalogue,
      household,
      evaluation: evaluatePlan(plan, catalogue, household),
      list,
    })
    assert.match(rendered, /^\| понедельник, 2026-10-19 \| — \| .* \| Творог со сметаной \|$/m)
  })

  it("puts its items in the list times the persons of the slot: 3 at dinner and 2 at breakfast", () => {
    const item = list.buy.flatMap((category) => category.items).find((line) => line.item === "ряженка")
    // 200 g × 3 persons + 200 g × 2 persons.
    assert.deepStrictEqual(item?.amounts, [{ unit: "g", value: 1000 }])
    assert.deepStrictEqual(list.simpleBreakfasts, [
      { id: "tvorog", title: "Творог со сметаной", portions: 5, days: [2, 3] },
    ])
  })
})
