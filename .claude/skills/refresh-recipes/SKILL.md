---
name: refresh-recipes
description: Update the local say7.info recipe base of this project: download new and changed pages (npm run scrape), parse them, enrich the new recipes with the Anthropic API, then review the servings and item names of the new recipes. Use this skill whenever the user asks to update, refresh or sync the recipe base or the catalogue, «обнови базу», «обнови рецепты», «скачай новые рецепты», «перепарси», or says the menu planner misses new recipes from the site — even if they name only one of the steps.
---

# Refresh the recipe base

The base is updated by hand every 1–2 months. Every step is incremental: the scraper fetches only new pages and pages whose `lastmod` changed, the enrichment calls the API only for recipes without a current result. Talk to the user in Russian.

Rules that come from the site and the API (see `CLAUDE.md` and `docs/SPEC.md` D1–D4):
- Fetch say7.info only with `npm run scrape`. It obeys robots.txt and waits 2.5 s between requests. Do not use curl, WebFetch or a browser for the site.
- The enrichment costs money. Show the estimate and get a "yes" from the user before the real run.
- Never print `ANTHROPIC_API_KEY` or the contents of `.env`.

## Steps

1. **Before.** Note the current counts, so that you can report what changed: the number of files in `data/raw/`, `data/parsed/`, `data/enriched/` (without the `_*.json` files). Save the list of enriched IDs to a file in your scratchpad: steps 6 and 7 look only at the recipes that are not in this list.

2. **Scrape.** Run `npm run scrape` in the background (`run_in_background`); a full first run took 73 min, an update is usually a few minutes. If the process stops, run the same command again: it resumes. Report the totals that it prints (fetched, skipped, not found, errors). If there are errors, show the IDs; a second run often fixes network errors.

3. **Parse.** Run `npm run parse`. Read `data/parsed/_report.json`. Report the number of failures and new warnings. A failed page usually means that the HTML of the site changed: show the ID and the error, and do not try to fix the parser in this skill (that is a code task for a separate branch).

4. **Estimate the enrichment.** Run `npm run enrich -- --dry-run`. It prints the number of requests and the cost for each model. The default model is `claude-haiku-5-5` in batch mode. If there are 0 requests, skip to step 7. Show the user the number of new recipes and the Haiku batch cost, and ask whether to continue.

5. **Enrich.** After the "yes", run `npm run enrich` in the background. More than 20 requests use a batch, which can take up to an hour; if the process stops, the same command resumes from `data/enriched/_batch.json`. Then, if `_report.json` lists failures, run `npm run enrich -- --retry-failed` once. Report: succeeded, failed, the cost from `_report.json`.

6. **Servings of the new recipes.** Run `npm run servings:report`. Look only at the flagged `main`, `soup` and `salad` recipes that are new in this update (not in the list of step 1). For each, read `data/parsed/<id>.json` (ingredient lines, `yieldText`) and `data/enriched/<id>.json` (`servings`, grams). Propose an override for clear errors only: a count of pieces instead of portions, a soup pot of 4–5 l with 4–6 portions, a portion mass under about 80 g or over about 900 g for a main dish. Show the proposals (id, title, old → new, 1-line reason); write the approved ones into `config/servings-overrides.json` (keys sorted numerically).

7. **Item names.** Run `npm run items:report`. Find the new item names of the new recipes that are only another spelling of an existing item (word order, singular or plural, typos, for example `перец черный` and `черный перец`). Do not merge different products (see the earlier decisions in `docs/SPEC.md` P4.2.5: yolks are not eggs, `сметана` is not `сливки`). Show the proposals; write the approved ones into `config/item-aliases.json` (sorted by canonical name, then variant). A variant must not be a canonical name of another alias.

8. **Check.** Run `npm run typecheck` and `npm test`. The test of `config/item-aliases.json` checks for clean names and chains.

9. **Commit.** If step 6 or 7 changed `config/`, create a branch `refresh-<date>`, commit only the config files (never `data/`; recipe content stays out of git), merge into `master` with a fast-forward, and record the update in `docs/SPEC.md` P3.5 (date, new recipes, cost) in the same commit.

10. **Restart.** The `say7` MCP server loads the catalogue at start. Tell the user to run `/restart` (or reconnect the server in `/mcp`) so that the menu planner sees the new recipes.

## Final report to the user

In Russian, short: new and changed pages, parse failures, enriched recipes and the cost in USD, the overrides and aliases that were added, and the reminder to restart.
