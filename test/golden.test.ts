import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { RecipeId } from "../src/domain/recipe.ts"
import { parseRecipeWithWarnings } from "../src/parser/parse.ts"
import type { ParseOutcome } from "../src/parser/parse.ts"

/**
 * Golden tests: one case for each real page in `test/fixtures/real/`.
 * The pages are copyrighted and git-ignored, so this file keeps only short facts:
 * title, counts, the first and the last ingredient line, yield, servings, categories, date.
 * The facts come from reading the pages, not from the output of the parser.
 *
 * The cases skip when a page is absent. `npm run fixtures:refresh` copies the pages from `data/raw/`.
 */

type Category = readonly [id: number, name: string]

interface Golden {
  readonly id: number
  readonly title: string
  /** Title and number of lines of each ingredient group. */
  readonly groups: ReadonlyArray<readonly [title: string | null, lines: number]>
  readonly firstLine: string
  readonly lastLine: string
  readonly steps: number
  /** `null` when the page has no sentence with "порци", or the sentence has no number. */
  readonly servings: readonly [min: number, max: number] | null
  readonly categories: ReadonlyArray<Category>
  /** Number of time mentions in the steps (seconds do not count). */
  readonly durations: number
  readonly longWait: boolean
  readonly addedAt: string
  readonly comments: number
}

const salads = (...rest: ReadonlyArray<Category>): ReadonlyArray<Category> => [[38, "Салаты"], ...rest]
const mains = (...rest: ReadonlyArray<Category>): ReadonlyArray<Category> => [[40, "Вторые блюда"], ...rest]
const fish = (...rest: ReadonlyArray<Category>): ReadonlyArray<Category> => [[44, "Рыба и морепродукты"], ...rest]

const GOLDEN: ReadonlyArray<Golden> = [
  {
    id: 18,
    title: "Салат с кукурузой",
    groups: [[null, 6]],
    firstLine: "250 г крабовых палочек",
    lastLine: "соль",
    steps: 7,
    servings: [7, 8],
    categories: salads(
      [55, "Салаты с майонезом"],
      [53, "Салаты с морепродуктами"],
      [152, "Салаты с крабами"],
      [127, "Салаты с яйцами"],
      [155, "Салаты с кукурузой"]
    ),
    durations: 1,
    longWait: false,
    addedAt: "2006-06-10",
    comments: 331,
  },
  {
    id: 38,
    title: "Жареная рыба под маринадом",
    groups: [
      [null, 5],
      ["маринад:", 10],
    ],
    firstLine: "1 кг рыбы (у меня судак)",
    lastLine: "гвоздика (3–5 штук)",
    steps: 16,
    servings: [6, 8],
    categories: fish([166, "Жареная рыба"]),
    durations: 8,
    longWait: false,
    addedAt: "2006-06-23",
    comments: 265,
  },
  {
    id: 61,
    title: "Греческий салат",
    groups: [
      [null, 6],
      ["соус:", 5],
    ],
    firstLine: "500 г помидоров",
    lastLine: "перец",
    steps: 11,
    servings: [7, 8],
    categories: salads(
      [51, "Салаты без майонеза"],
      [128, "Салаты с сыром"],
      [54, "Овощные салаты"],
      [126, "Салаты с томатами"],
      [129, "Салаты с огурцами"],
      [142, "Салаты с болгарским перцем"]
    ),
    durations: 0,
    longWait: false,
    addedAt: "2006-07-18",
    comments: 999,
  },
  {
    id: 109,
    title: "Фаршированный перец",
    groups: [[null, 10]],
    firstLine: "8–10 шт. болгарского перца",
    lastLine: "растительное масло",
    steps: 15,
    servings: [6, 8],
    categories: mains([71, "Вторые блюда из овощей"], [77, "Вторые блюда из фарша"]),
    durations: 1,
    longWait: false,
    addedAt: "2006-09-07",
    comments: 1896,
  },
  {
    // The intro says "сколько получается порций" and gives no number.
    id: 118,
    title: "Плов",
    groups: [[null, 12]],
    firstLine: "1.5 кг мяса (баранины, свинины или говядины)",
    lastLine: "растительное масло",
    steps: 13,
    servings: null,
    categories: mains([69, "Вторые блюда из баранины"], [70, "Вторые блюда из крупы"]),
    durations: 3,
    longWait: false,
    addedAt: "2008-08-10",
    comments: 3181,
  },
  {
    id: 245,
    title: "Рыба, жаренная в кляре",
    groups: [
      [null, 4],
      ["кляр:", 4],
    ],
    firstLine: "500 г филе рыбы (у меня тилапия)",
    lastLine: "соль",
    steps: 8,
    servings: [8, 10],
    categories: fish([166, "Жареная рыба"]),
    durations: 3,
    longWait: false,
    addedAt: "2007-02-06",
    comments: 745,
  },
  {
    // No block "Категории рецепта": the category comes from the breadcrumb at the top. No sentence with "порци".
    id: 246,
    title: "Сырный суп",
    groups: [[null, 9]],
    firstLine: "500 г куриного филе",
    lastLine: "зелень по вкусу",
    steps: 11,
    servings: null,
    categories: [[47, "Первые блюда"]],
    durations: 3,
    longWait: false,
    addedAt: "2007-02-07",
    comments: 2215,
  },
  {
    // No block "Категории рецепта": the category comes from the breadcrumb at the top. No sentence with "порци".
    id: 275,
    title: "Суп «Шурпа»",
    groups: [[null, 12]],
    firstLine: "700 г баранины или говядины",
    lastLine: "зелень по вкусу",
    steps: 22,
    servings: null,
    categories: [[47, "Первые блюда"]],
    durations: 3,
    longWait: false,
    addedAt: "2007-03-06",
    comments: 1197,
  },
  {
    id: 401,
    title: "Шарлотка",
    groups: [[null, 4]],
    firstLine: "150–200 г сахара",
    lastLine: "500 г яблок",
    steps: 9,
    servings: [6, 8],
    categories: [
      [39, "Выпечка"],
      [112, "Пироги"],
      [226, "Яблочные пироги"],
      [185, "Выпечка с яблочной начинкой"],
    ],
    durations: 2,
    longWait: false,
    addedAt: "2007-04-25",
    comments: 2398,
  },
  {
    id: 913,
    title: "Паста «Карбонара»",
    groups: [[null, 9]],
    firstLine: "200 г спагетти",
    lastLine: "растительное масло",
    steps: 14,
    servings: [4, 6],
    categories: mains([73, "Вторые блюда из макаронных изделий"]),
    durations: 0,
    longWait: false,
    addedAt: "2013-06-04",
    comments: 362,
  },
  {
    // The yield is "100–110 штук", so the page has no sentence with "порци".
    id: 935,
    title: "Пельмени",
    groups: [
      ["тесто:", 5],
      ["начинка:", 5],
      ["также:", 2],
    ],
    firstLine: "250 мл молока",
    lastLine: "5–7 горошин душистого перца",
    steps: 20,
    servings: null,
    categories: mains([77, "Вторые блюда из фарша"]),
    durations: 2,
    longWait: false,
    addedAt: "2013-11-19",
    comments: 530,
  },
  {
    id: 1008,
    title: "Салат «Цезарь»",
    groups: [
      [null, 2],
      ["гренки:", 3],
      ["соус:", 7],
    ],
    firstLine: "200 г салата ромэн",
    lastLine: "перец",
    steps: 22,
    servings: [4, 6],
    categories: salads([51, "Салаты без майонеза"], [149, "Салаты с сухариками"]),
    durations: 3,
    longWait: false,
    addedAt: "2015-01-27",
    comments: 62,
  },
  {
    id: 1057,
    title: "Ростбиф",
    groups: [
      [null, 6],
      ["соус:", 5],
    ],
    firstLine: "1 кг говядины (мраморной)",
    lastLine: "перец",
    steps: 12,
    servings: [6, 8],
    categories: mains([67, "Вторые блюда из говядины"]),
    durations: 3,
    longWait: false,
    addedAt: "2015-12-15",
    comments: 46,
  },
  {
    // The title has nested <span> elements. One ingredient line holds a link ("томатного соуса").
    id: 1171,
    title: "Креветки в кисло-сладком соусе",
    groups: [[null, 10]],
    firstLine: "350 г креветок (неочищенных)",
    lastLine: "перец",
    steps: 13,
    servings: [4, 6],
    categories: fish(),
    durations: 3,
    longWait: false,
    addedAt: "2018-01-16",
    comments: 62,
  },
  {
    id: 1201,
    title: "Ребрышки, запеченные с картофелем",
    groups: [[null, 11]],
    firstLine: "700 г ребрышек (свиных, бараньих)",
    lastLine: "перец",
    steps: 10,
    servings: [4, 6],
    categories: mains([68, "Вторые блюда из свинины"]),
    durations: 3,
    longWait: false,
    addedAt: "2018-03-27",
    comments: 64,
  },
  {
    // The text of a step is "1.5–2 часов".
    id: 1282,
    title: "Свинина гармошка с томатами, сыром, грибами и луком",
    groups: [[null, 8]],
    firstLine: "1 кг свинины (в идеале — корейки)",
    lastLine: "перец",
    steps: 10,
    servings: [6, 8],
    categories: mains([68, "Вторые блюда из свинины"]),
    durations: 1,
    longWait: false,
    addedAt: "2019-11-19",
    comments: 26,
  },
  {
    id: 1321,
    title: "Спагетти с морепродуктами в сливочном соусе",
    groups: [[null, 7]],
    firstLine: "200 г спагетти",
    lastLine: "перец",
    steps: 9,
    servings: [6, 8],
    categories: fish(),
    durations: 2,
    longWait: false,
    addedAt: "2020-03-10",
    comments: 50,
  },
  {
    // No block "Категории рецепта": the category comes from the breadcrumb at the top.
    id: 1372,
    title: "Тефтели в кисло-сладком соусе",
    groups: [
      [null, 8],
      ["соус:", 7],
    ],
    firstLine: "500 г фарша",
    lastLine: "перец",
    steps: 22,
    servings: [6, 8],
    categories: mains(),
    durations: 2,
    longWait: false,
    addedAt: "2021-01-19",
    comments: 44,
  },
  {
    id: 1376,
    title: "Паста «Альфредо»",
    groups: [
      ["соус:", 7],
      ["также:", 1],
    ],
    firstLine: "300 мл сливок 15–20%",
    lastLine: "250 г фетучине",
    steps: 14,
    servings: [4, 6],
    categories: mains([73, "Вторые блюда из макаронных изделий"]),
    durations: 1,
    longWait: false,
    addedAt: "2021-02-09",
    comments: 38,
  },
  {
    id: 1429,
    title: "Куриная печень с грибами в сметанно-горчичном соусе",
    groups: [[null, 8]],
    firstLine: "500 г куриной печени",
    lastLine: "растительное масло",
    steps: 12,
    servings: [6, 8],
    categories: mains([78, "Вторые блюда из субпродуктов"]),
    durations: 3,
    longWait: false,
    addedAt: "2022-08-16",
    comments: 42,
  },
  {
    // The intro has a quotation (div.explain with a blockquote) that is not part of the intro.
    id: 1434,
    title: "Салат «Кобб»",
    groups: [
      [null, 9],
      ["заправка:", 8],
    ],
    firstLine: "300 г куриного филе",
    lastLine: "перец",
    steps: 23,
    servings: [6, 8],
    categories: salads(
      [51, "Салаты без майонеза"],
      [127, "Салаты с яйцами"],
      [128, "Салаты с сыром"],
      [54, "Овощные салаты"],
      [126, "Салаты с томатами"],
      [134, "Салаты с птицей"],
      [132, "Салаты с авокадо"]
    ),
    durations: 0,
    longWait: false,
    addedAt: "2021-11-23",
    comments: 56,
  },
  {
    id: 1587,
    title: "Цыплята, запеченные с оливками и томатами",
    groups: [[null, 10]],
    firstLine: "700 г цыплят",
    lastLine: "растительное масло",
    steps: 10,
    servings: [3, 4],
    categories: mains([71, "Вторые блюда из овощей"], [66, "Вторые блюда из курицы"]),
    durations: 2,
    longWait: false,
    addedAt: "2023-12-26",
    comments: 16,
  },
  {
    // Four ingredient groups, steps in five parts; the step "4–6 часов" sets longWait.
    // No block "Категории рецепта": the category comes from the breadcrumb at the top.
    id: 1590,
    title: "Торт «Три шоколада»",
    groups: [
      ["корж:", 8],
      ["мусс с горьким шоколадом:", 6],
      ["мусс с молочным шоколадом:", 6],
      ["мусс с белым шоколадом:", 6],
    ],
    firstLine: "3 яйца (небольших)",
    lastLine: "10 г желатина",
    steps: 58,
    servings: [6, 10],
    categories: [[46, "Торты и пирожные"]],
    durations: 4,
    longWait: true,
    addedAt: "2023-12-05",
    comments: 78,
  },
  {
    // The title has a non-breaking hyphen (&#8209;). A step says "двух минут".
    id: 1601,
    title: "Картофель по-деревенски",
    groups: [[null, 7]],
    firstLine: "1 кг картофеля",
    lastLine: "перец",
    steps: 9,
    servings: [8, 10],
    categories: mains([71, "Вторые блюда из овощей"]),
    durations: 2,
    longWait: false,
    addedAt: "2024-04-23",
    comments: 58,
  },
  {
    id: 1623,
    title: "Рыба в картофельной корочке",
    groups: [[null, 7]],
    firstLine: "500 г рыбы (филе)",
    lastLine: "растительное масло",
    steps: 10,
    servings: [4, 6],
    categories: fish([166, "Жареная рыба"]),
    durations: 2,
    longWait: false,
    addedAt: "2024-03-19",
    comments: 34,
  },
  {
    id: 1635,
    title: "Чашушули",
    groups: [[null, 13]],
    firstLine: "1 кг говядины",
    lastLine: "перец",
    steps: 23,
    servings: [8, 10],
    categories: mains([67, "Вторые блюда из говядины"]),
    durations: 5,
    longWait: false,
    addedAt: "2024-06-04",
    comments: 42,
  },
  {
    id: 1653,
    title: "Шкмерули",
    groups: [[null, 8]],
    firstLine: "курица (весом 1–1.5 кг)",
    lastLine: "растительное масло",
    steps: 19,
    servings: [4, 6],
    categories: mains([66, "Вторые блюда из курицы"]),
    durations: 3,
    longWait: false,
    addedAt: "2024-10-15",
    comments: 32,
  },
  {
    id: 1676,
    title: "Куриное филе с лисичками в сливочном соусе",
    groups: [[null, 9]],
    firstLine: "500 г куриного филе",
    lastLine: "перец",
    steps: 13,
    servings: [4, 5],
    categories: mains([74, "Вторые блюда с грибами"], [66, "Вторые блюда из курицы"]),
    durations: 2,
    longWait: false,
    addedAt: "2025-07-29",
    comments: 16,
  },
  {
    // The yield is "10 котлет", so the page has no sentence with "порци".
    id: 1679,
    title: "Котлеты из куриного филе с беконом",
    groups: [[null, 9]],
    firstLine: "600 г куриного филе",
    lastLine: "растительное масло",
    steps: 11,
    servings: null,
    categories: mains([72, "Рецепты котлет"]),
    durations: 2,
    longWait: false,
    addedAt: "2025-01-28",
    comments: 20,
  },
  {
    // No block "Категории рецепта". No sentence with "порци". The step "6–8 часов" sets longWait.
    id: 1688,
    title: "Фасолада",
    groups: [[null, 10]],
    firstLine: "450 г фасоли",
    lastLine: "растительное масло",
    steps: 16,
    servings: null,
    categories: [[47, "Первые блюда"]],
    durations: 2,
    longWait: true,
    addedAt: "2025-03-11",
    comments: 28,
  },
  {
    // The yield is "10–11 штук". A step has a time in seconds, which does not count.
    id: 1700,
    title: "Голубцы из пекинской капусты",
    groups: [[null, 10]],
    firstLine: "1.5 кг пекинской капусты",
    lastLine: "перец",
    steps: 24,
    servings: null,
    categories: mains([77, "Вторые блюда из фарша"]),
    durations: 1,
    longWait: false,
    addedAt: "2025-05-06",
    comments: 30,
  },
  {
    // No block "Категории рецепта": the category comes from the breadcrumb at the top.
    id: 1701,
    title: "Шакшука",
    groups: [[null, 9]],
    firstLine: "3–4 яйца",
    lastLine: "перец",
    steps: 18,
    servings: [2, 3],
    categories: [[41, "Закуски и бутерброды"]],
    durations: 1,
    longWait: false,
    addedAt: "2025-07-01",
    comments: 30,
  },
  {
    id: 1731,
    title: "Кальмары маринованные",
    groups: [
      [null, 1],
      ["маринад:", 6],
      ["по желанию:", 1],
    ],
    firstLine: "500 г кальмаров (чищенных)",
    lastLine: "кунжут",
    steps: 8,
    servings: [4, 6],
    categories: fish(),
    durations: 2,
    longWait: false,
    addedAt: "2025-12-30",
    comments: 8,
  },
  {
    // The yield is "5–7 штук"; the page has no time in the steps.
    id: 1761,
    title: "Сосиски с сыром в лаваше",
    groups: [[null, 8]],
    firstLine: "2–3 тонких лаваша",
    lastLine: "растительное масло",
    steps: 16,
    servings: null,
    categories: [[41, "Закуски и бутерброды"]],
    durations: 0,
    longWait: false,
    addedAt: "2026-04-28",
    comments: 6,
  },
]

/**
 * The text of the element `.p-yield`, as the page shows it. `null`: the page has no such element.
 * Read from the pages (`grep p-yield`), with `&nbsp;` as a space.
 */
const YIELD_TEXT: Readonly<Record<number, string | null>> = {
  18: "7–8 порций",
  38: "6–8 порций",
  61: "7–8 порций",
  109: "6–8 порций",
  118: null,
  245: "8–10 порций",
  246: null,
  275: null,
  401: "6–8 порций",
  913: "4–6 порций",
  935: "100–110 штук",
  1008: "4–6 порций",
  1057: "6–8 порций",
  1171: "4–6 порций",
  1201: "4–6 порций",
  1282: "6–8 порций",
  1321: "6–8 порций",
  1372: "6–8 порций",
  1376: "4–6 порций",
  1429: "6–8 порций",
  1434: "6–8 порций",
  1587: "3–4 порции",
  1590: "6–10 порций (диаметр торта 24 см, высота — 8 см)",
  1601: "8–10 порций",
  1623: "4–6 порций",
  1635: "8–10 порций",
  1653: "4–6 порций",
  1676: "4–5 порций",
  1679: "10 котлет",
  1688: null,
  1700: "10–11 штук",
  1701: "2–3 порции",
  1731: "4–6 порций",
  1761: "5–7 штук",
}

/** Pages without the block "Категории рецепта": the categories come from the breadcrumb. */
const BREADCRUMB_PAGES: ReadonlySet<number> = new Set([246, 275, 1372, 1590, 1688, 1701])

/** Pages where the word "порци" appears nowhere (no source for the servings): the warning `no_servings`. */
const NO_SERVINGS_PAGES: ReadonlySet<number> = new Set([246, 275, 935, 1679, 1688, 1700, 1761])

/** Page 118 has no yield. Its intro has a sentence with "порций" and no number. */
const SERVINGS_TEXT_START_118 = "Я затрудняюсь сказать точно"

const FIXTURE_DIR = new URL("./fixtures/real/", import.meta.url)

const recipeId = Schema.decodeUnknownSync(RecipeId)

const parseFixture = (id: number): ParseOutcome => {
  const html = readFileSync(new URL(`${id}.html`, FIXTURE_DIR), "utf-8")
  const result = parseRecipeWithWarnings(html, recipeId(id))
  return Result.isSuccess(result)
    ? result.success
    : assert.fail(`${id}: ${result.failure.reason}: ${result.failure.message}`)
}

describe("golden pages (test/fixtures/real)", () => {
  it("has a case for each of the 34 pages", () => {
    assert.strictEqual(GOLDEN.length, 34)
    assert.strictEqual(new Set(GOLDEN.map((golden) => golden.id)).size, 34)
    assert.deepStrictEqual(
      Object.keys(YIELD_TEXT)
        .map(Number)
        .sort((a, b) => a - b),
      GOLDEN.map((golden) => golden.id).sort((a, b) => a - b)
    )
  })

  for (const golden of GOLDEN) {
    it(`${golden.id} ${golden.title}`, (context) => {
      const file = new URL(`${golden.id}.html`, FIXTURE_DIR)
      context.skip(
        !existsSync(file),
        `The page test/fixtures/real/${golden.id}.html is absent (the pages are git-ignored). Run \`npm run fixtures:refresh\` to copy it from data/raw/.`
      )

      const { recipe, warnings } = parseFixture(golden.id)
      const lines = recipe.ingredientGroups.flatMap((group) => group.items)

      assert.strictEqual(recipe.id, golden.id)
      assert.strictEqual(recipe.url.startsWith(`https://www.say7.info/cook/recipe/${golden.id}-`), true)
      assert.strictEqual(recipe.title, golden.title)
      assert.deepStrictEqual(
        recipe.ingredientGroups.map((group) => [group.title, group.items.length]),
        golden.groups.map((group) => [...group])
      )
      assert.strictEqual(lines[0], golden.firstLine)
      assert.strictEqual(lines.at(-1), golden.lastLine)
      assert.strictEqual(recipe.steps.length, golden.steps)
      const yieldText = YIELD_TEXT[golden.id] ?? null
      assert.strictEqual(recipe.yieldText, yieldText)
      if (yieldText !== null && yieldText.includes("порци")) {
        assert.strictEqual(recipe.servingsText, yieldText)
      } else if (golden.id === 118) {
        assert.isTrue(recipe.servingsText?.startsWith(SERVINGS_TEXT_START_118) ?? false)
      } else {
        assert.isNull(recipe.servingsText)
      }
      assert.deepStrictEqual(
        recipe.servings === null ? null : [recipe.servings.min, recipe.servings.max],
        golden.servings === null ? null : [...golden.servings]
      )
      assert.strictEqual(warnings.includes("categories_from_breadcrumb"), BREADCRUMB_PAGES.has(golden.id))
      assert.strictEqual(warnings.includes("no_servings"), NO_SERVINGS_PAGES.has(golden.id))
      assert.strictEqual(warnings.includes("servings_unparsed"), golden.id === 118)
      assert.deepStrictEqual(
        recipe.categories.map((category) => [category.id, category.name]),
        golden.categories.map((category) => [...category])
      )
      assert.strictEqual(recipe.durations.length, golden.durations)
      assert.strictEqual(recipe.longWait, golden.longWait)
      assert.strictEqual(recipe.addedAt, golden.addedAt)
      assert.strictEqual(recipe.commentsCount, golden.comments)
      assert.strictEqual(recipe.similarIds.length, 6)

      // The same facts hold for every page.
      assert.isTrue(recipe.intro.length > 0)
      assert.isFalse(recipe.steps.some((step) => /https?:/.test(step)))
      assert.isTrue(
        [recipe.title, ...lines, ...recipe.steps].every((text) => !/[\u00A0\u2011]/.test(text) && text === text.trim())
      )
    })
  }
})

describe("fixture list", () => {
  it("test/fixtures/real-ids.json lists the same pages as the golden cases", () => {
    const listed = JSON.parse(readFileSync(new URL("./fixtures/real-ids.json", import.meta.url), "utf-8"))
    assert.deepStrictEqual(
      listed,
      GOLDEN.map((golden) => golden.id)
    )
  })
})
