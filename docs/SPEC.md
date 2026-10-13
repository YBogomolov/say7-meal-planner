# say7 meal planner — specification

Status: P1–P6 done (2026-10-13). P3 full run: P3.5.6. P6 baseline: P6. Remaining work: docs/HANDOFF.md.

## 1. Goal

The system plans lunches and dinners for one week for three persons.
It uses recipes from https://www.say7.info (author: Anastasia Skripkina).
The plan uses the smallest number of distinct ingredients to buy and keeps the menu varied.

## 2. Household constraints

| ID | Constraint |
|----|------------|
| H1 | 3 persons. 7 days. 2 meals per day (lunch and dinner). All meals are at home. Breakfast is out of scope. |
| H2 | 2 cooking sessions per week. Session A is at the weekend. Session B is midweek. |
| H3 | 1 shopping trip per week, before session A. |
| H4 | The household eats 1 dish for 3 days or less. |
| H5 | 1 person does not eat very spicy food. Exclude dishes with high heat. |
| H6 | Prefer dishes with short active time. Exclude long-cooked dishes and complex pies or cakes. |
| H7 | Equipment: side-by-side fridge with large freezer, hob, oven, microwave, air fryer, food processor (dice, mix, blend, grate, knead), immersion blender. |
| H8 | Food safety: keep cooked food in the fridge for 4 days or less. Keep raw poultry and minced meat for 1–2 days. If session B uses raw poultry or mince, freeze it on the purchase day. |
| H9 | Use 1 protein family per week. Use 2 protein families or less. A protein family is, for example, chicken (fillet, thighs, hearts, whole bird) or pork. |

Demand per week: 3 persons × 7 days × 2 meals = 42 portions.

## 3. Data source rules

| ID | Rule |
|----|------|
| D1 | Fetch only URLs that match `https://www.say7.info/cook/recipe/<id>-<slug>.html`. robots.txt allows these URLs. |
| D2 | Do not fetch search pages (`/search.html`, `/gosearch.php`, `/gogoogle.html`). Do not fetch URLs with a query string. Do not fetch images. |
| D3 | Get the recipe list from `https://www.say7.info/sitemap.xml`. This file is one `<urlset>`. Each `<url>` has `<loc>` and, for most recipes, `<lastmod>` (YYYY-MM-DD). |
| D4 | Fetch sequentially (concurrency 1). Wait 2500 ms ± 500 ms between requests. |
| D5 | Recipe pages use the windows-1251 charset. The sitemap uses UTF-8. |
| D6 | The site forbids re-publication of its texts and photos. Keep all fetched content in `data/` on the local disk. `data/` is git-ignored. Menus show recipe titles, links and own short notes only. |
| D7 | The sandbox networks cannot reach say7.info. The scraper runs on the user's Mac (macOS, native Node). Development and tests use local fixtures. |

## 4. Architecture

```
sitemap.xml ──► P1 scrape ──► data/raw/<id>.html + data/raw/index.json
                                   │
                                   ▼
                              P2 parse ──► data/parsed/<id>.json   (ParsedRecipe)
                                   │
                                   ▼
                              P3 enrich ──► data/enriched/<id>.json (EnrichedRecipe, LLM, cached by content hash)
                                   │
                                   ▼
                              P4 catalogue (in memory) + plan rules + shopping list
                                   │         ▲
                                   ▼         │ config/household.json, config/item-aliases.json
                              P5 MCP server (stdio) ──► Claude Desktop / Claude Code
                                   │
                                   ▼
                              data/plans/<weekStart>.json (saved plans, history)
```

Principle: the LLM selects dishes. Deterministic code counts ingredients, sums quantities and checks constraints. The LLM does not calculate the shopping list.

## 5. Technical constraints

| ID | Constraint |
|----|------------|
| T1 | Node.js ≥ 22.13. Package manager: npm. Commit `package-lock.json`. No database: the catalogue (about 1100 recipes) is loaded into memory. |
| T2 | TypeScript, strict mode, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. ESM only. |
| T3 | Effect (latest stable major, currently 4.x). Use Effect Schema to decode all external data (HTTP responses, files, CLI arguments). |
| T4 | No native addons that compile at install time. Packages with prebuilt per-platform binaries (esbuild, rollup, TypeScript native) are permitted. Development happens on Linux. The user runs the code on macOS after `npm install`. |
| T5 | Tests: Vitest with `@effect/vitest`. Tests do not use the network, except a local HTTP server on 127.0.0.1. |
| T6 | Scripts: `npm run typecheck`, `npm test`, `npm run scrape`. |

## 6. Domain model

P1 types:

- `RecipeId` — positive integer, branded.
- `SitemapEntry` — `{ id: RecipeId, url: string, slug: string, lastmod: Option<string /* YYYY-MM-DD */> }`.
- `RawIndexEntry` — `{ id, url, lastmod: string | null, fetchedAt: string /* ISO */, status: "ok" | "not_found" | "error", httpStatus: number | null, bytes: number | null, sha256: string | null, error: string | null }`.
- `RawIndex` — `{ version: 1, entries: Record<string /* id */, RawIndexEntry> }`.

Later phases (draft, agents of P1 do not implement):

- `ParsedRecipe` — id, url, title, intro text, categories, ingredient groups (raw lines), steps (text), servings text, durations found in steps, date added.
- `EnrichedRecipe` — canonical ingredients with quantity, unit and role (protein, vegetable, side, pantry), protein family, servings range, active and total time estimates, dish type, heat level, fridge life, freezable, equipment.

## 7. Phases and acceptance criteria

### P1 — scaffold and scraper

1. The command `npm run scrape` downloads all recipe pages from the sitemap into `data/raw/`.
2. Flags:
   - `--limit <n>`: process the first n sitemap entries that need a fetch.
   - `--ids <id,id,...>`: process only these recipe IDs.
   - `--force`: fetch again, also if the cache is current.
   - `--delay-ms <n>`: base delay between requests (default 2500).
   - `--base-url <url>`: origin of the site (default `https://www.say7.info`). Tests use it.
   - `--data-dir <path>`: default `data`.
3. Before the first page, the scraper reads `/robots.txt`. If robots.txt disallows `/cook/recipe/<id>-<slug>.html` for `User-agent: *`, the scraper stops with an error. A simple rule matcher is sufficient: `Allow` and `Disallow` prefixes, `*` wildcard, `$` end anchor, longest match wins.
4. Incremental update: the scraper skips an entry if `index.json` has `status: "ok"` with the same `lastmod` and the HTML file exists. If the sitemap has no `lastmod` for an entry, the scraper skips the entry if the cache has it with `status: "ok"`.
5. HTTP: timeout 30 s. Retry 3 times with exponential backoff (2 s, 4 s, 8 s) on network errors, 429 and 5xx. Do not retry 404; record `status: "not_found"`. Honour `Retry-After` on 429 and 503.
6. Decode the body with the charset from `Content-Type`. If it is missing, use the `<meta charset>` or `http-equiv` value. Default: windows-1251. Store the HTML as UTF-8 in `data/raw/<id>.html`. Store `sha256` of the original bytes.
7. Write files atomically (write to a temporary file in the same directory, then rename). Update `index.json` after each page.
8. The scraper can stop at any time (Ctrl+C) and continue on the next run without data loss.
9. User-Agent: `say7-meal-planner/0.1 (personal non-commercial use)`.
10. Log 1 line per page: `[k/n] <id> <status> <size KB> <ms>`. At the end, log totals: fetched, skipped, not found, errors.
11. Tests cover: sitemap parsing, URL filter, robots matcher, fetch decision (pure function), charset decoding, retry behaviour, and an end-to-end run against a local HTTP server that serves windows-1251 pages.
12. `README.md` explains setup and the scrape commands for macOS.

### P2 — parser

Input: `data/raw/<id>.html` (UTF-8 text; the file still contains the original `<meta charset="windows-1251">`). Output: `data/parsed/<id>.json` and `data/parsed/_report.json`.

`ParsedRecipe` (Effect Schema, version field `parserVersion: 1`):

| Field | Type | Source and rule |
|-------|------|-----------------|
| `id` | RecipeId | file name; must equal the ID in the canonical URL |
| `url` | string | `<link rel="canonical">` or `og:url` |
| `title` | string | `<h1>`. Decode HTML entities. `&nbsp;` → space. `&#8209;` (non-breaking hyphen) → `-`. Collapse whitespace. |
| `intro` | string[] | paragraphs of the description before the ingredient list |
| `categories` | `{ id: number, slug: string, name: string }[]` | only the block "Категории рецепта" of this recipe; not the site menu |
| `ingredientGroups` | `{ title: string \| null, items: string[] }[]` | the block after the heading "Ингредиенты". Keep each line as written (cleaned text). A group title exists if the page splits ingredients into parts (for example "Для теста:"). |
| `steps` | string[] | step texts under "Приготовление", in order, without image URLs |
| `yieldText` | string \| null | text of the `.p-yield` element, cleaned ("8–10 порций", "100–110 штук") |
| `servingsText` | string \| null | sources in this order: (1) `yieldText` if it contains "порци"; (2) the first intro sentence that contains "порци"; (3) the first step sentence that contains "порци" |
| `servings` | `{ min: number, max: number } \| null` | numbers from `servingsText` ("6–8 порций" → 6..8; "4 порции" → 4..4). A yield in pieces ("штук") does not give `servings`. |
| `durations` | `{ minMinutes: number, maxMinutes: number, text: string }[]` | time mentions in steps: "30 минут", "1,5 часа", "40–50 минут", "2-3 часа", "1 час 20 минут". `text` is the matched fragment. |
| `longWait` | boolean | true if the steps mention a wait of 6 hours or more, overnight ("на ночь", "в течение ночи") or a day ("сутки") |
| `addedAt` | string \| null | "Рецепт добавлен: DD.MM.YYYY" → `YYYY-MM-DD` |
| `commentsCount` | number \| null | "Комментарии (N)" |
| `similarIds` | RecipeId[] | the block "Похожие" of this recipe only |
| `sourceSha256` | string | sha256 of the UTF-8 file bytes |

Rules:

1. The parser is a pure function `parseRecipe(html: string, id: RecipeId): Result<ParsedRecipe, ParseError>` plus a CLI `npm run parse` that processes all `ok` entries of `data/raw/index.json`.
2. A page fails with a tagged `ParseError` if it has no title, no ingredient line or no step. A page with missing optional data (servings, durations, date) passes; the report lists it as a warning.
3. `_report.json`: totals (ok, failed, with warnings), the list of failed IDs with the reason, warning counts per kind.
4. Real fixture pages are in `test/fixtures/real/` (git-ignored, copyrighted). Golden tests skip with a clear message if a file is absent. Golden assertions in committed test code contain only short facts: title, counts, 1–2 ingredient lines, servings, categories.
5. `npm run fixtures:refresh` copies the fixture IDs listed in `test/fixtures/real-ids.json` (committed) from `data/raw/` to `test/fixtures/real/`.
6. Acceptance on the full cache: ≥ 99 % of `ok` pages parse without `ParseError`. The coordinator runs this check on the user's machine.

### P3 — enrichment

Decision: the Anthropic Messages API with the user's key. The enrichment runs on the user's Mac.

Input: `data/parsed/<id>.json`. Output: `data/enriched/<id>.json` and `data/enriched/_report.json`.

#### P3.1 Scope

A recipe is in scope if its `categories` contain at least 1 of these IDs: 40 (Вторые блюда), 38 (Салаты), 41 (Закуски и бутерброды), 47 (Первые блюда), 44 (Рыба и морепродукты), 48 (Несладкая выпечка), 50 (Блины, оладьи, сырники). Other recipes (desserts, cakes, sweet bakes) are out of scope. On the first 868 parsed pages, 576 are in scope.

#### P3.2 API usage

| ID | Rule |
|----|------|
| A1 | Read the key from the environment variable `ANTHROPIC_API_KEY`. Do not log the key. Do not write it to a file. Support an optional git-ignored `.env` file. |
| A2 | Use the official SDK `@anthropic-ai/sdk` inside an Effect service. Verify all SDK types in `node_modules/@anthropic-ai/sdk`. |
| A3 | Request JSON output with `output_config.format` (`type: "json_schema"`). Do not use the deprecated `output_format`. |
| A4 | The API JSON Schema subset: every object has `additionalProperties: false`; no `minimum`/`maximum`, no `minLength`/`maxLength`; `minItems` only 0 or 1; no recursion; ≤ 16 properties with `anyOf` or type arrays; ≤ 24 optional properties. Make all properties required; express "no value" as `null`. Do not combine `enum` or `const` with a type array (the API returns HTTP 400); write a nullable enum as `anyOf: [{type, enum}, {type: "null"}]`. Enforce numeric ranges in the Effect Schema decoder after the response. |
| A5 | Modes: batch (Message Batches API, default for runs over 20 recipes) and sync (`--sync`, concurrency 4, for small runs). Batch mode stores the batch ID in `data/enriched/_batch.json`, so a new run can resume polling. |
| A6 | Model: flag `--model`. Supported: `claude-haiku-5-5`, `claude-sonnet-5-5`. Default: `claude-haiku-5-5` (evaluation 2026-10-12: 338/340 vs 339/340 for Sonnet, cost 1/19). |
| A7 | Prompt caching: put the system prompt first and mark it with `cache_control`. |
| A12 | Thinking (official docs, 2026-10-12): Haiku 5.5 gets `thinking: {type: "disabled"}`. Sonnet 5.5 rejects `disabled` with HTTP 400 and gets `thinking: {type: "between_tools"}`. Do not send an effort value. The minimum cacheable prompt is 512 tokens for both models. |
| A8 | Cache: skip a recipe if `data/enriched/<id>.json` has the same `inputHash`. `inputHash` = sha256 of (canonical JSON of the recipe input + `promptVersion` + model). |
| A9 | A response that fails the schema decoder, or has `stop_reason` `max_tokens` or `refusal`, is a failure. Sync mode retries once and adds the decoder error to the prompt. Batch mode lists the failures; `--retry-failed` processes them in sync mode. |
| A10 | The report contains token usage and an estimated cost per model. Prices are a constant table in USD per million tokens (October 2026): Sonnet 5.5 input 2, output 10, cache read 0.10; Haiku 5.5 input 0.10, output 0.50, cache read 0.01. Batch: 50 % of these. |
| A11 | Flag `--out-dir` (default `data/enriched`) so that evaluation runs with different models do not overwrite each other. Flags `--ids`, `--limit`, `--data-dir` as in P1/P2. |

#### P3.3 Model input

Send only: title, intro, yieldText, servingsText, ingredient groups (with line numbers 0..n−1 over all groups), steps, category names. Do not send comments.

#### P3.4 `EnrichedRecipe`

Meta: `id`, `enrichmentVersion: 1`, `model`, `promptVersion`, `inputHash`, `createdAt`, `usage` (input, output, cache read tokens).

LLM result `enrichment`:

| Field | Type | Meaning |
|-------|------|---------|
| `dishType` | `"soup" \| "main" \| "side" \| "salad" \| "snack" \| "savory_bake" \| "pancakes" \| "sauce" \| "other"` | |
| `mealFit` | `"full_meal" \| "needs_side" \| "side_only" \| "not_a_meal"` | can it be a lunch or dinner alone |
| `sideHint` | string \| null | a side that the author mentions ("рис или картофель"); null if none |
| `proteinFamilies` | array of `"chicken" \| "turkey" \| "duck" \| "pork" \| "beef" \| "lamb" \| "rabbit" \| "fish" \| "seafood"` | by animal; offal and mince go to their animal |
| `vegetarian` | boolean | no meat, fish or seafood |
| `ingredients` | array (see below) | one item per raw line; a line with 2 products ("соль, перец") gives 2 items |
| `servings` | `{ min: number, max: number, source: "page" \| "estimated" }` | `page` if the page states it |
| `activeMinutes` | number | hands-on time, estimate |
| `totalMinutes` | number | start to serving, without long waits |
| `longWaitHours` | number \| null | marinate, rest, chill: hours; null if none |
| `heat` | `0 \| 1 \| 2 \| 3` | 0 none; 1 mild (black pepper, paprika); 2 noticeable (some chilli, adjika); 3 hot |
| `difficulty` | `1 \| 2 \| 3` | 1 simple; 3 complex (dough work, many stages) |
| `equipment` | array of `"hob" \| "oven" \| "microwave" \| "air_fryer" \| "food_processor" \| "blender" \| "immersion_blender" \| "mixer" \| "grill" \| "slow_cooker" \| "deep_fryer" \| "special"` | `special` = equipment outside H7 |
| `fridgeDays` | number | days the cooked dish keeps in the fridge (0–4) |
| `freezable` | boolean | the cooked dish freezes well |
| `reheats` | `"well" \| "ok" \| "poor" \| "served_cold"` | quality on day 2–3 |

Ingredient item:

| Field | Type | Meaning |
|-------|------|---------|
| `line` | number | index of the raw line |
| `item` | string | the product to buy, Russian, nominative, lower case, without quantity and preparation ("куриное филе", "лук репчатый", "сливки") |
| `detail` | string \| null | variant or note ("15–20%", "сырокопченый") |
| `category` | `"poultry" \| "meat" \| "fish" \| "seafood" \| "dairy" \| "eggs" \| "vegetable" \| "fruit" \| "herb" \| "grain" \| "pasta" \| "legume" \| "bakery" \| "canned" \| "frozen" \| "sauce" \| "spice" \| "oil" \| "sweet" \| "nuts" \| "other"` | |
| `pantry` | boolean | a staple that the household has: salt, pepper, sugar, flour, oil, vinegar, dry spices, baking powder, soda, water |
| `quantity` | number \| null | as written; range → upper value |
| `unit` | `"g" \| "ml" \| "pcs" \| "tbsp" \| "tsp" \| "pinch" \| "bunch" \| "clove" \| "slice" \| "pack"` \| null | normalised ("ст. л." → `tbsp`) |
| `grams` | number \| null | estimated mass in g (or volume in ml) for the shopping list |
| `optional` | boolean | "по желанию", "для подачи" |

#### P3.5 Evaluation and acceptance

1. `test/fixtures/gold.json` (committed): 20 recipes with expected facts, checked by a human-style reading of the page: `dishType`, `mealFit`, `proteinFamilies`, `vegetarian`, heat range, servings range, active time range, and for 3–5 key lines the expected `item`, `category` and `pantry`. The set includes at least 1 hot dish, 2 soups, 2 salads, 2 fish dishes, 1 vegetarian dish, 1 dish with a long marinade, 1 recipe without servings on the page.
2. `npm run enrich:eval -- --out-dir <dir>` compares the outputs for the gold IDs with `gold.json` and prints a score per field and in total.
3. The user runs sync enrichment of the gold IDs with both models. The coordinator compares the scores and the costs and sets the default model.
4. Unit tests use a fake API service. No test calls the real API.
5. Acceptance: on the full scope, ≥ 98 % of recipes have a valid enrichment after `--retry-failed`.
6. Result of the full run (2026-10-13, `claude-haiku-5-5`, prompt version 2, batch mode):
   - Scope: 1578 parsed files, 502 out of scope, 1076 in scope.
   - Batch: 1075 of 1076 valid. 1 decode failure (878: an ingredient line without an item). `--retry-failed` (sync): 1 of 1 valid. Total: 1076 of 1076 valid (100 %). Acceptance passed.
   - Tokens (batch): input 709 836, output 740 166, cache read 6 493 404, cache write 12 092. Estimated cost: 0.2538 USD (batch) + 0.0012 USD (retry) = 0.255 USD.
   - Gold set on the full-run outputs: 338/340 (99.4 %). Failed checks: `activeMinutes` of 38 (40, expected 50–100) and 1653 (25, expected 30–70).

### P4 — catalogue, plan rules, shopping list

Input: `data/parsed/<id>.json`, `data/enriched/<id>.json`, `config/household.json`, `config/item-aliases.json`, `data/plans/*.json`. All functions in P4 are pure, except the loaders. P5 calls them.

#### P4.1 Household config (`config/household.json`, committed)

| Key | Default | Rule |
|-----|---------|------|
| `persons` | 3 | H1 |
| `days` | 7 | H1 |
| `meals` | `["lunch", "dinner"]` | H1 |
| `sessions` | `[{ "id": "A", "dayOffset": 0 }, { "id": "B", "dayOffset": 4 }]` | H2. Day 0 is the first day of the plan week (the shopping and session A day, default Saturday). Session B is on day 4 (Wednesday). |
| `shoppingDayOffset` | 0 | H3 |
| `maxDaysPerDish` | 3 | H4 |
| `maxHeat` | 2 | H5. Heat 3 is an error. Heat 2 is a warning. |
| `activeMinutesPerSession` | 150 | H6. More is a warning. |
| `longWaitHoursMax` | 12 | H6. More is an error. Any long wait is a warning. |
| `equipment` | `["hob", "oven", "microwave", "air_fryer", "food_processor", "blender", "immersion_blender", "mixer"]` | H7. Other equipment is an error (`special`, `grill`, `slow_cooker`, `deep_fryer`). |
| `fridgeDaysCap` | 4 | H8 |
| `rawProteinFridgeDays` | 2 | H8 |
| `maxProteinFamilies` | 2 | H9. More is an error. 2 is a warning. |
| `recentWeeks` | 4 | A recipe from a plan of the last 4 weeks is a warning. |

Decode the file with Effect Schema. A missing file uses the defaults.

#### P4.2 Catalogue

1. `loadCatalogue(dataDir)` joins ParsedRecipe and EnrichedRecipe by ID. A recipe is in the catalogue if both files decode and `mealFit` is not `not_a_meal`. The loader returns the catalogue and a list of skipped IDs with the reason.
2. `CatalogueEntry` contains: id, url, title, primary category, commentsCount, and the full `enrichment`. It does not contain intro or step texts. `getRecipeDetails(id)` reads them from ParsedRecipe on demand (for P5 `get_recipe`).
3. Item normalisation: `normaliseItem(item, aliases)` → lower case, `ё` → `е`, trim, collapse spaces, then the alias map (`config/item-aliases.json`: `{ "<variant>": "<canonical>" }`, committed, starts empty). Use the normalised name everywhere in P4.
4. `searchRecipes(catalogue, query)` filters and sorts. Filters (all optional): `text` (each word of 4+ letters matches by prefix of 4+ letters against title words and normalised items; shorter words must match fully), `proteinFamilies` (any of), `vegetarian`, `dishTypes`, `mealFits`, `maxActiveMinutes`, `maxTotalMinutes`, `maxHeat`, `maxDifficulty`, `requiresOnly` (equipment subset), `includesItems` (all of), `excludeIds`, `limit` (default 20, max 100). Sort: `popular` (commentsCount desc, default) or `fewest_items` (non-pantry, non-optional item count asc). The result row is compact: id, title, url, dishType, mealFit, proteinFamilies, vegetarian, servings, activeMinutes, totalMinutes, longWaitHours, heat, difficulty, fridgeDays, freezable, reheats, sideHint, `buyItems` (normalised non-pantry items), commentsCount.
5. `itemsReport(catalogue)` lists each normalised item with the number of recipes and the raw variants. CLI `npm run items:report` writes `data/items-report.json`. The coordinator uses it to fill the alias map.
   Result (T3, 2026-10-13): the 200 most frequent non-pantry items reviewed (non-pantry = `pantry: true` in less than 50 % of the uses). `config/item-aliases.json` has 147 variants in 94 groups, approved by the user. Rejected merges: egg yolks and whites into `яйца`, `макароны` and `паста` into `макаронные изделия`. Distinct items in the catalogue (974 recipes): 568 before the aliases, 421 after. Distinct non-pantry items: 505 before, 369 after.

#### P4.3 Plan model (`WeekPlan`, Effect Schema)

```
WeekPlan {
  weekStart: "YYYY-MM-DD"            // day 0
  cooking: [{ session: "A" | "B", recipeId, scale }]   // scale ∈ {0.5, 1, 1.5, 2, 2.5, 3}
  meals:   [{ day: 0..6, meal: "lunch" | "dinner", recipeIds: RecipeId[] }]   // 1–3 dishes per slot
  notes: string | null
}
```

A dish in `meals` must be in `cooking`. A recipe is cooked once per week (one cooking entry per recipe ID).

#### P4.4 `evaluatePlan(plan, catalogue, household, history)` → `PlanEvaluation`

Result: `ok: boolean` (no errors), `errors[]`, `warnings[]` (each: `code`, `message` in Russian, related IDs, days), and `metrics`.

Rules (E = error, W = warning):

| Code | Level | Rule |
|------|-------|------|
| `unknown_recipe` | E | ID is not in the catalogue. |
| `not_cooked` | E | A dish in `meals` has no `cooking` entry. |
| `cooked_not_eaten` | W | A cooked dish is in no meal. |
| `slot_missing` | E | A slot (day × meal) has no dish. Every slot of `days × meals` must exist once. |
| `slot_not_a_meal` | E | A slot has no `full_meal` dish, and no `needs_side` dish together with a `side` or `side_only` dish. |
| `eaten_before_cooked` | E | A dish is eaten on a day before its session day. |
| `portions_short` | E | Portions eaten (persons × number of slots with the dish) > `servings.max × scale`. |
| `portions_tight` | W | Portions eaten > `servings.min × scale`. |
| `portions_left` | W | Portions left > persons × 2 (food waste). |
| `too_many_days` | E | The dish is eaten on more than `maxDaysPerDish` distinct days. |
| `same_day_twice` | W | The same dish at lunch and dinner on the same day. |
| `not_fresh` | E | Day eaten − session day > min(`fridgeDays`, `fridgeDaysCap`). |
| `heat` | E/W | heat > `maxHeat` is E; heat = `maxHeat` is W. |
| `equipment` | E | Equipment outside `household.equipment`. |
| `active_time` | W | Sum of `activeMinutes × scale-factor` per session > `activeMinutesPerSession` (scale-factor 1 for scale ≤ 1.5, 1.25 above). |
| `long_wait` | E/W | `longWaitHours` > `longWaitHoursMax` is E; any value > 0 is W (plan the wait). |
| `protein_families` | E/W | Distinct families of all cooked dishes > `maxProteinFamilies` is E; = 2 is W. |
| `recent_repeat` | W | Recipe in a saved plan of the last `recentWeeks` weeks. |

Metrics: `buyItemCount` (number of distinct normalised non-pantry, non-optional items: the main objective), `pantryItemCount`, `proteinFamilies`, `dishCount`, `portions` per dish (made min/max, eaten, left), `activeMinutes` per session, `slotsCovered`.

#### P4.5 `shoppingList(plan, catalogue, household)` → `ShoppingList`

1. Take every ingredient of every cooked dish. Multiply `quantity` and `grams` by `scale`.
2. Group by normalised item. Sum `grams` if every line of the group has grams. Else sum `quantity` per unit (convert `tbsp` → 15 ml, `tsp` → 5 ml when the unit is the only data). Keep the per-unit sums and a flag `approximate` if units mix.
3. Sections: `buy` (non-pantry, non-optional), `optional` (non-pantry, optional), `check_at_home` (pantry). Inside `buy`, group by `category` in a fixed shop order: vegetable, herb, fruit, poultry, meat, fish, seafood, dairy, eggs, bakery, grain, pasta, legume, canned, frozen, sauce, nuts, sweet, spice, oil, other.
4. Each item lists the recipe IDs that use it.
5. Actions: for each item with category poultry, meat, fish or seafood that a session uses more than `rawProteinFridgeDays` after the shopping day, add the action "заморозить в день покупки, разморозить в холодильнике накануне сессии <id>". This rule is a heuristic: cured or smoked products get the same note.
6. `renderShoppingList(list)` → Markdown in Russian, with metric units (g, kg above 1000 g, ml, l above 1000 ml, шт.).

#### P4.6 Plan files

1. `savePlan(plan)` validates the plan (decode only, rules are not required to pass) and writes `data/plans/<weekStart>.json` atomically. `loadHistory()` reads all plans.
2. CLI `npm run plan:check -- <file>` prints the evaluation and the Markdown shopping list.

#### P4.7 Acceptance

Tests use a synthetic catalogue (invented recipes and items). Each rule in P4.4 has at least 1 test that triggers it and 1 that does not. The shopping list aggregation has tests for gram sums, mixed units, scale and the freeze action. A golden test renders a complete synthetic week.

### P5 — MCP server

1. Stdio MCP server, official TypeScript SDK `@modelcontextprotocol/sdk` (verify the API in `node_modules`). Command `npm run mcp`. Logs go to stderr only.
2. The tool input schemas come from Effect Schema (one source of truth). Tool results are compact JSON text.
3. Tools: `search_recipes` (P4.2.4), `get_recipe` (catalogue entry + ingredient lines + steps, for one ID), `evaluate_plan` (P4.4), `shopping_list` (P4.5, JSON and Markdown), `save_plan` (P4.6), `plan_history` (last n plans: weekStart, recipe IDs and titles), `household` (the config).
4. A prompt resource `plan_week` explains the planning method to the LLM: pick 1 protein family (2 at most), pick 2–3 dishes per session, check with `evaluate_plan`, lower `buyItemCount`, fix all errors, then call `shopping_list` and `save_plan`. The final menu shows titles and links only.
5. README: setup for Claude Desktop (`claude_desktop_config.json` with absolute paths to node and the project) and for Claude Code (`claude mcp add`).

### P6 — first weekly menu

Week 2026-10-17 (Saturday), made with the prompt `plan_week` in Claude Code over the `say7` MCP server. Plan: `data/plans/2026-10-17.json` and `.md` (git-ignored). The user approved the third draft on 2026-10-13.

1. Evaluation: `ok: true`, 0 errors. Warnings: `long_wait` (1361, 0.5 h) and `protein_families` (chicken and fish, 2 is the maximum). All 14 slots are covered.
2. Baseline: `buyItemCount` 27, pantry items 8, 8 dishes. Active minutes: session A 140, session B 95.
3. Dishes. Session A: 863 (×1), 1361 (×1), 564 (×2), 865 (×1). Session B: 250 (×2.5) with 101 (×1.5) in the same slots, 1668 (×1.5), 1275 (×1).
4. Feedback of the user on the drafts (to convert into rules, see docs/HANDOFF.md T5.3):
   - No soups.
   - A side dish (potato, pasta, buckwheat, cabbage and so on) does not repeat in the week.
   - No rice this week (permanent or not: open question).
   - Dinners are light: fish, dishes from cottage cheese, filled pancakes, lean pies and quiches, omelettes, casseroles. No mayonnaise and no cream or cheese sauces at dinner.
   - Lunches can be heavier.
   - The first draft (4 of 5 dishes with rice, 11 items) was monotonous. A low `buyItemCount` alone does not make a good menu.
5. Problems of the tools found in P6:
   - The shopping list gives eggs in grams (413 g) and yolks as a separate item. It gives buckwheat in ml. Convert to pieces or grams.
   - A whole stuffed pumpkin (982) at scale 2.5 gave 5 kg of pumpkin. Scale by pieces is unclear for whole vegetables.
   - Mayonnaise (74) has no amount.
   - No catalogue recipe combines chicken, mushrooms and buckwheat. 2 recipes in 1 slot (main + side) work.

