import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { DEFAULT_HOUSEHOLD } from "../src/domain/household.ts"
import type { ShoppingItem, ShoppingList } from "../src/domain/shopping-list.ts"
import { dateLabel, dayLabel, formatAmount, formatNumber } from "../src/planner/labels.ts"
import { shoppingList } from "../src/planner/shopping.ts"
import { renderShoppingList, renderShoppingText } from "../src/planner/shopping-render.ts"
import { id } from "./support/enrich.ts"
import { baseCatalogue, BASE_COOKING, BASE_MEALS, catalogueOf, entryOf, ing, planOf } from "./support/planner.ts"

describe("renderShoppingList: golden week", () => {
  // The synthetic week of test/support/planner.ts. Dish 3 is cooked at scale 1,5.
  const plan = planOf({
    cooking: BASE_COOKING.map((entry) => (entry.recipeId === 3 ? { ...entry, scale: 1.5 } : entry)),
    meals: BASE_MEALS,
  })
  const rendered = renderShoppingList(shoppingList(plan, baseCatalogue(), DEFAULT_HOUSEHOLD))

  it("renders the whole synthetic week as in test/fixtures/planner/golden-week.md", () => {
    const expected = readFileSync(new URL("./fixtures/planner/golden-week.md", import.meta.url), "utf8")
    assert.strictEqual(rendered, expected)
  })

  it("ends with 1 newline and has no trailing spaces", () => {
    assert.isTrue(rendered.endsWith("\n"))
    assert.isFalse(rendered.endsWith("\n\n"))
    assert.notMatch(rendered, / +\n/)
  })

  it("has the sections in order: buy, freeze, optional, check at home, dishes", () => {
    const headings = rendered.split("\n").filter((text) => text.startsWith("## "))
    assert.deepStrictEqual(headings, ["## Купить", "## Заморозка", "## По желанию", "## Проверить дома", "## Блюда"])
  })

  it("shows the sum in grams, the mixed units as approximate, and the scale", () => {
    assert.include(rendered, "- [ ] лук репчатый — 450 г (блюда: 1, 2, 3)")
    assert.include(rendered, "- [ ] морковь — ≈ 200 г + 4,5 шт. (блюда: 3, 7)")
    assert.include(rendered, "- [ ] рис — 450 г (блюда: 3)")
    assert.include(rendered, "(3), масштаб ×1,5")
  })

  it("shows the eggs as pieces with the grams", () => {
    assert.include(rendered, "- [ ] яйца — 6 шт. (≈ 300 г) (блюда: 4, 5)")
  })

  it("shows the freeze action for the raw poultry that session B uses", () => {
    assert.include(
      rendered,
      "- **куриное филе** — 400 г для сессии B (блюда: 7): заморозить в день покупки, разморозить в холодильнике накануне сессии B."
    )
  })
})

describe("renderShoppingList: spoons", () => {
  const spoonList = (
    item: string,
    lines: ReadonlyArray<{
      readonly quantity: number
      readonly unit: "tbsp" | "tsp" | "ml"
    }>,
    scale: 1 | 1.5 = 1
  ): string => {
    const catalogue = catalogueOf([
      entryOf(1, {
        ingredients: lines.map((line) => ing(item, { category: "sauce", ...line })),
      }),
    ])
    const plan = planOf({
      cooking: [{ session: "A", recipeId: 1, scale }],
      meals: [],
    })
    return renderShoppingList(shoppingList(plan, catalogue, DEFAULT_HOUSEHOLD))
  }

  it("writes tablespoons when the total is a multiple of 3 teaspoons", () => {
    assert.include(
      spoonList("уксус", [
        { quantity: 2, unit: "tbsp" },
        { quantity: 3, unit: "tsp" },
      ]),
      "- [ ] уксус — 3 ст. л. (блюда: 1)"
    )
    assert.include(spoonList("уксус", [{ quantity: 3, unit: "tsp" }]), "- [ ] уксус — 1 ст. л. (блюда: 1)")
  })

  it("writes teaspoons for a total below 1 tablespoon, and both for the rest, without the approximate sign", () => {
    assert.include(spoonList("уксус", [{ quantity: 2, unit: "tsp" }]), "- [ ] уксус — 2 ч. л. (блюда: 1)")
    assert.include(
      spoonList("уксус", [
        { quantity: 1, unit: "tbsp" },
        { quantity: 1, unit: "tsp" },
      ]),
      "- [ ] уксус — 1 ст. л. + 1 ч. л. (блюда: 1)"
    )
  })

  it("writes the scale of 1,5 with a decimal comma", () => {
    assert.include(
      spoonList("уксус", [{ quantity: 1, unit: "tbsp" }], 1.5),
      "- [ ] уксус — 1 ст. л. + 1,5 ч. л. (блюда: 1)"
    )
    assert.include(spoonList("уксус", [{ quantity: 2, unit: "tbsp" }], 1.5), "- [ ] уксус — 3 ст. л. (блюда: 1)")
  })

  it("writes millilitres when the product also has ml", () => {
    assert.include(
      spoonList("уксус", [
        { quantity: 2, unit: "tbsp" },
        { quantity: 100, unit: "ml" },
      ]),
      "- [ ] уксус — 130 мл (блюда: 1)"
    )
  })
})

describe("renderShoppingList: small lists", () => {
  const empty: ShoppingList = {
    weekStart: "2026-10-17",
    shoppingDay: 0,
    buy: [],
    optional: [],
    check_at_home: [],
    actions: [],
    dishes: [],
    unknownRecipeIds: [],
    extras: [],
    simpleBreakfasts: [],
    unknownSimpleIds: [],
  }

  it("says that there is nothing to buy, and leaves the empty sections out", () => {
    assert.strictEqual(
      renderShoppingList(empty),
      "# Список покупок: неделя с 2026-10-17\n\nДень покупки: суббота, 2026-10-17 (день 0).\n\n## Купить\n\nПокупать нечего.\n"
    )
  })

  it("writes the weekly extras after the departments, and leaves the section out when empty", () => {
    const extras = [
      {
        item: "вафли",
        amount: "1 упаковка",
        category: "sweet",
        note: "Соне на завтраки",
      },
      {
        item: "яйца",
        amount: "7 шт",
        category: "eggs",
        note: "Соне на завтраки",
      },
    ] as const
    const text = renderShoppingList({ ...empty, extras })
    assert.include(
      text,
      "Покупать нечего.\n\n## Каждую неделю\n\n- вафли — 1 упаковка (Соне на завтраки)\n- яйца — 7 шт (Соне на завтраки)\n"
    )
    assert.notInclude(renderShoppingList(empty), "Каждую неделю")
  })

  it("warns about recipes that the catalogue does not have", () => {
    const text = renderShoppingList({
      ...empty,
      unknownRecipeIds: [12, 99].map(id),
    })
    assert.include(text, "**Внимание:** рецептов 12, 99 нет в каталоге.")
  })

  it("escapes brackets in the title of a link", () => {
    const text = renderShoppingList({
      ...empty,
      dishes: [
        {
          recipeId: id(5),
          title: "Суп [тест]",
          url: "https://example.org/5",
          session: "A",
          sessionDay: 0,
          freshDays: [],
          scale: 1,
        },
      ],
    })
    assert.include(text, "- [Суп \\[тест\\]](https://example.org/5) (5)")
  })

  it("shows the shopping day with its weekday", () => {
    const text = renderShoppingList({ ...empty, shoppingDay: 2 })
    assert.include(text, "День покупки: понедельник, 2026-10-19 (день 2).")
  })
})

describe("formatAmount", () => {
  it("writes grams, and kilograms from 1000 g with 1 decimal", () => {
    assert.strictEqual(formatAmount("g", 450), "450 г")
    assert.strictEqual(formatAmount("g", 999), "999 г")
    assert.strictEqual(formatAmount("g", 1000), "1,0 кг")
    assert.strictEqual(formatAmount("g", 1249), "1,2 кг")
    assert.strictEqual(formatAmount("g", 1250), "1,3 кг")
    assert.strictEqual(formatAmount("g", 2000), "2,0 кг")
    assert.strictEqual(formatAmount("g", 12500), "12,5 кг")
  })

  it("writes millilitres, and litres from 1000 ml with 1 decimal", () => {
    assert.strictEqual(formatAmount("ml", 250), "250 мл")
    assert.strictEqual(formatAmount("ml", 1500), "1,5 л")
    assert.strictEqual(formatAmount("ml", 1000), "1,0 л")
  })

  it("writes pieces and spoons without a plural", () => {
    assert.strictEqual(formatAmount("pcs", 3), "3 шт.")
    assert.strictEqual(formatAmount("pcs", 1.5), "1,5 шт.")
    assert.strictEqual(formatAmount("pcs", 0.25), "0,25 шт.")
    assert.strictEqual(formatAmount("tbsp", 2), "2 ст. л.")
    assert.strictEqual(formatAmount("tsp", 0.5), "0,5 ч. л.")
  })

  it("agrees the other units with the number", () => {
    const forms = (unit: "pinch" | "bunch" | "clove" | "slice" | "pack") =>
      [1, 2, 4, 5, 11, 12, 21, 22, 25, 111].map((value) => formatAmount(unit, value))
    assert.deepStrictEqual(forms("bunch"), [
      "1 пучок",
      "2 пучка",
      "4 пучка",
      "5 пучков",
      "11 пучков",
      "12 пучков",
      "21 пучок",
      "22 пучка",
      "25 пучков",
      "111 пучков",
    ])
    assert.strictEqual(formatAmount("clove", 3), "3 зубчика")
    assert.strictEqual(formatAmount("clove", 6), "6 зубчиков")
    assert.strictEqual(formatAmount("slice", 1), "1 ломтик")
    assert.strictEqual(formatAmount("slice", 2), "2 ломтика")
    assert.strictEqual(formatAmount("pack", 1), "1 упаковка")
    assert.strictEqual(formatAmount("pack", 2), "2 упаковки")
    assert.strictEqual(formatAmount("pack", 5), "5 упаковок")
    assert.strictEqual(formatAmount("pinch", 1), "1 щепотка")
    assert.strictEqual(formatAmount("pinch", 3), "3 щепотки")
    assert.strictEqual(formatAmount("pinch", 7), "7 щепоток")
  })

  it("uses the form of a fraction for a fraction", () => {
    assert.strictEqual(formatAmount("bunch", 1.5), "1,5 пучка")
    assert.strictEqual(formatAmount("pack", 0.5), "0,5 упаковки")
  })
})

describe("labels", () => {
  it("formats a number with a comma and no trailing zeros", () => {
    assert.strictEqual(formatNumber(2), "2")
    assert.strictEqual(formatNumber(1.5), "1,5")
    assert.strictEqual(formatNumber(0.25), "0,25")
  })

  it("names the weekday of a day of the plan week", () => {
    assert.strictEqual(dayLabel("2026-10-17", 0), "день 0 (суббота)")
    assert.strictEqual(dayLabel("2026-10-17", 2), "день 2 (понедельник)")
    assert.strictEqual(dateLabel("2026-10-17", 6), "пятница, 2026-10-23")
  })
})

describe("renderShoppingList: units for the shopper", () => {
  const render = (ingredients: ReturnType<typeof ing>[]): string =>
    renderShoppingList(
      shoppingList(
        planOf({ cooking: [{ session: "A", recipeId: 1 }], meals: [] }),
        catalogueOf([entryOf(1, { ingredients })]),
        DEFAULT_HOUSEHOLD
      )
    )

  it("writes eggs as «8 шт. (≈ 413 г)»", () => {
    assert.include(
      render([ing("яйца", { category: "eggs", quantity: 413, unit: "g", grams: 413 })]),
      "- [ ] яйца — 8 шт. (≈ 413 г) (блюда: 1)"
    )
  })

  it("writes a cereal in millilitres as «≈ 255 г»", () => {
    assert.include(
      render([
        ing("гречка", {
          category: "grain",
          quantity: 300,
          unit: "ml",
          grams: 300,
        }),
      ]),
      "- [ ] гречка — ≈ 255 г (блюда: 1)"
    )
  })

  it("keeps the usual mix of grams and pieces", () => {
    assert.include(
      render([ing("морковь", { quantity: 200, unit: "g", grams: null }), ing("морковь", { quantity: 2, unit: "pcs" })]),
      "- [ ] морковь — ≈ 200 г + 2 шт. (блюда: 1)"
    )
  })
})

describe("renderShoppingText", () => {
  const item = (
    name: string,
    amounts: ShoppingItem["amounts"],
    recipeIds: ReadonlyArray<number> = [1]
  ): ShoppingItem => ({
    item: name,
    category: "other",
    amounts,
    approximate: false,
    recipeIds: recipeIds.map(id),
    simpleIds: [],
  })
  const list: ShoppingList = {
    weekStart: "2026-10-17",
    shoppingDay: 0,
    buy: [
      {
        category: "vegetable",
        items: [item("лук репчатый", [{ unit: "g", value: 450 }], [1, 2, 3])],
      },
      {
        category: "eggs",
        items: [
          item(
            "яйца",
            [
              { unit: "pcs", value: 8 },
              { unit: "g", value: 413 },
            ],
            [4, 5]
          ),
        ],
      },
      { category: "spice", items: [item("соль", [])] },
    ],
    optional: [item("сметана", [{ unit: "ml", value: 1500 }], [6])],
    check_at_home: [item("мука", [{ unit: "g", value: 300 }])],
    actions: [],
    dishes: [],
    unknownRecipeIds: [],
    extras: [],
    simpleBreakfasts: [],
    unknownSimpleIds: [],
  }

  it("writes one line per item to buy, with the amount and without the recipe IDs, and ends with 1 newline", () => {
    assert.strictEqual(
      renderShoppingText(list, { withOptional: false }),
      "лук репчатый — 450 г\nяйца — 8 шт. (≈ 413 г)\nсоль\n"
    )
  })

  it("adds the optional items after the items to buy when withOptional is set", () => {
    assert.strictEqual(
      renderShoppingText(list, { withOptional: true }),
      "лук репчатый — 450 г\nяйца — 8 шт. (≈ 413 г)\nсоль\nсметана — 1,5 л\n"
    )
  })

  it("adds one line per weekly extra after the items to buy", () => {
    const extras = [
      {
        item: "яйца",
        amount: "7 шт",
        category: "eggs",
        note: "Соне на завтраки",
      },
    ] as const
    assert.strictEqual(
      renderShoppingText({ ...list, extras }, { withOptional: true }),
      "лук репчатый — 450 г\nяйца — 8 шт. (≈ 413 г)\nсоль\nяйца — 7 шт (Соне на завтраки)\nсметана — 1,5 л\n"
    )
  })

  it("keeps the check-at-home items out of the text", () => {
    assert.notInclude(renderShoppingText(list, { withOptional: true }), "мука")
  })

  it("writes the approximate sign as in the Markdown list", () => {
    const text = renderShoppingText(
      {
        ...list,
        buy: [
          {
            category: "grain",
            items: [
              {
                ...item("гречка", [{ unit: "g", value: 255 }]),
                approximate: true,
              },
            ],
          },
        ],
      },
      { withOptional: false }
    )
    assert.strictEqual(text, "гречка — ≈ 255 г\n")
  })

  it("gives an empty text for a list with nothing to buy", () => {
    assert.strictEqual(renderShoppingText({ ...list, buy: [], optional: [] }, { withOptional: true }), "")
  })
})
