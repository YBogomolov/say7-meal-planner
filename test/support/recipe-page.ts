/**
 * A small recipe page in the structure of the real pages of say7.info.
 * The text is invented for the tests. Only the structure follows the real pages in `test/fixtures/real/`.
 * Each part can be changed or removed to test a variant of the markup.
 */

export interface PageOptions {
  readonly title?: string | null
  /** `null` removes the canonical link. */
  readonly canonical?: string | null
  readonly ogUrl?: string | null
  /** Inner HTML of `.p-summary`. `null` removes the block. */
  readonly summary?: string | null
  /** Inner HTML of the block `.ingredients`. `null` removes the section. */
  readonly ingredients?: string | null
  /** Inner HTML of the steps section after its heading. `null` removes the section. */
  readonly steps?: string | null
  /** Inner HTML of the header breadcrumb `#sitepos`. */
  readonly breadcrumb?: string
  /** Inner HTML of the section "Категории рецепта" after its header. `null` removes the section. */
  readonly categories?: string | null
  /** Inner HTML of the `<div class="recipe-meta">`. `null` removes the block. */
  readonly dates?: string | null
  /** `null` removes the comments heading. */
  readonly commentsCount?: number | null
  /** Inner HTML of the list of "Похожие". `null` removes the block. */
  readonly similar?: string | null
}

export const DEFAULT_CANONICAL = "https://www.say7.info/cook/recipe/77-Test-Salat.html"

export const li = (text: string): string => `<li class="p-ingredient">${text}</li>`

export const step = (n: number, text: string, withImage = true): string =>
  `<div id="step${n}" class="step ${n % 2 === 1 ? "stepodd" : "stepeven"}">\n` +
  `<p class="stepdetailed">${withImage ? `<img width="300" height="225" alt="" src="https://ist.say7.info/img/${n}_p.jpg" />` : ""}${text}</p></div>`

export const lastPhotoStep = (n: number): string =>
  `<div id="step${n}" class="step stepeven steplast">\n` +
  `<p class="empty stepdetailed"><img width="300" height="225" alt="" src="https://ist.say7.info/img/${n}_p.jpg" /></p></div>`

export const link = (id: number, slug: string, title: string): string =>
  `<li><a href="https://www.say7.info/cook/recipe/${id}-${slug}.html" title="${title}"><img src="https://ist.say7.info/img/${id}_l.jpg" />\n${title}</a></li>`

export const categoryLink = (id: number, slug: string, name: string, kind: "subtitle" | "subcat"): string =>
  `<li><a href="https://www.say7.info/cook/kitchen/${id}-${slug}/" class="${kind}">${name}</a></li>`

export const categoryPath = (...links: ReadonlyArray<string>): string =>
  `<nav class="bc"><ul aria-label="Строка навигации">${links.join("")}</ul></nav>`

export const DEFAULT_SUMMARY =
  `<p>Простой тестовый салат.</p>\n<p>Из указанного количества ингредиентов получается <span class="p-yield">4&ndash;6&nbsp;порций</span>.</p><br />`

export const DEFAULT_INGREDIENTS = `<ul>\n${li("200&nbsp;г огурцов")}\n${li("соль")}</ul>`

export const DEFAULT_STEPS = [step(1, "Огурцы нарезать."), step(2, "Посолить.<br />\nПеремешать."), lastPhotoStep(3)].join("\n")

export const DEFAULT_BREADCRUMB =
  `<ul aria-label="Строка навигации"><li><a class="subtitle" href="/cook/">Рецепты</a></li>` +
  `<li><span aria-hidden="true" class="gt">&#9658;</span> <a href="https://www.say7.info/cook/kitchen/38-Salatyi/" class="subcat">Салаты</a></li></ul>`

export const DEFAULT_CATEGORIES = categoryPath(
  categoryLink(38, "Salatyi", "Салаты", "subtitle"),
  categoryLink(54, "Ovoschi", "Овощные салаты", "subcat")
)

export const DEFAULT_DATES =
  `<div class="recipe-meta__item">Рецепт добавлен: <time datetime="2023-12-05">05.12.2023</time></div>` +
  `<div class="recipe-meta__item">Обновлен: <time datetime="2025-10-20">20.10.2025</time></div>`

export const DEFAULT_SIMILAR = [link(5, "Salat-Pyat", "Салат пять"), link(9, "Salat-Devyat", "Салат девять")].join("\n")

const orDefault = <A>(value: A | undefined, fallback: A): A => (value === undefined ? fallback : value)

/** The whole page as text. */
export const recipePage = (options: PageOptions = {}): string => {
  const title = orDefault(options.title, "Тестовый салат")
  const canonical = orDefault(options.canonical, DEFAULT_CANONICAL)
  const ogUrl = orDefault(options.ogUrl, null)
  const summary = orDefault(options.summary, DEFAULT_SUMMARY)
  const ingredients = orDefault(options.ingredients, DEFAULT_INGREDIENTS)
  const steps = orDefault(options.steps, DEFAULT_STEPS)
  const categories = orDefault(options.categories, DEFAULT_CATEGORIES)
  const dates = orDefault(options.dates, DEFAULT_DATES)
  const commentsCount = orDefault(options.commentsCount, 12)
  const similar = orDefault(options.similar, DEFAULT_SIMILAR)

  return `<!DOCTYPE html>
<html lang="ru"><head><meta http-equiv="content-type" content="text/html; charset=windows-1251" />
<title>${title ?? "Страница"}</title>
${canonical === null ? "" : `<link rel="canonical" href="${canonical}" />`}
${ogUrl === null ? "" : `<meta property="og:url" content="${ogUrl}" />`}
</head>
<body class=""><nav id="mn1"><a href="/" class="gohome">SAY7.INFO</a></nav>
<nav id="header"><div id="sitepos" class="bc">${orDefault(options.breadcrumb, DEFAULT_BREADCRUMB)}</div></nav>
<header><div class="pc shia">${title === null ? "" : `<h1>${title}</h1>`}</div></header>
<div id="page" class="pc"><div id="content">
<main class="article h-recipe">
<aside id="adb1txt" class="donotprint"><ins class="adsbygoogle"><div id="yad1txt"></div></ins></aside>
${summary === null ? "" : `<div class="p-summary">${summary}</div>`}
<div class="cl"></div>
${
    ingredients === null ? "" : `<section id="ingredientsbox" aria-labelledby="ingredients-title">
<h2 id="ingredients-title">Ингредиенты</h2>
<div class="forstep stepdetailed"><img id="ingrphoto" width="300" height="225" src="https://ist.say7.info/img/i.jpg" alt="" /></div>
<div class="c8 ingredients">${ingredients}</div>
</section>`
  }
${
    steps === null ? "" : `<section id="stp" class="stepbystep instructions e-instructions" aria-labelledby="instructionsh2">
<h2 id="instructionsh2">Приготовление</h2>
<div>${steps}
</div>\t<p class="bonappetit">Приятного аппетита!</p>
</section>`
  }
<div id="sign"><div class="col"><div>Автор: <a href="https://www.say7.info/Anastasia" class="p-author">Анастасия Скрипкина</a></div>
${dates === null ? "" : `<div class="recipe-meta recipe-dates" aria-label="Даты рецепта">${dates}</div>`}
</div></div>
${
    categories === null ? "" : `<section aria-labelledby="categories-title" id="categoriesbox" class="donotprint">
<header id="categories-title">Категории рецепта</header>
${categories}</section>`
  }
</main>
${
    commentsCount === null ? "" : `<section aria-labelledby="comments" id="comm" class="cl-short donotprint">
<h2 id="comments">Комментарии (<span id="commcount" class="count">${commentsCount}</span>)</h2>
<div id="comload"><div id="com437044" class="comment"><b class="reviewer">Гость</b> <time datetime="2026-10-04T14:21:06Z">04.10.2026</time>
Рецепт добавлен: 01.01.2000. Хватит на 99 порций, варить 7 часов.</div></div>
</section>`
  }
${
    similar === null ? "" : `<aside class="simo podium donotprint"><nav aria-label="Похожие рецепты" class="sidebox">
<header><p>Похожие</p></header>
<ul>${similar}</ul></nav></aside>`
  }
</div>
<div id="sidebar"><aside><nav aria-label="Категории рецептов"><ul class="menu6">
<li><a href="https://www.say7.info/cook/kitchen/41-Zakuski-buterbrodyi/"><span>Закуски и&nbsp;бутерброды</span></a></li>
<li><a href="https://www.say7.info/cook/kitchen/47-Pervyie-bljuda/"><span>Первые блюда</span></a></li>
</ul></nav></aside>
<aside class="simo podium"><nav aria-label="Новые рецепты" class="sidebox"><header><p>Новые</p></header>
<ul>${link(1754, "Novyi", "Новый рецепт")}</ul></nav></aside>
<aside class="simo podium donotprint"><nav aria-label="Популярные рецептов" class="sidebox"><header><p>Популярные</p></header>
<ul>${link(1586, "Populyarnyi", "Популярный рецепт")}</ul></nav></aside>
</div></div>
<footer><div class="posc">Тестовая страница.</div></footer>
</body></html>
`
}
