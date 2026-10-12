# say7 meal planner — specification

Status: P1 in progress. Owner of this file: the coordinator. Coding agents do not edit it.

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
                              P4 index ──► data/recipes.db (node:sqlite, FTS5)
                                   │
                                   ▼
                              P5 MCP server (stdio) ──► Claude Desktop / Claude Code
```

Principle: the LLM selects dishes. Deterministic code counts ingredients, sums quantities and checks constraints. The LLM does not calculate the shopping list.

## 5. Technical constraints

| ID | Constraint |
|----|------------|
| T1 | Node.js ≥ 22.13 (P4 uses the built-in `node:sqlite`). Package manager: npm. Commit `package-lock.json`. |
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

### P2 — parser (after real pages are available)

ParsedRecipe for every cached page. Golden tests on real pages, which include old (ID < 300) and new (ID > 1600) templates. Selectors come only from real files.

### P3 — enrichment

Method is open (LLM API key or batch processing with subagents). Decision before P3 starts.

### P4 — index and plan tools

SQLite + FTS5. Pure functions `evaluatePlan(plan)` and `shoppingList(plan)`.

### P5 — MCP server

Tools: `search_recipes`, `get_recipe`, `evaluate_plan`, `shopping_list`, `save_plan`, `plan_history`.

### P6 — first weekly menu
