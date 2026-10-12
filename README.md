# say7 meal planner

This project plans lunches and dinners for one week from the recipes of https://www.say7.info.
The full design is in `docs/SPEC.md`.

This README covers phase P1: the scraper.
The scraper downloads every recipe page to the local disk.

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

## Development

| Command | Action |
|---------|--------|
| `npm run typecheck` | Check the types with `tsc --noEmit`. |
| `npm test` | Run the tests with Vitest. |
| `npm run scrape -- <flags>` | Run the scraper. |

Source layout:

```text
src/domain/    Effect Schemas: RecipeId, SitemapEntry, RawIndexEntry, RawIndex
src/scraper/   sitemap.ts, robots.ts, charset.ts, plan.ts, outcome.ts   pure functions
               http.ts, pacer.ts, store.ts                              services (HTTP, delay, files)
               run.ts, cli-options.ts, layers.ts, cli.ts                 program and entry point
test/          unit tests, and end-to-end tests against a local HTTP server
```
