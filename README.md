# say7 meal planner

This project plans breakfasts, lunches and dinners for one week from the recipes of https://www.say7.info.
The full design is in `docs/SPEC.md`.

This README covers phase P1 (the scraper), phase P2 (the parser), phase P3 (the enrichment) and the commands of phase P4 (the plan rules and the shopping list).
The scraper downloads every recipe page to the local disk.
The parser reads the downloaded pages and writes one JSON file for each recipe.
The enrichment asks the Anthropic API for structured facts about each recipe.

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

## Enrichment

Run the scraper and the parser first. The enrichment reads the files in `data/parsed/`.
For each recipe in scope it asks the Anthropic API for structured facts.
The facts are: the type of dish, the protein families, the ingredients to buy, the times, the heat and the storage.
The planner uses these facts in the later phases.

A recipe is in scope when it has one of these categories:
Вторые блюда, Салаты, Закуски и бутерброды, Первые блюда, Рыба и морепродукты, Несладкая выпечка, Блины, оладьи, сырники, Выпечка из творога.
The category Выпечка из творога (233) holds breakfast candidates. Other desserts and sweet bakes are out of scope.

The request contains the title, the intro, the yield, the servings text, the numbered ingredient lines, the steps and the category names.
It contains no comments.
The texts of the recipes go to the API of Anthropic. The result files stay in `data/`, which is git-ignored.

### Set the API key

Get a key in the console of Anthropic. Then set it in the shell:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
```

Or write it to the file `.env` in the project directory:

```text
ANTHROPIC_API_KEY=sk-ant-...
```

Git ignores `.env`.
A variable in the environment has priority over the same variable in `.env`.
The program never prints the key and never writes it to a result file.
It stops with a message when the key is missing.

### Dry run

Do a dry run before the first paid run:

```sh
npm run enrich -- --dry-run
```

The dry run needs no key and no network. It sends no request and writes no file.
It builds the request for each recipe in scope, with the same code as a real run, and checks each request.
Then it prints the sizes and the estimated cost of both models.
Add `--model <name>` to see one model only.

```text
dry run: no request goes to the API and no file changes
parsed files: 1578, unreadable 0, out of scope 502, in scope 1076
requests: 1076 (a real run uses batch mode)
input characters: 15 068 905 in all, 14 005 for each request on average
  each request: system prompt 10 463, output schema 2 178, recipe 691 to 3 849 (average 1 364)
validation: 1076 requests for 2 models, no problem
estimated cost in USD (3.5 characters for each input token, 1200 output tokens for each recipe):
  model               input tokens  output tokens     batch      sync  batch+cache
  claude-haiku-5-5       4 305 402      1 291 200    0.5381    1.0761       0.3935
  claude-sonnet-5-5      4 305 402      1 291 200   10.7614   21.5228       7.7086
```

The numbers are an estimate. The real token count can differ by a third.
The column `batch` is the price of the Message Batches API (50 % of the sync price).
The column `batch+cache` is the lowest price: the system prompt comes from the prompt cache for every request but the first.
The real cost is in `_report.json` after a run.
The command exits with code 1 when a request is not valid.

### Choose the model (pilot)

The spec has no default model. Compare both models on the 20 recipes of the gold set `test/fixtures/gold.json`.
The gold set has the facts that a person checked by hand.
The pilot costs little. The dry run estimate for the 20 recipes at the sync price is about 0.02 USD for Haiku and 0.4 USD for Sonnet.

1. Enrich the gold recipes with Haiku in sync mode. The results go to `data/eval/haiku`.

   ```sh
   npm run enrich -- --model claude-haiku-5-5 --sync --out-dir data/eval/haiku --ids 38,61,246,935,1057,1171,1282,1321,1429,1434,1587,1601,1623,1635,1653,1676,1679,1688,1701,1731
   ```

2. Do the same with Sonnet. The results go to `data/eval/sonnet`.

   ```sh
   npm run enrich -- --model claude-sonnet-5-5 --sync --out-dir data/eval/sonnet --ids 38,61,246,935,1057,1171,1282,1321,1429,1434,1587,1601,1623,1635,1653,1676,1679,1688,1701,1731
   ```

3. Score each output directory against the gold set.

   ```sh
   npm run enrich:eval -- --out-dir data/eval/haiku
   npm run enrich:eval -- --out-dir data/eval/sonnet
   ```

The evaluation prints one row for each field and the total, then the failed checks, the tokens and the cost.
It also writes `_eval.json` to the output directory.
Compare the total score and the cost of both models, then choose one.
If the output says `no enrichment for: <ids>`, run the command of step 1 or step 2 again.
Use `--retry-failed` instead of `--ids`, with the same `--model` and `--out-dir` (see "Retry the failures").

| Flag of `enrich:eval` | Default | Meaning |
|-----------------------|---------|---------|
| `--out-dir <path>` | `<data-dir>/enriched` | Directory with the enrichments to score. |
| `--data-dir <path>` | `data` | Directory with `parsed/`. The evaluation reads the ingredient lines from it. |
| `--gold <path>` | `test/fixtures/gold.json` | The gold file. |
| `-h`, `--help` | | Print the list of flags. |

### Full run

Use the model that you chose. This example uses Haiku:

```sh
npm run enrich -- --model claude-haiku-5-5
```

A run of more than 20 recipes uses batch mode (the Message Batches API).
The program sends all requests as one batch, writes the batch ID to `data/enriched/_batch.json`, and polls the batch.
The program polls at once. Then it waits 15 s, and each next wait is 1.5 times longer, up to 5 min.
A batch needs from a few minutes to 24 hours. The price is 50 % of the sync price.
When the batch has ended, the program stores one file for each valid answer and writes `_report.json`.
Use `--sync` to send one request for each recipe (4 at the same time), also for a long list.
Use `--limit 5` for a small test run.

The program prints one line for each result:

```text
[3/1076] 1587 ok (input 3100, output 1050, cache read 0)
[4/1076] 61 failed decode (ingredients has no item for the lines 2; every line of the recipe needs at least 1 item)
```

At the end it prints the totals, the tokens and the estimated cost:

```text
done: processed 1076, succeeded 1070, failed 6, cached 0, out of scope 502
tokens: input 4300000, output 1200000, cache read 0, cache write 0; estimated cost 0.5150 USD (batch, claude-haiku-5-5)
```

### Stop and resume

Press Ctrl+C to stop the program at any time.

- In batch mode the batch goes on at the API. `_batch.json` keeps its ID.
  Run the same command again. The program waits for that batch and stores the results.
  While `_batch.json` exists, the program ignores `--ids`, `--limit`, `--sync` and `--retry-failed`. It only waits for that batch.
  If the batch is for another model, the program stops and names the model that it needs.
- In sync mode the program stores each file when the answer arrives.
  Run the same command again. The program skips each recipe that has a current file.

A stored file is current when its `inputHash` is the same as the new one.
The `inputHash` is the SHA-256 of the input of the recipe, the prompt version and the model.
A change of the recipe text, the prompt or the model makes the file old, and the next run asks the API again.

### Retry the failures

An answer is a failure in these cases:
the text is not valid JSON, the text fails the schema, an item points to a line that does not exist,
a line has no item, or the answer ends with `max_tokens` or `refusal`.
Sync mode asks one more time. After a decode failure it adds the error to the prompt.
Batch mode does not ask again. It writes the failures to `_report.json`.

Process the failures of the last report in sync mode:

```sh
npm run enrich -- --model claude-haiku-5-5 --retry-failed
```

Use the same `--out-dir` as in the first run. Do not use `--retry-failed` with `--ids` or `--limit`.
The new `_report.json` lists the failures that remain. Run the command again to try these once more.
The program exits with code 1 when a recipe has no valid enrichment.

### Enrichment flags

Put the flags after `--`, for example `npm run enrich -- --model claude-haiku-5-5 --limit 5`.

| Flag | Default | Meaning |
|------|---------|---------|
| `--model <name>` | `claude-haiku-5-5` | `claude-haiku-5-5` or `claude-sonnet-5-5`. Without `--model`, `--dry-run` estimates both models. |
| `--ids <id,id,...>` | all | Process only these recipe IDs. |
| `--limit <n>` | all | Process the first n recipes that need a call. |
| `--sync` | off | Send one request for each recipe, also for more than 20 recipes. |
| `--retry-failed` | off | Process the failures of `<out-dir>/_report.json` in sync mode. |
| `--data-dir <path>` | `data` | Directory of the downloaded data. The program reads `<data-dir>/parsed/`. |
| `--out-dir <path>` | `<data-dir>/enriched` | Directory for the results. Use one directory for each model in an evaluation. |
| `--dry-run` | off | Build and check the requests, print the estimate. No key, no request, no file. |
| `-h`, `--help` | | Print the list of flags. |

Exit codes: `0` when all recipes are done, `1` when a recipe failed or a fatal error occurred, `2` for a wrong flag.
A wrong key, a key without permission and an account without credit stop the run at once.

### Enriched data

```text
data/enriched/<id>.json   one file for each recipe in scope
data/enriched/_report.json  totals, failures, tokens and cost of the last run
data/enriched/_batch.json   the batch that the directory waits for (only while a batch runs)
<out-dir>/_eval.json        the scores of enrich:eval
```

A recipe file has the fields `id`, `enrichmentVersion`, `model`, `promptVersion`, `inputHash`, `createdAt`, `usage` and `enrichment`.
`usage` has the input, output, cache read and cache write tokens of all attempts for the recipe.
`enrichment` has the 16 fields of the spec (P3.4): `dishType`, `mealFit`, `sideHint`, `proteinFamilies`, `vegetarian`, `ingredients`,
`servings`, `activeMinutes`, `totalMinutes`, `longWaitHours`, `heat`, `difficulty`, `equipment`, `fridgeDays`, `freezable` and `reheats`.
Each run writes a file to a temporary name first, then renames it, so a stop never leaves a half-written file.

### Servings check

The model can get `servings` wrong. Wrong servings give wrong portion findings in the plan rules.

Run the check after the enrichment:

```sh
npm run servings:report
```

The command writes `data/servings-report.json` and prints the totals. The flag `--data-dir` and the flag `--config-dir` work as for `items:report`. A recipe is in the report if one of these is true:

- `servings.source` is `estimated`.
- `servings.max` is more than 12.
- `servings.max` is more than 3 times `servings.min`.
- The portion mass is less than 150 g or more than 700 g.

The portion mass is the sum of `grams` of the lines that are not optional, divided by `servings.max`. The command skips this check if less than 70 % of those lines have `grams`.

To correct a recipe, add its ID to `config/servings-overrides.json`:

```json
{ "935": { "min": 4, "max": 6 } }
```

The values must be positive integers, and `min` must not be more than `max`. The override wins over the enrichment. The file is optional. If an ID is not in the catalogue, the commands print a warning. If the file is not valid, the commands stop with an error.

An overridden recipe stays in the report with `overridden: true`, because the report checks the final servings. The field `servings.source` keeps the value of the enrichment.

## MCP server

The MCP server gives an AI client the tools to search recipes, check a week plan, make the shopping list and save the menu.
It talks over stdio. The server reads the catalogue from `data/` and the settings from `config/`.
The tools return titles, links and facts. They never return the intro or the steps of a recipe.

### Start the server

Run the server by hand to check that it starts:

```sh
npm run mcp
```

The server waits for MCP messages on stdin. Press Ctrl+C to stop it.
The server writes its log to stderr. Stdout carries the protocol only.
If `data/` has no recipes, the server starts anyway. The tool `search_recipes` then returns a hint.
The server loads the catalogue at the start. Restart the server after a new `npm run enrich`.

The server finds the project directory from the location of `src/mcp/server.ts`. The working directory does not matter.
To use other directories, set these variables:

| Variable | Meaning |
|----------|---------|
| `SAY7_DATA_DIR` | The directory with `parsed/`, `enriched/` and `plans/`. The default is `data` in the project. |
| `SAY7_CONFIG_DIR` | The directory with `household.json`, `item-aliases.json`, `servings-overrides.json`, `item-protein.json` and `simple-breakfasts.json`. The default is `config` in the project. |

### Tools and prompt

| Name | Action |
|------|--------|
| `search_recipes` | Search the catalogue with filters, for example `forMeal: "breakfast"`. Returns compact rows with links. |
| `get_recipe` | Return the facts and the ingredient lines of one recipe. |
| `evaluate_plan` | Check a week plan against the rules of the household. |
| `shopping_list` | Return the shopping list as JSON and as Markdown. |
| `save_plan` | Write `data/plans/<weekStart>.json` and `data/plans/<weekStart>.md`. |
| `plan_history` | List the last saved plans. The default is 4. |
| `household` | Return the household settings. |
| `simple_breakfasts` | List the simple breakfasts with the protein per portion and the items. |
| prompt `plan_week` | Give the planning method to the model. Arguments: `weekStart` and optional `proteinFamily`. |

A tool that fails returns `isError: true` and a message in Russian.

### Claude Code

Create the file `.mcp.json` in the project directory:

```json
{ "mcpServers": { "say7": { "command": "npx", "args": ["tsx", "src/mcp/server.ts"] } } }
```

Then run these commands in the project directory:

```sh
claude mcp list
```

Claude Code asks you to approve a project server the first time. The list must show `say7` as connected.
If the server does not connect, use absolute paths in `.mcp.json`, as in the Claude Desktop example below.
You can also add the server with `claude mcp add --scope project say7 -- npx tsx src/mcp/server.ts`.

### Claude Desktop

1. Find the absolute path of Node.js.

   ```sh
   command -v node
   ```

2. Find the absolute path of the project directory.

   ```sh
   pwd
   ```

3. Open the file `~/Library/Application Support/Claude/claude_desktop_config.json`.
4. Add the server. Replace the three placeholders with absolute paths.

   ```json
   {
     "mcpServers": {
       "say7": {
         "command": "<absolute path of node>",
         "args": [
           "<project directory>/node_modules/tsx/dist/cli.mjs",
           "<project directory>/src/mcp/server.ts"
         ]
       }
     }
   }
   ```

   The file `node_modules/tsx/dist/cli.mjs` is the `bin` entry of the package `tsx`. Check it in `node_modules/tsx/package.json`.

5. Restart Claude Desktop.

### Plan a week

Use the prompt `plan_week` with `weekStart` set to the first day of the week (day 0, the shopping day).
The model reads the household and the history, chooses dishes, checks them with `evaluate_plan`, and saves the plan with `save_plan`.

### Taste rules

The key `preferences` in `config/household.json` sets the taste rules. Every sub-key is optional. If the key is missing, the lists are empty and the rules find nothing.
The item names must be normalised names. The program cleans each name and maps it through `config/item-aliases.json`, as for the recipes.

| Key | Meaning |
|-----|---------|
| `excludedDishTypes` | Dish types that the household does not eat, for example `["soup"]`. |
| `sideGroups` | The base of a plate: `{ "<group>": ["<item>", ...] }`. |
| `sideMinGrams` | The minimum grams of an ingredient at scale 1 to give its group to a dish. The default is 100. An ingredient with unknown grams counts. |
| `dinnerAvoidSideGroups` | Side groups that are too heavy for dinner. |
| `dinnerAvoidItems` | Items that are too heavy for dinner. |
| `itemLimits` | A list of `{ "name", "items", "maxDishes" }`. A week can have at most `maxDishes` cooked dishes with any of the items. |

Only ingredients that you buy count. Pantry and optional ingredients do not count.

| Code | Level | Meaning |
|------|-------|---------|
| `dish_type_excluded` | error | A cooked dish has an excluded dish type. |
| `side_repeated` | warning | Two or more cooked dishes have the same side group. |
| `heavy_dinner` | warning | A dish in a dinner slot has a heavy side group or a heavy item. |
| `item_limit` | warning | More cooked dishes than `maxDishes` have an item of a limit. |

### Protein table and `low_protein`

The file `config/item-protein.json` lists the grams of protein per 100 g for each item, as bought. The values are approximate. Item names go through the same cleaning and aliases as the item names of the catalogue.

The planner computes the protein per portion of a recipe from this table. It adds `grams × protein / 100` for each line that is not optional, and divides the sum by the middle of the servings. A line without grams or without a table entry adds 0. The `coverage` value is the share of protein lines that have grams and a table entry.

The key `proteinMinGrams` in `config/household.json` sets the least protein for each meal. The defaults are 15 g for breakfast, 20 g for lunch and 20 g for dinner. If the dishes of a slot give less, `evaluatePlan` returns the warning `low_protein`. It gives one warning for each set of dishes and meal, and it lists the days. If the coverage of a dish is below 0.7, the message says that the estimate is uncertain. If the table is empty, the rule does not run.

The tool `search_recipes` returns `proteinPerPortion` in each row. The tool `get_recipe` returns `protein.grams` and `protein.coverage`. The evaluation has `proteinPerSlot` in its metrics.

To find items that the table does not have, run `npm run items:report`. The report `data/items-report.json` lists them in `missingProtein`. Add them to the table, then run the command again.

### Breakfasts

The household has three meals each day: `breakfast`, `lunch` and `dinner`. Two persons eat breakfast. The third person eats her own simple breakfast. The plan does not count her.

A household whose `meals` has no `breakfast` works as before. The plan needs no breakfast slots then.

These keys of `config/household.json` set the breakfast:

| Key | Default | Meaning |
|-----|---------|---------|
| `meals` | `["lunch", "dinner"]` | The meals of a day. The file of the project has `["breakfast", "lunch", "dinner"]`. |
| `mealPersons` | `{}` | The persons of a meal, for example `{ "breakfast": 2 }`. A meal without a key uses `persons`. |
| `freshMinutesMax` | 20 | The most active minutes of the fresh dishes of one day. |
| `breakfastExtraIds` | `[]` | Recipe IDs that are breakfast candidates in addition to the categories below. |

#### Three kinds of breakfast dish

- A dish of a session. Session A or B cooks it. The household eats it as a leftover. The usual rules apply.
- A fresh dish. Its cooking entry has `"session": "fresh"`. The household cooks it in the morning of each day that it is eaten. The value `scale` is for one cooking day. The shopping list multiplies the quantities by the number of days.
- A simple breakfast. It has no recipe and no cooking entry. It is a fixed set of products from `config/simple-breakfasts.json`.

A fresh dish and a simple breakfast are allowed only in breakfast slots. A fresh dish has no freshness limit, no session day and no freeze action. Its minutes do not count in the active minutes of a session.

#### Simple breakfasts

The file `config/simple-breakfasts.json` lists the simple breakfasts. A missing file is an empty list.

```json
[
  {
    "id": "tvorog-yagody",
    "title": "Творог с ягодами и мёдом",
    "items": [
      { "item": "творог", "grams": 200, "category": "dairy", "pantry": false },
      { "item": "мед", "grams": 15, "category": "sweet", "pantry": true }
    ]
  }
]
```

- The `id` is in kebab-case. Each `id` must be unique.
- The `grams` value is for one portion. The shopping list multiplies it by the persons of each slot.
- The item names go through the same cleaning and aliases as the item names of the catalogue.
- Each item needs an entry in `config/item-protein.json`. The tool `simple_breakfasts` returns the protein per portion.

A slot of the plan can have `recipeIds` and `simpleIds`. It must have at least one of the two. A plan file without `simpleIds` is still valid.

```json
{ "day": 0, "meal": "breakfast", "recipeIds": [], "simpleIds": ["tvorog-yagody"] }
```

#### Breakfast candidates

A recipe is a breakfast candidate in these cases:

- It has the category 50 (Блины, оладьи, сырники), 62 (Закуски из яиц), 63 (Бутерброды), 79 (Рецепты запеканок) or 233 (Выпечка из творога).
- Its ID is in `breakfastExtraIds`.

The catalogue keeps a candidate with `mealFit: not_a_meal`. The field `breakfastEligible` marks it. Such a recipe is valid only in breakfast slots.

The filter `forMeal` of `search_recipes` takes `breakfast`, `lunch` or `dinner`. The value `breakfast` finds the candidates. The values `lunch` and `dinner` find the recipes without `not_a_meal`. If `forMeal` is missing, the search leaves `not_a_meal` recipes out. A `mealFits` filter with `not_a_meal` shows them.

#### Rules of the breakfast

| Code | Level | Meaning |
|------|-------|---------|
| `fresh_time` | warning | The active minutes of the fresh dishes of one day are more than `freshMinutesMax`. |
| `fresh_not_breakfast` | error | A fresh dish is in a lunch or dinner slot. |
| `unknown_simple` | error | A slot names a simple breakfast that `config/simple-breakfasts.json` does not have. |
| `simple_not_breakfast` | error | A simple breakfast is in a lunch or dinner slot. |
| `breakfast_only_recipe` | error | A `not_a_meal` recipe is in a lunch or dinner slot. |

The issue of a rule has the list `simpleIds` next to `recipeIds`.

These rules work in a special way for the breakfast:

- `slot_missing` includes the breakfast slots if `meals` has `breakfast`. A slot with only `simpleIds` is filled.
- `slot_not_a_meal` does not check breakfast slots.
- `not_fresh`, `eaten_before_cooked` and the freeze actions skip fresh dishes.
- The portions eaten use the persons of the meal of each slot. For a fresh dish, the check uses the busiest day, because the dish is cooked again each day.
- `portions_left` uses the most persons of the meals of the dish.
- `too_many_days` applies to fresh dishes. It does not apply to simple breakfasts.
- `low_protein` adds the protein of the recipes and of the simple breakfasts of a slot. The minimum for breakfast is 15 g by default.
- A simple breakfast has no protein family. `protein_families` counts recipes only.
- `side_repeated` ignores a dish that is eaten only at breakfast. A simple breakfast has no side group.
- `item_limit` counts a simple breakfast as a dish.
- `buyItemCount` and `pantryItemCount` include the items of the simple breakfasts.

The shopping list adds the items of a simple breakfast times the persons of each slot. The items go to `buy` or to `check_at_home` (when `pantry` is true). Each item has `simpleIds` next to `recipeIds`. The Markdown list shows `(блюда: 1, 2; завтраки: tvorog-yagody)` and has the section "Простые завтраки". The menu has the breakfast column first, and the section "Утром (свежие блюда)" lists the fresh dishes.

After you add category 233 to the scope, run `npm run enrich` for the new recipes. Then restart the MCP server.

### Units of the shopping list

The shopping list shows eggs as pieces with the grams, for example `яйца — 8 шт. (≈ 413 г)`.
The piece weights are 55 g for `яйца`, 20 g for `желток` and 35 g for `белок`.
A cereal or flour that has only a volume shows the grams, for example `гречка — ≈ 255 г`. The densities are in `src/planner/shopping.ts`.

### Copy the shopping list to Keep

Run this command to copy the shopping list as plain text to the clipboard:

```bash
npm run -s shopping:text -- 2026-10-17 | pbcopy
```

Replace `2026-10-17` with the first day of the plan week. The command reads `data/plans/2026-10-17.json`.

Paste the text into a Keep checklist note. Each line becomes one checkbox.

- `--with-optional` adds the optional items after the items to buy.
- `--help` shows all options.

If the plan file is missing, save the plan first with `save_plan`.

## Development

| Command | Action |
|---------|--------|
| `npm run typecheck` | Check the types with `tsc --noEmit`. |
| `npm test` | Run the tests with Vitest. |
| `npm run scrape -- <flags>` | Run the scraper. |
| `npm run parse -- <flags>` | Run the parser. |
| `npm run enrich -- <flags>` | Run the enrichment (`--dry-run` needs no key). |
| `npm run enrich:eval -- <flags>` | Score the enrichments of the gold recipes. |
| `npm run items:report -- <flags>` | Write `data/items-report.json`: the normalised ingredient names of the catalogue, to build `config/item-aliases.json`. |
| `npm run servings:report -- <flags>` | Write `data/servings-report.json`: the recipes with servings that look wrong. See "Servings check". |
| `npm run plan:check -- <plan.json> <flags>` | Check a week plan against the rules of the household, then print the shopping list in Markdown. Exit code 1 if the plan has errors. |
| `npm run shopping:text -- <weekStart> <flags>` | Print the shopping list of a saved plan as plain text, one line per item, for a Keep checklist. See "Copy the shopping list to Keep". |
| `npm run mcp` | Start the MCP server on stdio. See "MCP server". |
| `npm run fixtures:refresh` | Copy the test pages from `data/raw/` to `test/fixtures/real/`. |

Source layout:

```text
src/domain/    Effect Schemas: RecipeId, SitemapEntry, RawIndexEntry, RawIndex,
               ParsedRecipe, ParseError, ParseReport,
               EnrichedRecipe, EnrichReport, BatchState, GoldEntry, EvalReport
src/scraper/   sitemap.ts, robots.ts, charset.ts, plan.ts, outcome.ts   pure functions
               http.ts, pacer.ts, store.ts                              services (HTTP, delay, files)
               run.ts, cli-options.ts, layers.ts, cli.ts                 program and entry point
src/parser/    text.ts, servings.ts, durations.ts, dates.ts, dom.ts      pure functions
               extract.ts, parse.ts (parseRecipe), plan.ts, report.ts     pure functions
               store.ts                                                    service (files)
               run.ts, cli-options.ts, layers.ts, cli.ts                   program and entry point
               fixtures.ts, fixtures-cli.ts                                copy of the test pages
src/enrich/    scope.ts, input.ts, plan.ts, prompt.ts, json-schema.ts, decode.ts      pure functions
               request.ts, pricing.ts, dry-run.ts, report.ts, eval.ts                 pure functions
               api.ts (Llm), store.ts, env.ts                                         services (Anthropic API, files, .env)
               run.ts, layers.ts, cli-options.ts, cli.ts                              program and entry point
               eval-run.ts, eval-cli-options.ts, eval-cli.ts                          evaluation against the gold set
src/planner/   catalogue.ts (loadCatalogue), items.ts, search.ts, evaluate.ts (evaluatePlan), taste.ts, shopping.ts, shopping-render.ts   pure functions
               decimal.ts, labels.ts, plan-model.ts, report.ts, cli-options.ts                                                  pure functions
               config.ts, plans.ts, atomic.ts, layers.ts                                                                        services (config, saved plans, files)
               plan-cli.ts, items-cli.ts                                                                                        entry points
               menu-render.ts                                                                                                   pure function (menu in Markdown)
src/mcp/       tool.ts, tools.ts, prompt.ts, paths.ts, app.ts   tools, prompt and server
               server.ts                                        entry point (stdio)
config/        household.json (the household settings), item-aliases.json (item name -> canonical name), item-protein.json, simple-breakfasts.json
test/          unit tests, golden tests of the 34 real pages,
               and end-to-end tests against a local HTTP server and a temporary data directory.
               The enrichment tests use a fake API: a fake service, or a local server on 127.0.0.1. No test calls the real API.
```
