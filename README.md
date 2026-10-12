# say7 meal planner

This project plans lunches and dinners for one week from the recipes of https://www.say7.info.
The full design is in `docs/SPEC.md`.

This README covers phase P1 (the scraper) and phase P2 (the parser).
The scraper downloads every recipe page to the local disk.
The parser reads the downloaded pages and writes one JSON file for each recipe.

## Setup on macOS

1. Check the Node.js version.

   ```sh
   node -v
   ```

   The version must be v22.13 or higher.
   If the version is lower, install Node.js 22 LTS from https://nodejs.org or with `brew install node@22`.

2. Go to the project directory and install the packages.

   ```sh
   cd recipes
   npm install
   ```

   The packages need no compiler.
   The platform binaries (esbuild, TypeScript) come prebuilt from npm.

3. Check the installation.

   ```sh
   npm run typecheck
   npm test
   ```

   Both commands must finish without errors.
   The tests use no network, except a local server on 127.0.0.1.

## Download the recipes

Do a small test run first.
This command downloads the first 20 recipes that the cache does not have.

```sh
npm run scrape -- --limit 20
```

Then do the full run.

```sh
npm run scrape
```

A full run takes about 75 minutes.
The scraper waits 2.5 s (plus or minus 20 %) between two requests, and the sitemap lists about 1700 recipes.
Keep the Mac awake during the run, for example with `caffeinate -i npm run scrape`.

The scraper prints one line for each page:

```text
[3/20] 1590 ok 45.2 KB 2310 ms
[4/20] 77 not_found - 340 ms
[5/20] 12 error - 30012 ms (HTTP 503)
```

The fields are: position `[k/n]`, recipe ID, status, size of the download, and time of the request.
At the end the scraper prints the totals: fetched, skipped, not found and errors.

### Stop and resume

Press Ctrl+C to stop the scraper at any time.
The scraper finishes the write of the current page and exits with code 130.
No data is lost.

To resume, run the same command again.
The scraper skips each page that is current, and fetches the rest.
The same command also updates the cache later, because it fetches the pages whose `lastmod` in the sitemap changed.

### Flags

Put the flags after `--`, for example `npm run scrape -- --ids 56,1590 --force`.

| Flag | Default | Meaning |
|------|---------|---------|
| `--limit <n>` | all | Process the first n sitemap entries that need a fetch. |
| `--ids <id,id,...>` | all | Process only these recipe IDs. |
| `--force` | off | Fetch again, also if the cache is current. |
| `--delay-ms <n>` | `2500` | Base delay between requests in milliseconds. |
| `--base-url <url>` | `https://www.say7.info` | Origin of the site. Tests use this flag. |
| `--data-dir <path>` | `data` | Directory for the downloaded data. |
| `-h`, `--help` | | Print the list of flags. |

Do not set `--delay-ms` below 2500 for the real site.
Use a lower value only with `--base-url` and a local test server.

Exit codes: `0` when all pages are done, `1` when a page failed or a fatal error occurred (including the stop after 5 errors in a row), `2` for a wrong flag, `130` after Ctrl+C.
After exit code `1` for failed pages, run the command again.
The scraper tries those pages again.

### Rules that the scraper follows

- It reads `/robots.txt` first. It stops with an error if the file disallows a recipe URL.
- It fetches only `https://www.say7.info/cook/recipe/<id>-<slug>.html`. It never fetches a URL with a query string, a search page or an image.
- It sends one request at a time.
- It sends the header `User-Agent: say7-meal-planner/0.1 (personal non-commercial use)`.
- It stops after 5 pages in a row with status `error`. The site can be down or can block the scraper. The scraper prints the totals and exits with code 1. A page with status `ok` or `not_found` resets the count. Wait some time, then run the command again.
- One request waits at most 30 s. The scraper retries 3 times (after 2 s, 4 s and 8 s) on network errors, 429 and 5xx. It honours `Retry-After` on 429 and 503. It never retries 404.

## Downloaded data

```text
data/raw/<id>.html   one file for each recipe, text in UTF-8
data/raw/index.json  what the scraper knows about each recipe
```

The directory `data/` is git-ignored.
The site forbids the re-publication of its texts and photos.
Keep the files on this computer.

The pages use the windows-1251 charset on the site.
The scraper decodes each page and stores the text as UTF-8.
It does not change the text.
A `<meta charset>` tag in the file can still name windows-1251, so a browser can show wrong characters.
Programs must read the files as UTF-8.

`index.json` has this form:

```json
{
  "version": 1,
  "entries": {
    "1590": {
      "id": 1590,
      "url": "https://www.say7.info/cook/recipe/1590-Tort-Tri.html",
      "lastmod": "2025-10-20",
      "fetchedAt": "2026-10-12T13:28:47.837Z",
      "status": "ok",
      "httpStatus": 200,
      "bytes": 46284,
      "sha256": "c746b6ae…",
      "error": null
    }
  }
}
```

- `status` is `ok`, `not_found` (HTTP 404) or `error`.
- `bytes` and `sha256` describe the original bytes from the server, before the conversion to UTF-8.
- The scraper skips a recipe when the status is `ok`, the file exists, and `lastmod` is the same as in the sitemap.
  If the sitemap has no `lastmod` for a recipe, any `ok` entry with a file is enough.
- The scraper skips a `not_found` entry when the sitemap has a `lastmod` and it is the same as in the index.
  It tries the page again when the `lastmod` is different, or when the sitemap has no `lastmod`.
- The scraper tries each `error` entry again on each run.
- The flag `--force` fetches all pages again.
- If a refetch fails and an older copy with status `ok` exists, the scraper keeps the older entry and file.
- If `index.json` is not valid, the scraper stops and does not overwrite the file.

## Parse the recipes

Run the scraper first. The parser reads the files in `data/raw/`.

```sh
npm run parse
```

The parser reads `data/raw/index.json`.
It parses each page with status `ok`.
A full run takes a few seconds.

The parser prints one line for each page:

```text
[3/1690] 1590 ok
[4/1690] 61 ok (warnings: no_servings, no_durations)
[5/1690] 12 failed no_steps (The page has no step under the heading "Приготовление")
```

At the end the parser prints the totals and the number of warnings of each kind:

```text
done: parsed 1689, failed 1, with warnings 340
warnings: no_servings 210, no_durations 130
```

The parser reads only `data/raw/`.
It never changes the files there.
It does not use the network.
The scraper can run at the same time.

### Parser flags

Put the flags after `--`, for example `npm run parse -- --ids 56,1590`.

| Flag | Default | Meaning |
|------|---------|---------|
| `--ids <id,id,...>` | all | Parse only these recipe IDs. |
| `--data-dir <path>` | `data` | Directory of the downloaded data. |
| `-h`, `--help` | | Print the list of flags. |

Exit codes: `0` when all pages are parsed, `1` when a page failed or a fatal error occurred, `2` for a wrong flag.
A fatal error is a missing or invalid `index.json`, or a file that the parser cannot write.

The parser also runs without `npm`, on Node.js v22.18 or higher:

```sh
node src/parser/cli.ts --ids 1590
```

### Parsed data

```text
data/parsed/<id>.json    one file for each parsed recipe
data/parsed/_report.json totals, failed pages and warnings of the last run
```

Each run writes a file to a temporary name first, then renames it.
A stop in the middle of a run never leaves a half-written file.
The next run removes the temporary files that remain.
If a page fails now, the parser removes the file of an earlier run for this page.
A run with `--ids` does not change the files of the other recipes.
It replaces `_report.json`, so the report then covers only the pages of that run.

A recipe file has these fields:

| Field | Meaning |
|-------|---------|
| `parserVersion` | Version of the file format. Now `1`. |
| `id`, `url`, `title` | ID, canonical URL and name of the recipe. |
| `intro` | Paragraphs of the description before the ingredient list. Quotations are not included. |
| `categories` | The categories of the block "Категории рецепта": `id`, `slug`, `name`. |
| `ingredientGroups` | Groups of ingredient lines. `title` is `null` when the page has one list without parts. |
| `steps` | Text of each step. A line break in a step is `\n`. |
| `yieldText` | Text of the element `.p-yield`, for example `8–10 порций` or `100–110 штук`. `null` when the page has none. |
| `servingsText` | Text that names the portions. The source is the first of: `yieldText` (if it contains "порци"), a sentence of the intro with "порци", a sentence of the steps with "порци". Otherwise `null`. |
| `servings` | `min` and `max` from `servingsText`. `null` when the parser reads no number. A yield in pieces (`штук`, `котлет`) gives no `servings`. |
| `durations` | Times in the steps, in minutes: `minMinutes`, `maxMinutes`, `text`. |
| `longWait` | `true` when a step names a wait of 6 hours or more, a night or a day. |
| `addedAt` | Date of the recipe as `YYYY-MM-DD`, or `null`. |
| `commentsCount` | Number of comments, or `null`. |
| `similarIds` | IDs in the block "Похожие". |
| `sourceSha256` | SHA-256 of the UTF-8 text of the page. |

The text in the file is clean:
a non-breaking space is a space, a non-breaking hyphen is `-`, and white space is collapsed.
Image URLs are not included.

### Failed pages and warnings

A page fails when it has no title, no canonical URL, a canonical URL with another ID, no ingredient line or no step.
`_report.json` lists each failed page with its ID, a reason and a message.
The reason is `no_title`, `no_url`, `id_mismatch`, `no_ingredients`, `no_steps`, `invalid_output` or `unreadable` (the file cannot be read).

A page with missing optional data passes.
The report counts it as a warning and lists the IDs for each kind:

| Warning | Meaning |
|---------|---------|
| `no_intro` | The page has no description. |
| `no_servings` | No source for `servingsText`: the yield has no "порци", and no sentence of the intro or the steps has it. |
| `servings_unparsed` | `servingsText` exists, but it has no number of servings. |
| `no_durations` | No time in the steps. |
| `no_added_date` | The page has no date of addition. |
| `no_comments_count` | The page has no "Комментарии (N)" heading. |
| `no_categories` | The page has no category. |
| `categories_from_breadcrumb` | The page has no block "Категории рецепта". The categories come from the breadcrumb at the top of the page. |
| `no_similar` | The page has no block "Похожие". |

`_report.json` has this form:

```json
{
  "version": 1,
  "parserVersion": 1,
  "generatedAt": "2026-10-12T14:20:00.000Z",
  "totals": { "processed": 34, "ok": 34, "failed": 0, "withWarnings": 11 },
  "failed": [],
  "warningCounts": { "no_intro": 0, "no_servings": 7, "…": 0 },
  "warningIds": { "no_intro": [], "no_servings": [246, 275, "…"], "…": [] }
}
```

### Test pages

The golden tests of the parser read 34 real pages from `test/fixtures/real/`.
This directory is git-ignored, because the site forbids the re-publication of its pages.
The list of IDs is in `test/fixtures/real-ids.json`.

Copy the pages from `data/raw/` to the test directory:

```sh
npm run fixtures:refresh
```

Use the flag `--data-dir <path>` to read from another data directory.
The command prints the IDs that `data/raw/` does not have, and exits with code 1.

If a page file is absent, the golden test for this page is skipped.
The test output names the file.

## Development

| Command | Action |
|---------|--------|
| `npm run typecheck` | Check the types with `tsc --noEmit`. |
| `npm test` | Run the tests with Vitest. |
| `npm run scrape -- <flags>` | Run the scraper. |
| `npm run parse -- <flags>` | Run the parser. |
| `npm run fixtures:refresh` | Copy the test pages from `data/raw/` to `test/fixtures/real/`. |

Source layout:

```text
src/domain/    Effect Schemas: RecipeId, SitemapEntry, RawIndexEntry, RawIndex,
               ParsedRecipe, ParseError, ParseReport
src/scraper/   sitemap.ts, robots.ts, charset.ts, plan.ts, outcome.ts   pure functions
               http.ts, pacer.ts, store.ts                              services (HTTP, delay, files)
               run.ts, cli-options.ts, layers.ts, cli.ts                 program and entry point
src/parser/    text.ts, servings.ts, durations.ts, dates.ts, dom.ts      pure functions
               extract.ts, parse.ts (parseRecipe), plan.ts, report.ts     pure functions
               store.ts                                                    service (files)
               run.ts, cli-options.ts, layers.ts, cli.ts                   program and entry point
               fixtures.ts, fixtures-cli.ts                                copy of the test pages
test/          unit tests, golden tests of the 34 real pages,
               and end-to-end tests against a local HTTP server and a temporary data directory
```
