import { assert, describe, it } from "@effect/vitest"
import { parseFragment } from "parse5"
import { attr, byTag, findAll, findByOwnText, findFirst, hasAncestor, hasClass, siblingsAfter, textLines, textOf } from "../src/parser/dom.ts"

const fragment = (html: string) => parseFragment(html)

describe("textLines", () => {
  it("ends a line at <br> and at block elements, not at inline elements", () => {
    const lines = textLines(fragment("<p>Один <b>два</b> три<br />четыре</p><div>пять</div>шесть").childNodes)
    assert.deepStrictEqual([...lines], ["Один два три", "четыре", "пять", "шесть"])
  })

  it("skips pictures and scripts, and drops empty lines", () => {
    const lines = textLines(fragment("<p><img src=\"a.jpg\" /></p><script>var x = 1</script><p> a&nbsp;b </p><br /><br />").childNodes)
    assert.deepStrictEqual([...lines], ["a b"])
  })

  it("decodes entities", () => {
    assert.strictEqual(textOf(...fragment("<p>5&ndash;6&nbsp;порций &amp; &laquo;ещё&raquo;</p>").childNodes), "5–6 порций & «ещё»")
  })
})

describe("tree helpers", () => {
  const tree = fragment(
    "<div id=\"a\" class=\"one two\"><h2>Раздел:</h2><p>раз</p><p>два</p><h2>Другой</h2><p>три</p></div>"
  )

  it("finds elements by tag, class and attribute", () => {
    const div = findFirst(tree, byTag("div"))
    assert.isDefined(div)
    assert.isTrue(div !== undefined && hasClass(div, "two"))
    assert.isFalse(div !== undefined && hasClass(div, "tw"))
    assert.strictEqual(div === undefined ? undefined : attr(div, "id"), "a")
    assert.strictEqual(findAll(tree, byTag("p")).length, 3)
  })

  it("takes the siblings after a heading up to the next heading", () => {
    const heading = findByOwnText(tree, "Раздел")
    assert.isDefined(heading)
    if (heading !== undefined) {
      const nodes = siblingsAfter(heading, byTag("h2"))
      assert.strictEqual(textOf(...nodes), "раз два")
    }
  })

  it("finds a heading by its own text and by tag names", () => {
    assert.isDefined(findByOwnText(tree, "Другой", new Set(["h2"])))
    assert.isUndefined(findByOwnText(tree, "Другой", new Set(["p"])))
    assert.isUndefined(findByOwnText(tree, "Нет такого"))
  })

  it("finds an ancestor", () => {
    const paragraph = findFirst(tree, byTag("p"))
    assert.isTrue(paragraph !== undefined && hasAncestor(paragraph, (element) => element.tagName === "div"))
    assert.isFalse(paragraph !== undefined && hasAncestor(paragraph, (element) => element.tagName === "table"))
  })
})
