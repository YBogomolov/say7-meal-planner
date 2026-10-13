import { readFileSync } from "node:fs"
import { assert, describe, it } from "@effect/vitest"
import { DEFAULT_HOUSEHOLD } from "../src/domain/household.ts"
import { evaluatePlan } from "../src/planner/evaluate.ts"
import { renderMenu } from "../src/planner/menu-render.ts"
import { shoppingList } from "../src/planner/shopping.ts"
import { baseCatalogue, BASE_COOKING, BASE_MEALS, planOf } from "./support/planner.ts"

/** The menu of the synthetic week of test/support/planner.ts. Dish 3 is cooked at scale 1,5. */
const menuOf = (
  notes: string | null,
  meals: typeof BASE_MEALS = BASE_MEALS,
  overrides: Parameters<typeof baseCatalogue>[0] = {}
): string => {
  const plan = planOf({
    cooking: BASE_COOKING.map((entry) => entry.recipeId === 3 ? { ...entry, scale: 1.5 } : entry),
    meals,
    notes
  })
  const catalogue = baseCatalogue(overrides)
  return renderMenu({
    plan,
    catalogue,
    household: DEFAULT_HOUSEHOLD,
    evaluation: evaluatePlan(plan, catalogue, DEFAULT_HOUSEHOLD),
    list: shoppingList(plan, catalogue, DEFAULT_HOUSEHOLD)
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
    assert.deepStrictEqual(lines.filter((text) => text.startsWith("## ")), [
      "## Меню по дням",
      "## Сессии готовки",
      "## Оценка плана",
      "## Список покупок: неделя с 2026-10-17"
    ])
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
    const rendered = menuOf(null, BASE_MEALS, { 1: { title: "Суп | [особый]" } })
    assert.include(rendered, "[Суп \\| \\[особый\\]](")
  })

  it("does not print a notes line when notes are null", () => {
    assert.notInclude(menuOf(null), "Неделя с курицей.")
  })
})
