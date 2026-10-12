import { assert, describe, it } from "@effect/vitest"
import type { Catalogue } from "../src/domain/catalogue.ts"
import { DEFAULT_HOUSEHOLD } from "../src/domain/household.ts"
import type { Household } from "../src/domain/household.ts"
import { SHOP_ORDER } from "../src/domain/shopping-list.ts"
import type { ShoppingItem, ShoppingList } from "../src/domain/shopping-list.ts"
import type { PlanScale } from "../src/domain/week-plan.ts"
import { IngredientCategory } from "../src/domain/enriched-recipe.ts"
import { makeAliases } from "../src/planner/items.ts"
import { aggregateAmounts, shoppingList } from "../src/planner/shopping.ts"
import type { ShoppingLine } from "../src/planner/shopping.ts"
import { baseCatalogue, BASE_COOKING, catalogueOf, entryOf, ing, inGrams, planOf } from "./support/planner.ts"
import type { IngredientSpec, PlanSpec } from "./support/planner.ts"

const line = (spec: IngredientSpec, scale: PlanScale = 1): ShoppingLine => ({
  ingredient: { ...spec, line: 0, rawItem: spec.item },
  scale
})

const amountsOf = (lines: ReadonlyArray<ShoppingLine>) => aggregateAmounts(lines).amounts

describe("aggregateAmounts: grams", () => {
  it("sums grams when every line has grams", () => {
    const lines = [line(inGrams("мука", 250)), line(ing("мука", { quantity: 1, unit: "pcs", grams: 125 }))]
    assert.deepStrictEqual(aggregateAmounts(lines), { amounts: [{ unit: "g", value: 375 }], approximate: false })
  })

  it("multiplies grams by the scale of each line", () => {
    const lines = [line(inGrams("рис", 300), 1.5), line(inGrams("рис", 100), 2.5)]
    assert.deepStrictEqual(amountsOf(lines), [{ unit: "g", value: 700 }])
  })

  it("rounds once, at the end: 10,4 + 10,4 is 21 g and not 20 g", () => {
    assert.deepStrictEqual(amountsOf([line(inGrams("соль", 10.4)), line(inGrams("соль", 10.4))]), [{ unit: "g", value: 21 }])
  })

  it("rounds a tie up, and does not lose it to binary arithmetic", () => {
    // 45 g × 1.5 = 67,5 g.
    assert.deepStrictEqual(amountsOf([line(inGrams("масло", 45), 1.5)]), [{ unit: "g", value: 68 }])
    // 0,1 g × 3 is 0,3 g in decimals; many small parts do not drift.
    const tenths = Array.from({ length: 10 }, () => line(inGrams("приправа", 0.1)))
    assert.deepStrictEqual(amountsOf(tenths), [{ unit: "g", value: 1 }])
  })

  it("gives ml when the lines are volumes, and g when a line is a mass", () => {
    assert.deepStrictEqual(amountsOf([line(ing("молоко", { quantity: 200, unit: "ml", grams: 200 }))]), [{ unit: "ml", value: 200 }])
    assert.deepStrictEqual(amountsOf([line(ing("соус", { quantity: 2, unit: "tbsp", grams: 30 }))]), [{ unit: "ml", value: 30 }])
    const mixed = aggregateAmounts([
      line(inGrams("сливки", 100)),
      line(ing("сливки", { quantity: 100, unit: "ml", grams: 100 }))
    ])
    assert.deepStrictEqual(mixed, { amounts: [{ unit: "g", value: 200 }], approximate: true })
  })

  it("uses grams of a count too: 2 pieces with 160 g", () => {
    assert.deepStrictEqual(amountsOf([line(ing("лук", { quantity: 2, unit: "pcs", grams: 160 }))]), [{ unit: "g", value: 160 }])
  })
})

describe("aggregateAmounts: quantities", () => {
  it("sums the quantity of each unit when a line has no grams", () => {
    const lines = [
      line(ing("яйца", { quantity: 3, unit: "pcs" })),
      line(ing("яйца", { quantity: 2, unit: "pcs", grams: 100 }))
    ]
    assert.deepStrictEqual(aggregateAmounts(lines), { amounts: [{ unit: "pcs", value: 5 }], approximate: false })
  })

  it("multiplies the quantity by the scale", () => {
    assert.deepStrictEqual(amountsOf([line(ing("яйца", { quantity: 3, unit: "pcs" }), 1.5)]), [{ unit: "pcs", value: 4.5 }])
    assert.deepStrictEqual(amountsOf([line(ing("яйца", { quantity: 1, unit: "pcs" }), 0.5)]), [{ unit: "pcs", value: 0.5 }])
  })

  it("rounds the quantities to 2 decimals at the end, with exact decimals", () => {
    // 1,005 is 1,00499999999999989… as a binary number. As a decimal it is a tie, and the tie goes up.
    assert.deepStrictEqual(amountsOf([line(ing("лимон", { quantity: 1.005, unit: "pcs" }))]), [{ unit: "pcs", value: 1.01 }])
    assert.deepStrictEqual(amountsOf([line(ing("лимон", { quantity: 2.675, unit: "pcs" }))]), [{ unit: "pcs", value: 2.68 }])
    assert.deepStrictEqual(
      amountsOf([line(ing("лимон", { quantity: 0.1, unit: "pcs" })), line(ing("лимон", { quantity: 0.2, unit: "pcs" }))]),
      [{ unit: "pcs", value: 0.3 }]
    )
    assert.deepStrictEqual(amountsOf([line(ing("лимон", { quantity: 1.15, unit: "pcs" }), 3)]), [{ unit: "pcs", value: 3.45 }])
  })

  it("keeps a sum for each unit and flags a list with mixed units as approximate", () => {
    const lines = [
      line(ing("морковь", { quantity: 3, unit: "pcs" })),
      line(ing("морковь", { quantity: 200, unit: "g" })),
      line(ing("морковь", { quantity: 1, unit: "pcs" }))
    ]
    assert.deepStrictEqual(aggregateAmounts(lines), {
      amounts: [{ unit: "g", value: 200 }, { unit: "pcs", value: 4 }],
      approximate: true
    })
  })

  it("uses the grams of a line only if every line has them", () => {
    const lines = [line(inGrams("морковь", 300)), line(ing("морковь", { quantity: 2, unit: "pcs" }))]
    assert.deepStrictEqual(aggregateAmounts(lines), {
      amounts: [{ unit: "g", value: 300 }, { unit: "pcs", value: 2 }],
      approximate: true
    })
  })

  it("turns tbsp into 15 ml and tsp into 5 ml, and adds them to ml, if the product also has ml", () => {
    const lines = [
      line(ing("уксус", { quantity: 2, unit: "tbsp" })),
      line(ing("уксус", { quantity: 3, unit: "tsp" })),
      line(ing("уксус", { quantity: 100, unit: "ml" }))
    ]
    assert.deepStrictEqual(aggregateAmounts(lines), { amounts: [{ unit: "ml", value: 145 }], approximate: false })
    assert.deepStrictEqual(
      aggregateAmounts([line(ing("уксус", { quantity: 1, unit: "tbsp" }), 1.5), line(ing("уксус", { quantity: 100, unit: "ml" }))]),
      { amounts: [{ unit: "ml", value: 123 }], approximate: false }
    )
    // One spoon line and one ml line: the spoons are not left apart.
    assert.deepStrictEqual(amountsOf([line(ing("сок", { quantity: 1, unit: "tsp" })), line(ing("сок", { quantity: 50, unit: "ml" }))]), [
      { unit: "ml", value: 55 }
    ])
  })

  it("keeps spoons if every line is in spoons: 2 tbsp and 1 tbsp are 3 tbsp", () => {
    const lines = [line(ing("мёд", { quantity: 2, unit: "tbsp" })), line(ing("мёд", { quantity: 1, unit: "tbsp" }))]
    assert.deepStrictEqual(aggregateAmounts(lines), { amounts: [{ unit: "tbsp", value: 3 }], approximate: false })
    assert.deepStrictEqual(amountsOf([line(ing("мёд", { quantity: 1.5, unit: "tbsp" }))]), [{ unit: "tbsp", value: 1 }, { unit: "tsp", value: 1.5 }])
  })

  it("sums spoons in teaspoons: a multiple of 3 is tablespoons, the rest is teaspoons", () => {
    // 2 tbsp + 3 tsp = 9 tsp.
    const nine = [line(ing("мёд", { quantity: 2, unit: "tbsp" })), line(ing("мёд", { quantity: 3, unit: "tsp" }))]
    assert.deepStrictEqual(aggregateAmounts(nine), { amounts: [{ unit: "tbsp", value: 3 }], approximate: false })
    // 1 tbsp + 1 tsp = 4 tsp: 1 tbsp and 1 tsp, and that is 1 sum, not a mix of units.
    const four = [line(ing("мёд", { quantity: 1, unit: "tbsp" })), line(ing("мёд", { quantity: 1, unit: "tsp" }))]
    assert.deepStrictEqual(aggregateAmounts(four), { amounts: [{ unit: "tbsp", value: 1 }, { unit: "tsp", value: 1 }], approximate: false })
    // Less than 1 tbsp stays in tsp: 1 + 1 = 2 tsp.
    assert.deepStrictEqual(amountsOf([line(ing("мёд", { quantity: 1, unit: "tsp" })), line(ing("мёд", { quantity: 1, unit: "tsp" }))]), [
      { unit: "tsp", value: 2 }
    ])
    // 3 tsp alone are 1 tbsp.
    assert.deepStrictEqual(amountsOf([line(ing("мёд", { quantity: 3, unit: "tsp" }))]), [{ unit: "tbsp", value: 1 }])
  })

  it("multiplies spoons by the scale, then splits: 1 tbsp at scale 1,5 is 1 tbsp and 1,5 tsp", () => {
    assert.deepStrictEqual(amountsOf([line(ing("уксус", { quantity: 1, unit: "tbsp" }), 1.5)]), [
      { unit: "tbsp", value: 1 },
      { unit: "tsp", value: 1.5 }
    ])
    // 2 tbsp at scale 1,5 are 9 tsp = 3 tbsp.
    assert.deepStrictEqual(amountsOf([line(ing("уксус", { quantity: 2, unit: "tbsp" }), 1.5)]), [{ unit: "tbsp", value: 3 }])
    // 1 tsp at scale 1,5 stays 1,5 tsp.
    assert.deepStrictEqual(amountsOf([line(ing("уксус", { quantity: 1, unit: "tsp" }), 1.5)]), [{ unit: "tsp", value: 1.5 }])
    // The scale applies to each line before the sum: 1 tbsp at 2 and 1 tsp at 0,5 are 6,5 tsp.
    const lines = [line(ing("уксус", { quantity: 1, unit: "tbsp" }), 2), line(ing("уксус", { quantity: 1, unit: "tsp" }), 0.5)]
    assert.deepStrictEqual(amountsOf(lines), [{ unit: "tbsp", value: 2 }, { unit: "tsp", value: 0.5 }])
  })

  it("keeps the spoons exact for decimals: 0,1 tsp × 30 lines is 3 tsp, which is 1 tbsp", () => {
    const lines = Array.from({ length: 30 }, () => line(ing("приправа", { quantity: 0.1, unit: "tsp" })))
    assert.deepStrictEqual(amountsOf(lines), [{ unit: "tbsp", value: 1 }])
  })

  it("keeps the spoons apart from the other units, and flags the mix as approximate", () => {
    const withPieces = aggregateAmounts([line(ing("лимон", { quantity: 1, unit: "tbsp" })), line(ing("лимон", { quantity: 2, unit: "pcs" }))])
    assert.deepStrictEqual(withPieces, { amounts: [{ unit: "tbsp", value: 1 }, { unit: "pcs", value: 2 }], approximate: true })
    const withoutQuantity = aggregateAmounts([line(ing("мёд", { quantity: 2, unit: "tsp" })), line(ing("мёд"))])
    assert.deepStrictEqual(withoutQuantity, { amounts: [{ unit: "tsp", value: 2 }], approximate: true })
  })

  it("uses the grams of spoon lines when every line has them", () => {
    const lines = [line(ing("сметана", { quantity: 2, unit: "tbsp", grams: 40 })), line(ing("сметана", { quantity: 1, unit: "tbsp", grams: 20 }))]
    assert.deepStrictEqual(aggregateAmounts(lines), { amounts: [{ unit: "ml", value: 60 }], approximate: false })
  })

  it("counts a quantity without a unit as pieces", () => {
    assert.deepStrictEqual(amountsOf([line(ing("лимон", { quantity: 2 }))]), [{ unit: "pcs", value: 2 }])
  })

  it("has no amount if no line has a quantity, and that is not approximate", () => {
    assert.deepStrictEqual(aggregateAmounts([line(ing("соль")), line(ing("соль"))]), { amounts: [], approximate: false })
  })

  it("flags the sum as approximate if a line without quantity adds nothing", () => {
    const lines = [line(ing("укроп", { quantity: 1, unit: "bunch" })), line(ing("укроп"))]
    assert.deepStrictEqual(aggregateAmounts(lines), { amounts: [{ unit: "bunch", value: 1 }], approximate: true })
  })

  it("keeps the units of a count apart", () => {
    const lines = [line(ing("чеснок", { quantity: 3, unit: "clove" })), line(ing("чеснок", { quantity: 1, unit: "pack" }))]
    assert.deepStrictEqual(amountsOf(lines), [{ unit: "clove", value: 3 }, { unit: "pack", value: 1 }])
  })
})

const list = (
  dishes: Readonly<Record<number, ReadonlyArray<IngredientSpec>>>,
  cooking: PlanSpec["cooking"],
  options: { readonly household?: Partial<Household>; readonly catalogue?: Catalogue } = {}
): ShoppingList =>
  shoppingList(
    planOf({ cooking, meals: [] }),
    options.catalogue ?? catalogueOf(Object.entries(dishes).map(([key, ingredients]) => entryOf(Number(key), { ingredients }))),
    { ...DEFAULT_HOUSEHOLD, ...options.household }
  )

const itemNames = (items: ReadonlyArray<ShoppingItem>): ReadonlyArray<string> => items.map((item) => item.item)

describe("shoppingList: sections", () => {
  const result = list(
    {
      1: [
        inGrams("курица", 500, { category: "poultry" }),
        ing("соль", { category: "spice", pantry: true }),
        ing("укроп", { category: "herb", optional: true }),
        ing("мука", { category: "grain", pantry: true, optional: true })
      ]
    },
    [{ session: "A", recipeId: 1 }]
  )

  it("puts non-pantry non-optional items in buy, optional ones in optional, and pantry items in check_at_home", () => {
    assert.deepStrictEqual(result.buy.flatMap((group) => itemNames(group.items)), ["курица"])
    assert.deepStrictEqual(itemNames(result.optional), ["укроп"])
    assert.deepStrictEqual(itemNames(result.check_at_home), ["мука", "соль"])
  })

  it("puts the same product in 2 sections if the lines differ", () => {
    const both = list(
      {
        1: [ing("сметана", { category: "dairy", quantity: 2, unit: "pcs" })],
        2: [ing("сметана", { category: "dairy", optional: true, quantity: 1, unit: "pcs" })]
      },
      [{ session: "A", recipeId: 1 }, { session: "A", recipeId: 2 }]
    )
    assert.deepStrictEqual(both.buy.flatMap((group) => group.items.map((item) => item.amounts)), [[{ unit: "pcs", value: 2 }]])
    assert.deepStrictEqual(both.optional.map((item) => item.amounts), [[{ unit: "pcs", value: 1 }]])
    assert.deepStrictEqual(both.optional[0]?.recipeIds.map(Number), [2])
  })
})

describe("shoppingList: order", () => {
  it("lists every category once in the order of the shop", () => {
    assert.deepStrictEqual([...SHOP_ORDER].sort(), [...IngredientCategory.literals].sort())
    assert.strictEqual(new Set(SHOP_ORDER).size, SHOP_ORDER.length)
  })

  it("groups buy by category in the order of the shop and sorts the names", () => {
    const result = list(
      {
        1: [
          ing("масло", { category: "oil" }),
          ing("сыр", { category: "dairy" }),
          ing("яблоки", { category: "fruit" }),
          ing("морковь", { category: "vegetable" }),
          ing("лук", { category: "vegetable" }),
          ing("треска", { category: "fish" }),
          ing("гвоздика", { category: "other" })
        ]
      },
      [{ session: "A", recipeId: 1 }]
    )
    assert.deepStrictEqual(result.buy.map((group) => group.category), ["vegetable", "fruit", "fish", "dairy", "oil", "other"])
    assert.deepStrictEqual(itemNames(result.buy[0]?.items ?? []), ["лук", "морковь"])
  })

  it("uses the category that most lines name, and the earlier department for a tie", () => {
    const result = list(
      {
        1: [ing("помидоры", { category: "vegetable" })],
        2: [ing("помидоры", { category: "fruit" })],
        3: [ing("помидоры", { category: "fruit" })],
        4: [ing("кинза", { category: "vegetable" })],
        5: [ing("кинза", { category: "herb" })]
      },
      [1, 2, 3, 4, 5].map((recipeId) => ({ session: "A" as const, recipeId }))
    )
    const category = (name: string) => result.buy.find((group) => group.items.some((item) => item.item === name))?.category
    assert.strictEqual(category("помидоры"), "fruit")
    assert.strictEqual(category("кинза"), "vegetable")
  })
})

describe("shoppingList: grouping and recipes", () => {
  it("groups by the normalised item and lists each recipe once, sorted", () => {
    const aliases = makeAliases({ "Репчатый лук": "лук репчатый" })
    const catalogue = catalogueOf(
      [
        entryOf(5, { ingredients: [inGrams("Лук репчатый", 100), inGrams("репчатый лук", 50)], aliases }),
        entryOf(3, { ingredients: [inGrams("лук  репчатый", 200)], aliases })
      ],
      aliases
    )
    const result = list({}, [{ session: "A", recipeId: 5 }, { session: "B", recipeId: 3 }], { catalogue })
    const items = result.buy.flatMap((group) => group.items)
    assert.strictEqual(items.length, 1)
    assert.deepStrictEqual(items[0]?.amounts, [{ unit: "g", value: 350 }])
    assert.deepStrictEqual(items[0]?.recipeIds.map(Number), [3, 5])
  })

  it("multiplies by the scale of the cooking entry of each dish", () => {
    const result = list(
      { 1: [inGrams("рис", 200)], 2: [inGrams("рис", 100)] },
      [{ session: "A", recipeId: 1, scale: 2 }, { session: "B", recipeId: 2, scale: 0.5 }]
    )
    assert.deepStrictEqual(result.buy[0]?.items[0]?.amounts, [{ unit: "g", value: 450 }])
  })

  it("keeps spoons in the list: 2 dishes, one at scale 1,5, give 1 tbsp and 1,5 tsp of vinegar and 2 tbsp and 1,5 tsp of mustard", () => {
    const result = list(
      {
        1: [ing("уксус", { category: "sauce", quantity: 1, unit: "tbsp" }), ing("горчица", { category: "sweet", quantity: 1, unit: "tbsp" })],
        2: [ing("горчица", { category: "sweet", quantity: 1, unit: "tbsp" })]
      },
      [{ session: "A", recipeId: 1, scale: 1.5 }, { session: "B", recipeId: 2 }]
    )
    const amounts = Object.fromEntries(result.buy.flatMap((group) => group.items).map((item) => [item.item, item.amounts]))
    assert.deepStrictEqual(amounts["уксус"], [{ unit: "tbsp", value: 1 }, { unit: "tsp", value: 1.5 }])
    // 4,5 tsp + 3 tsp = 7,5 tsp = 2 tbsp and 1,5 tsp.
    assert.deepStrictEqual(amounts["горчица"], [{ unit: "tbsp", value: 2 }, { unit: "tsp", value: 1.5 }])
  })

  it("lists a recipe that the catalogue does not have, and adds nothing for it", () => {
    const result = list({ 1: [inGrams("рис", 200)] }, [{ session: "A", recipeId: 1 }, { session: "B", recipeId: 99 }])
    assert.deepStrictEqual(result.unknownRecipeIds.map(Number), [99])
    assert.strictEqual(result.buy.flatMap((group) => group.items).length, 1)
  })

  it("describes the cooked dishes by session, with title, link and scale", () => {
    const result = shoppingList(
      planOf({ cooking: BASE_COOKING.map((entry) => entry.recipeId === 6 ? { ...entry, scale: 2 } : entry), meals: [] }),
      baseCatalogue(),
      DEFAULT_HOUSEHOLD
    )
    assert.deepStrictEqual(result.dishes.map((dish) => [Number(dish.recipeId), dish.session, dish.sessionDay, dish.scale]), [
      [1, "A", 0, 1],
      [2, "A", 0, 1],
      [3, "A", 0, 1],
      [4, "A", 0, 1],
      [5, "B", 4, 1],
      [6, "B", 4, 2],
      [7, "B", 4, 1]
    ])
    assert.strictEqual(result.dishes[0]?.title, "Суп Альфа")
    assert.strictEqual(result.weekStart, "2026-10-17")
    assert.strictEqual(result.shoppingDay, 0)
  })
})

describe("shoppingList: freeze action", () => {
  const dishes = {
    1: [inGrams("курица", 500, { category: "poultry" }), inGrams("рис", 200, { category: "grain" })],
    2: [inGrams("курица", 300, { category: "poultry" }), inGrams("говядина", 600, { category: "meat" })]
  }
  const cooking: PlanSpec["cooking"] = [{ session: "A", recipeId: 1 }, { session: "B", recipeId: 2 }]
  const TEXT = "заморозить в день покупки, разморозить в холодильнике накануне сессии B"

  it("adds the action for raw protein that session B uses 4 days after the shopping day", () => {
    const result = list(dishes, cooking)
    assert.deepStrictEqual(result.actions.map((action) => [action.item, action.session, action.text]), [
      ["говядина", "B", TEXT],
      ["курица", "B", TEXT]
    ])
  })

  it("covers the part of the session only: amounts and recipes", () => {
    const chicken = list(dishes, cooking).actions.find((action) => action.item === "курица")
    assert.deepStrictEqual(chicken?.amounts, [{ unit: "g", value: 300 }])
    assert.deepStrictEqual(chicken?.recipeIds.map(Number), [2])
    // The shopping list still has the sum of both sessions.
    const listed = list(dishes, cooking).buy.flatMap((group) => group.items).find((item) => item.item === "курица")
    assert.deepStrictEqual(listed?.amounts, [{ unit: "g", value: 800 }])
  })

  it("adds nothing for session A on the shopping day", () => {
    assert.notInclude(list(dishes, cooking).actions.map((action) => action.session), "A")
  })

  it("adds nothing for products that are not raw animal products", () => {
    assert.notInclude(list(dishes, cooking).actions.map((action) => action.item), "рис")
  })

  it("covers poultry, meat, fish and seafood", () => {
    const result = list(
      {
        1: [
          ing("филе", { category: "poultry" }),
          ing("фарш", { category: "meat" }),
          ing("лосось", { category: "fish" }),
          ing("креветки", { category: "seafood" }),
          ing("сыр", { category: "dairy" })
        ]
      },
      [{ session: "B", recipeId: 1 }]
    )
    assert.deepStrictEqual(result.actions.map((action) => action.item), ["креветки", "лосось", "филе", "фарш"].sort())
  })

  it("uses the days of the household: the shopping day and rawProteinFridgeDays", () => {
    // Session B on day 4 minus the shopping day 2 is 2 days: not more than 2.
    assert.deepStrictEqual(list(dishes, cooking, { household: { shoppingDayOffset: 2 } }).actions, [])
    assert.strictEqual(list(dishes, cooking, { household: { shoppingDayOffset: 1 } }).actions.length, 2)
    assert.deepStrictEqual(list(dishes, cooking, { household: { rawProteinFridgeDays: 4 } }).actions, [])
    assert.strictEqual(list(dishes, cooking, { household: { rawProteinFridgeDays: 3 } }).actions.length, 2)
  })

  it("covers session A too if it is later than the limit", () => {
    const result = list(dishes, cooking, {
      household: { sessions: [{ id: "A", dayOffset: 3 }, { id: "B", dayOffset: 5 }] }
    })
    assert.deepStrictEqual(result.actions.map((action) => [action.session, action.item]), [
      ["A", "курица"],
      ["B", "говядина"],
      ["B", "курица"]
    ])
    assert.include(result.actions[0]?.text ?? "", "сессии A")
  })

  it("adds nothing for pantry and optional lines", () => {
    const result = list(
      { 1: [ing("икра", { category: "fish", optional: true }), ing("рыбный соус", { category: "fish", pantry: true })] },
      [{ session: "B", recipeId: 1 }]
    )
    assert.deepStrictEqual(result.actions, [])
  })
})
