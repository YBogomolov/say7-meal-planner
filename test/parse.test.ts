import { assert, describe, it } from "@effect/vitest"
import { Result, Schema } from "effect"
import { createHash } from "node:crypto"
import { ParsedRecipe, PARSER_VERSION } from "../src/domain/parsed-recipe.ts"
import type { ParseError } from "../src/domain/parsed-recipe.ts"
import { RecipeId } from "../src/domain/recipe.ts"
import { parseRecipe } from "../src/parser/parse.ts"
import {
  categoryLink,
  categoryPath,
  DEFAULT_CANONICAL,
  lastPhotoStep,
  li,
  link,
  recipePage,
  step
} from "./support/recipe-page.ts"
import type { PageOptions } from "./support/recipe-page.ts"

const ID = Schema.decodeUnknownSync(RecipeId)(77)

const parse = (options: PageOptions = {}, id: RecipeId = ID) => parseRecipe(recipePage(options), id)

const parsed = (options: PageOptions = {}): ParsedRecipe => {
  const result = parse(options)
  return Result.isSuccess(result) ? result.success : assert.fail(`expected success, got ${result.failure.reason}: ${result.failure.message}`)
}

const failure = (options: PageOptions = {}, id: RecipeId = ID): ParseError => {
  const result = parse(options, id)
  return Result.isFailure(result) ? result.failure : assert.fail("expected a ParseError")
}

describe("parseRecipe: a complete page", () => {
  const recipe = parsed()

  it("reads every field", () => {
    assert.strictEqual(recipe.parserVersion, PARSER_VERSION)
    assert.strictEqual<number>(recipe.id, 77)
    assert.strictEqual(recipe.url, DEFAULT_CANONICAL)
    assert.strictEqual(recipe.title, "Тестовый салат")
    assert.deepStrictEqual(recipe.intro, [
      "Простой тестовый салат.",
      "Из указанного количества ингредиентов получается 4–6 порций."
    ])
    assert.deepStrictEqual(recipe.categories, [
      { id: 38, slug: "Salatyi", name: "Салаты" },
      { id: 54, slug: "Ovoschi", name: "Овощные салаты" }
    ])
    assert.deepStrictEqual(recipe.ingredientGroups, [{ title: null, items: ["200 г огурцов", "соль"] }])
    assert.deepStrictEqual(recipe.steps, ["Огурцы нарезать.", "Посолить.\nПеремешать."])
    assert.strictEqual(recipe.yieldText, "4–6 порций")
    assert.strictEqual(recipe.servingsText, "4–6 порций")
    assert.deepStrictEqual(recipe.servings, { min: 4, max: 6 })
    assert.deepStrictEqual(recipe.durations, [])
    assert.isFalse(recipe.longWait)
    assert.strictEqual(recipe.addedAt, "2023-12-05")
    assert.strictEqual(recipe.commentsCount, 12)
    assert.deepStrictEqual<ReadonlyArray<number>>(recipe.similarIds, [5, 9])
  })

  it("sets sourceSha256 to the SHA-256 of the UTF-8 text", () => {
    const html = recipePage()
    const expected = createHash("sha256").update(Buffer.from(html, "utf-8")).digest("hex")
    assert.strictEqual(recipe.sourceSha256, expected)
  })

  it("gives a value that the schema accepts", () => {
    assert.deepStrictEqual(Schema.decodeUnknownSync(ParsedRecipe)(JSON.parse(JSON.stringify(recipe))), recipe)
  })

  it("is the same for the same input", () => {
    assert.deepStrictEqual(parsed(), recipe)
  })
})

describe("parseRecipe: title", () => {
  it("decodes entities, turns &nbsp; into a space and &#8209; into a hyphen", () => {
    const recipe = parsed({ title: "Картофель по&#8209;деревенски&nbsp;с&nbsp;&laquo;сыром&raquo; &amp; луком" })
    assert.strictEqual(recipe.title, "Картофель по-деревенски с «сыром» & луком")
  })

  it("joins the text of inner elements and collapses white space", () => {
    const recipe = parsed({ title: "Креветки <span class=\"cohd\">в&nbsp;<span class=\"cohd\">кисло-сладком</span>\n  соусе</span>" })
    assert.strictEqual(recipe.title, "Креветки в кисло-сладком соусе")
  })

  it("fails without an <h1>, or with an empty one", () => {
    assert.strictEqual(failure({ title: null }).reason, "no_title")
    assert.strictEqual(failure({ title: " &nbsp; " }).reason, "no_title")
  })
})

describe("parseRecipe: URL and ID", () => {
  it("reads the canonical link", () => {
    assert.strictEqual(parsed().url, DEFAULT_CANONICAL)
  })

  it("reads og:url when the canonical link is missing", () => {
    const recipe = parsed({ canonical: null, ogUrl: "https://www.say7.info/cook/recipe/77-Other-Slug.html" })
    assert.strictEqual(recipe.url, "https://www.say7.info/cook/recipe/77-Other-Slug.html")
  })

  it("fails without a URL", () => {
    assert.strictEqual(failure({ canonical: null }).reason, "no_url")
  })

  it("fails when the ID of the URL is another ID", () => {
    const error = failure({}, Schema.decodeUnknownSync(RecipeId)(78))
    assert.strictEqual(error.reason, "id_mismatch")
    assert.strictEqual<number>(error.id, 78)
    assert.include(error.message, DEFAULT_CANONICAL)
  })

  it("fails when the URL is not a recipe URL", () => {
    assert.strictEqual(failure({ canonical: "https://www.say7.info/cook/" }).reason, "id_mismatch")
  })

  it("does not take the ID from a longer number in the path", () => {
    assert.strictEqual(failure({ canonical: "https://www.say7.info/cook/recipe/177-Test.html" }).reason, "id_mismatch")
  })
})

describe("parseRecipe: intro", () => {
  it("takes the paragraphs of the description, in order", () => {
    const recipe = parsed({ summary: "<p>Первая&nbsp;фраза.</p>\n<p> </p>\n<p>Вторая<br />строка.</p><br />" })
    assert.deepStrictEqual(recipe.intro, ["Первая фраза.", "Вторая строка."])
  })

  it("leaves out a quotation", () => {
    const recipe = parsed({
      summary: `<p>Свой текст.</p><div class="explain donotprint"><p>Вот что написано:</p><p><blockquote cite="https://example.org"></p>` +
        `<p>Чужой текст.</p></blockquote></div><p>Из указанного количества ингредиентов получается 2 порции.</p>`
    })
    assert.deepStrictEqual(recipe.intro, ["Свой текст.", "Из указанного количества ингредиентов получается 2 порции."])
  })

  it("is empty when the page has no description", () => {
    assert.deepStrictEqual(parsed({ summary: null }).intro, [])
  })
})

describe("parseRecipe: ingredients", () => {
  it("makes one group without a title when the page has one list", () => {
    const recipe = parsed({ ingredients: `<ul>${li("1 яйцо")}${li("2&nbsp;ст.л. масла")}</ul>` })
    assert.deepStrictEqual(recipe.ingredientGroups, [{ title: null, items: ["1 яйцо", "2 ст.л. масла"] }])
  })

  it("starts a group at each <h3>, and keeps an untitled group before the first <h3>", () => {
    const recipe = parsed({
      ingredients: `<ul>${li("мука")}</ul>\n<h3>маринад:</h3><ul>${li("уксус")}${li("сахар")}</ul>\n<h3>по&nbsp;желанию:</h3><ul>${li("кунжут")}</ul>`
    })
    assert.deepStrictEqual(recipe.ingredientGroups, [
      { title: null, items: ["мука"] },
      { title: "маринад:", items: ["уксус", "сахар"] },
      { title: "по желанию:", items: ["кунжут"] }
    ])
  })

  it("makes no untitled group when the first list has a heading", () => {
    const recipe = parsed({ ingredients: `<h3>тесто:</h3><ul>${li("мука")}</ul><h3>начинка:</h3><ul>${li("мясо")}</ul>` })
    assert.deepStrictEqual(recipe.ingredientGroups.map((group) => group.title), ["тесто:", "начинка:"])
  })

  it("drops a heading without lines", () => {
    const recipe = parsed({ ingredients: `<ul>${li("мука")}</ul><h3>пусто:</h3><ul></ul><h3>соус:</h3><ul>${li("соль")}</ul>` })
    assert.deepStrictEqual(recipe.ingredientGroups.map((group) => group.title), [null, "соус:"])
  })

  it("reads the text of a link in a line, and keeps fractions as written", () => {
    const recipe = parsed({
      ingredients: `<ul>${li("100&nbsp;г <a href=\"https://www.say7.info/cook/recipe/1644-Sous.html\">томатного соуса</a> (кетчупа)")}${li("&frac12;&nbsp;ч.л. соли")}</ul>`
    })
    assert.deepStrictEqual(recipe.ingredientGroups[0]?.items, ["100 г томатного соуса (кетчупа)", "½ ч.л. соли"])
  })

  it("does not read the lists of the menu or of other blocks", () => {
    const items = parsed().ingredientGroups.flatMap((group) => group.items)
    assert.deepStrictEqual(items, ["200 г огурцов", "соль"])
  })

  it("fails without an ingredient line", () => {
    assert.strictEqual(failure({ ingredients: null }).reason, "no_ingredients")
    assert.strictEqual(failure({ ingredients: "<ul></ul>" }).reason, "no_ingredients")
    assert.strictEqual(failure({ ingredients: `<ul>${li(" &nbsp; ")}</ul>` }).reason, "no_ingredients")
  })
})

describe("parseRecipe: steps", () => {
  it("keeps the order, turns <br> into a line break and drops images", () => {
    const recipe = parsed({ steps: [step(1, "Первый.<br />\nВторой."), step(2, "Третий&nbsp;шаг.")].join("\n") })
    assert.deepStrictEqual(recipe.steps, ["Первый.\nВторой.", "Третий шаг."])
    assert.isFalse(recipe.steps.some((text) => text.includes("http")))
  })

  it("drops the last step that has only a photo", () => {
    assert.strictEqual(parsed({ steps: [step(1, "Один."), lastPhotoStep(2)].join("\n") }).steps.length, 1)
  })

  it("keeps a step without an image", () => {
    const recipe = parsed({ steps: [step(1, "Без картинки.", false), step(2, "С картинкой.")].join("\n") })
    assert.deepStrictEqual(recipe.steps, ["Без картинки.", "С картинкой."])
  })

  it("reads the steps of every part, and not the part headings", () => {
    const recipe = parsed({
      steps: `<div class="howtosection"><h3>Готовим тесто</h3>${step(1, "Замесить.")}</div><div class="cl"><br /></div>` +
        `<div class="howtosection"><h3>Готовим начинку</h3>${step(2, "Нарезать.")}${step(3, "Обжарить.")}</div>`
    })
    assert.deepStrictEqual(recipe.steps, ["Замесить.", "Нарезать.", "Обжарить."])
  })

  it("does not read the closing words after the steps", () => {
    assert.isFalse(parsed().steps.some((text) => text.includes("аппетит")))
  })

  it("fails without a step", () => {
    assert.strictEqual(failure({ steps: null }).reason, "no_steps")
    assert.strictEqual(failure({ steps: lastPhotoStep(1) }).reason, "no_steps")
    assert.strictEqual(failure({ steps: "" }).reason, "no_steps")
  })
})

describe("parseRecipe: categories", () => {
  it("lists each category once, in page order, from all paths of the block", () => {
    const recipe = parsed({
      categories: categoryPath(
        categoryLink(38, "Salatyi", "Салаты", "subtitle"),
        categoryLink(55, "S-mayonezom", "Салаты с&nbsp;майонезом", "subcat")
      ) + categoryPath(
        categoryLink(38, "Salatyi", "Салаты", "subtitle"),
        categoryLink(127, "YAyca", "Салаты с яйцами", "subcat")
      )
    })
    assert.deepStrictEqual(recipe.categories, [
      { id: 38, slug: "Salatyi", name: "Салаты" },
      { id: 55, slug: "S-mayonezom", name: "Салаты с майонезом" },
      { id: 127, slug: "YAyca", name: "Салаты с яйцами" }
    ])
  })

  it("never takes the categories of the site menu", () => {
    const ids = parsed().categories.map((category) => category.id)
    assert.deepStrictEqual(ids, [38, 54])
  })

  it("reads the breadcrumb at the top when the page has no block 'Категории рецепта'", () => {
    assert.deepStrictEqual(parsed({ categories: null }).categories, [{ id: 38, slug: "Salatyi", name: "Салаты" }])
  })

  it("is empty when the page has neither block nor breadcrumb", () => {
    assert.deepStrictEqual(parsed({ categories: null, breadcrumb: "" }).categories, [])
  })
})

describe("parseRecipe: servings, durations and long waits", () => {
  it("reads the servings from the yield text, and keeps its full text", () => {
    const recipe = parsed({ summary: "<p>Из указанного количества ингредиентов получается <span class=\"p-yield\">6–10 порций (диаметр 24&nbsp;см)</span>.</p>" })
    assert.strictEqual(recipe.yieldText, "6–10 порций (диаметр 24 см)")
    assert.strictEqual(recipe.servingsText, "6–10 порций (диаметр 24 см)")
    assert.deepStrictEqual(recipe.servings, { min: 6, max: 10 })
  })

  it("prefers the yield text to a sentence of the intro or of the steps", () => {
    const recipe = parsed({
      summary: "<p>Хватит на 2 порции. <span class=\"p-yield\">8–10 порций</span></p>",
      steps: step(1, "Разложить на 3 порции.")
    })
    assert.strictEqual(recipe.servingsText, "8–10 порций")
    assert.deepStrictEqual(recipe.servings, { min: 8, max: 10 })
  })

  it("reads the servings from the intro when the yield is in pieces, and keeps the yield text", () => {
    const recipe = parsed({ summary: "<p>Хватит на 6–8 порций. Получается <span class=\"p-yield\">100–110 штук</span>.</p>" })
    assert.strictEqual(recipe.yieldText, "100–110 штук")
    assert.strictEqual(recipe.servingsText, "Хватит на 6–8 порций.")
    assert.deepStrictEqual(recipe.servings, { min: 6, max: 8 })
  })

  it("reads the servings from the intro when the page has no yield element", () => {
    const recipe = parsed({ summary: "<p>Из этого получается 5 порций. Вкусно.</p>" })
    assert.strictEqual(recipe.yieldText, null)
    assert.strictEqual(recipe.servingsText, "Из этого получается 5 порций.")
    assert.deepStrictEqual(recipe.servings, { min: 5, max: 5 })
  })

  it("reads the servings from a step when the yield and the intro have none", () => {
    const recipe = parsed({ summary: "<p>Салат.</p>", steps: step(1, "Разложить на 3 порции.") })
    assert.strictEqual(recipe.yieldText, null)
    assert.strictEqual(recipe.servingsText, "Разложить на 3 порции.")
    assert.deepStrictEqual(recipe.servings, { min: 3, max: 3 })
  })

  it("keeps the sentence when it has no number", () => {
    const recipe = parsed({ summary: "<p>Я не знаю, сколько получается порций.</p>" })
    assert.strictEqual(recipe.servingsText, "Я не знаю, сколько получается порций.")
    assert.strictEqual(recipe.servings, null)
  })

  it("has no servings when the yield is in pieces and no other text names portions", () => {
    const recipe = parsed({ summary: "<p>Из указанного количества ингредиентов получается <span class=\"p-yield\">10 котлет</span>.</p>" })
    assert.strictEqual(recipe.yieldText, "10 котлет")
    assert.strictEqual(recipe.servingsText, null)
    assert.strictEqual(recipe.servings, null)
  })

  it("has no yield text when the element is empty or absent", () => {
    assert.strictEqual(parsed({ summary: "<p>Салат <span class=\"p-yield\"> </span>.</p>" }).yieldText, null)
    assert.strictEqual(parsed({ summary: "<p>Салат.</p>" }).yieldText, null)
  })

  it("reads the durations of the steps, and not those of the intro or of the comments", () => {
    const recipe = parsed({
      summary: "<p>Готовится 15 минут.</p>",
      steps: [step(1, "Варить в&nbsp;течение 10&nbsp;минут."), step(2, "Остудить 1&nbsp;час 20&nbsp;минут.")].join("\n")
    })
    assert.deepStrictEqual(recipe.durations, [
      { minMinutes: 10, maxMinutes: 10, text: "10 минут" },
      { minMinutes: 80, maxMinutes: 80, text: "1 час 20 минут" }
    ])
    assert.isFalse(recipe.longWait)
  })

  it("sets longWait for 6 hours, for a night and for a day", () => {
    assert.isTrue(parsed({ steps: step(1, "Оставить на 8&nbsp;часов.") }).longWait)
    assert.isTrue(parsed({ steps: step(1, "Убрать в холодильник на ночь.") }).longWait)
    assert.isTrue(parsed({ steps: step(1, "Настаивать сутки.") }).longWait)
    assert.isFalse(parsed({ steps: step(1, "Настаивать 5 часов.") }).longWait)
  })
})

describe("parseRecipe: date, comments and similar recipes", () => {
  it("reads the date after 'Рецепт добавлен:'", () => {
    assert.strictEqual(parsed().addedAt, "2023-12-05")
  })

  it("has no date when the block is missing, or when it names only the update", () => {
    assert.strictEqual(parsed({ dates: null }).addedAt, null)
    assert.strictEqual(parsed({ dates: "<div class=\"recipe-meta__item\">Обновлен: <time>20.10.2025</time></div>" }).addedAt, null)
  })

  it("does not take the date from a comment", () => {
    assert.strictEqual(parsed({ dates: null }).addedAt, null)
  })

  it("reads the number in 'Комментарии (N)', also 0", () => {
    assert.strictEqual(parsed({ commentsCount: 331 }).commentsCount, 331)
    assert.strictEqual(parsed({ commentsCount: 0 }).commentsCount, 0)
  })

  it("has no comments count when the heading is missing", () => {
    assert.strictEqual(parsed({ commentsCount: null }).commentsCount, null)
  })

  it("reads the IDs of the block 'Похожие' only, without duplicates", () => {
    const recipe = parsed({ similar: [link(5, "A", "А"), link(9, "B", "Б"), link(5, "A", "А")].join("") })
    assert.deepStrictEqual<ReadonlyArray<number>>(recipe.similarIds, [5, 9])
  })

  it("is empty when the block is missing", () => {
    assert.deepStrictEqual(parsed({ similar: null }).similarIds, [])
  })
})

describe("parseRecipe: a page that is not a recipe", () => {
  it.each(["", "<html></html>", "not html at all", "<!DOCTYPE html><h1>Ошибка 404</h1>"])("fails with a ParseError for %j", (html) => {
    const result = parseRecipe(html, ID)
    assert.isTrue(Result.isFailure(result))
    if (Result.isFailure(result)) {
      assert.strictEqual(result.failure._tag, "ParseError")
      assert.strictEqual<number>(result.failure.id, 77)
    }
  })
})
