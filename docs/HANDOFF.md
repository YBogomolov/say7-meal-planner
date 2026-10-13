# Handoff: remaining implementation plan

Date: 2026-10-12. From: the coordinator session (cloud sandbox). To: a Claude Code session on the user's Mac, in `/Users/yuriy/Projects/TypeScript/recipes`.

## 1. Read first

1. `docs/SPEC.md` — requirements (H1–H9, D1–D7, T1–T6), architecture, phase specs P1–P5. The spec is the source of truth. This file only adds state, decisions and the task order.
2. `CLAUDE.md` — rules for coding agents.
3. `README.md` — commands.

## 2. State

| Phase | Status | Evidence |
|-------|--------|----------|
| P1 scraper | Done | Full run on the Mac: 1578 pages, all `ok`, about 73 min. `data/raw/`. |
| P2 parser | Done | Full cache: 1578 of 1578 parse, 0 failures. Warnings: no servings 524 (mostly sweet bakes in pieces), no durations 202. |
| P3 enrichment | Done | Full run 2026-10-13 (T1): 1076 of 1076 valid, 0.255 USD. Gold set 99.4 %. SPEC P3.5.6. |
| P4 plan rules | Done (T3 aliases 2026-10-13: 369 non-pantry items) | 18 rule codes, shopping list, `plan:check`, `items:report`. Tested on a synthetic catalogue only. |
| P5 MCP server | Done | T4 2026-10-13: 7 tools, prompt `plan_week`, `.mcp.json`; `claude mcp list` shows `say7` connected. |
| P6 first menu | Done, feedback open | Week 2026-10-17 approved. Baseline and feedback: SPEC P6. Rules from the feedback: T5.3 open. |

Tests: 57 files, 1218 tests, all pass on macOS (2026-10-13).

## 3. Environment change

The previous work ran in a cloud sandbox. Now the work runs on the Mac. This changes some facts:

| Before (sandbox) | Now (Mac) |
|------------------|-----------|
| say7.info was blocked. | say7.info is reachable. Obey D1–D4 (robots.txt, 1 request every 2.5 s). Use `npm run scrape`; do not fetch pages by other means. |
| No API key. | `ANTHROPIC_API_KEY` is in the shell or in `.env`. Never print it. Never commit `.env`. |
| Code was delivered as git bundles in `.sync/`. | Not necessary. Work in the repo directly. The user can delete `.sync/`. |
| Real data was copied into the sandbox. | Real data is in `data/` (git-ignored). Keep it out of git (D6). |

## 4. Decisions on record

| ID | Decision | Reason |
|----|----------|--------|
| R1 | Default enrichment model: `claude-haiku-5-5`, batch mode. | Gold set: 338/340 (Haiku) vs 339/340 (Sonnet). Pilot cost: 0.013 USD vs 0.25 USD (×19). Full run estimate with Haiku in batch mode: 0.4–0.6 USD. |
| R2 | No database. The catalogue is loaded into memory. | About 1100 recipes, a few MB. FTS5 without Russian stemming gives no benefit. |
| R3 | The LLM selects dishes. Code checks rules and makes the shopping list. | The LLM is not reliable with counts and sums. |
| R4 | Menus show titles, links and own notes only. | The site forbids re-publication (D6). |

Pilot failures (for T2 and T3):

- Haiku, 1688 (bean soup): servings 4–6, expected 6–14.
- Haiku, 1057: item `перец черный`, gold expects `черный перец` or `перец черный горошком`. This is a naming variant (alias map, T3).
- Sonnet, 935 (pelmeni): servings 25–30, expected 3–10. The model counted pieces.

Conclusion: `servings` is the weakest field for both models (95 %). The plan rules depend on it (`portions_*`). T2 adds a check.

## 5. Remaining tasks

Do the tasks in this order. Use 1 git branch per task. Before each merge, `npm run typecheck` and `npm test` must pass.

### T0. Housekeeping (15 min)

1. Run `npm ci`, `npm run typecheck` and `npm test` on macOS. All tests must pass.
2. Make `claude-haiku-5-5` the default of `--model` (SPEC A6, decision R1). Keep the flag.
3. Gold set, recipe 1057: add `перец черный` to the accepted `item` values.
4. Commit.

Acceptance: `npm run enrich -- --dry-run` prints "no problem" without `--model`.

### T1. Full enrichment (about 1 h, mostly waiting)

1. Run `npm run enrich -- --dry-run`.
2. Run `npm run enrich`. Batch mode starts. If the process stops, run the same command again: it resumes from `data/enriched/_batch.json`.
3. Run `npm run enrich -- --retry-failed`.
4. Read `data/enriched/_report.json`.

Acceptance (SPEC P3.5.5): ≥ 98 % of the 1076 in-scope recipes have a valid enrichment. Record the totals and the cost in SPEC.md.

### T2. Servings check (new, small)

Problem: wrong `servings` gives wrong `portions_*` findings, and the household gets too little or too much food.

1. Add a pure function `servingsAudit(catalogue)` and a CLI `npm run servings:report` that writes `data/servings-report.json`. Flag a recipe if:
   - `servings.source` is `estimated`, or
   - `servings.max` > 12, or `servings.max` > 3 × `servings.min`, or
   - the portion mass is outside 150–700 g. Portion mass = sum of `grams` of non-optional ingredients ÷ `servings.max`. Skip this check if less than 70 % of the lines have grams.
2. Add `config/servings-overrides.json` (`{ "<id>": { "min": n, "max": n } }`, committed). `loadCatalogue` applies it after decoding. An override wins over the enrichment.
3. Review the flagged recipes with `dishType` `main`, `soup` or `salad`. Write overrides for clear errors. Start with 935 and 1688.
4. Tests: each flag rule, the override merge.

Acceptance: report exists; every flagged main dish is reviewed; overrides committed.

### T3. Item aliases (small, needs judgement)

Problem: the main objective `buyItemCount` counts distinct normalised items. Two names for 1 product make the count wrong.

1. Run `npm run items:report`.
2. For non-pantry items, find groups that are 1 product to buy (for example `лук`, `лук репчатый`; `черный перец`, `перец черный`). Do not merge different products (`сливки 20%` and `сливки 33%` are 1 item with `detail`; `сметана` and `сливки` are 2 items).
3. Write `config/item-aliases.json`. A subagent can propose groups; a human (the user) approves the list.

Acceptance: the 200 most frequent non-pantry items are reviewed. The alias map is committed. The number of distinct non-pantry items after aliases is recorded in SPEC.md.

### T4. P5 MCP server

Implement SPEC.md P5. Details that the spec does not state:

1. SDK: `@modelcontextprotocol/sdk`, latest stable, exact pin. Verify the API in `node_modules`. Entry `src/mcp/server.ts`, script `npm run mcp`.
2. Tool input schemas come from Effect Schema (find the JSON Schema function of Effect 4.0.3 in `node_modules`). Decode each input with the same Schema. Prefer the low-level request handlers if the high-level API needs zod.
3. Tools: `search_recipes`, `get_recipe`, `evaluate_plan`, `shopping_list` (JSON + Markdown), `save_plan`, `plan_history` (default 4), `household`. Errors: `isError: true`, message in Russian.
4. `save_plan` writes `data/plans/<weekStart>.json` and `data/plans/<weekStart>.md`. The Markdown file: a table days × meals with dates and dishes as links `[title](url)`, a section per cooking session (dishes, scale, active minutes), the evaluation summary, the shopping list. Put the renderer in `src/planner/menu-render.ts` (pure, golden test).
5. Prompt `plan_week` (arguments `weekStart`, optional `proteinFamily`). Method: read `household` and `plan_history`; choose 1 protein family (2 at most) that the last plans did not use much; search 2–3 dishes per session (session A covers days 0–3, session B days 4–6; 3 persons × 2 meals); check `fridgeDays`, `freezable`, `reheats`, servings; build the WeekPlan; call `evaluate_plan`; fix all errors; lower `buyItemCount` with dishes that share items; then `shopping_list` and `save_plan`. The answer to the user is in Russian and shows titles, links, the session schedule and the shopping list. It does not copy recipe texts.
6. Paths: resolve the project root from the server file, not from the working directory. Optional overrides `SAY7_DATA_DIR`, `SAY7_CONFIG_DIR`. Log to stderr only. If the catalogue is empty, start anyway and return a hint in search results.
7. Tests: e2e with the SDK client over stdio against a synthetic data directory (invented recipes, CLAUDE.md rule 12); unit tests for input decoding and the menu renderer.
8. Registration (Claude Code docs, checked 2026-10-12): `claude mcp add [options] <name> -- <command> [args...]`; `--scope project` writes `.mcp.json`; an entry without `type` is a stdio server; Claude Code asks for approval of project servers. Recommended `.mcp.json`:
   ```json
   { "mcpServers": { "say7": { "command": "npx", "args": ["tsx", "src/mcp/server.ts"] } } }
   ```
   Verify that Claude Code starts it with the project root as the working directory (`claude mcp list` shows it connected). If not, use absolute paths. For Claude Desktop, document `claude_desktop_config.json` with the absolute path of `node` (`command -v node`), the tsx CLI file in `node_modules/tsx` (see its `package.json` `bin`) and `src/mcp/server.ts`.

Acceptance: e2e test passes; `claude mcp list` shows `say7` connected; a manual `search_recipes` call returns real recipes.

### T5. P6 first weekly menu

1. In Claude Code (or Claude Desktop), use the prompt `plan_week` with `weekStart` = the next Saturday.
2. Acceptance: `evaluate_plan` returns `ok: true`; protein families ≤ 2; every slot is covered; `data/plans/<weekStart>.md` exists; the user approves the menu. Record `buyItemCount` and the active minutes per session in SPEC.md as the baseline.
3. Collect the user's feedback on the menu: wrong dishes, too much or too little food, items that are hard to buy in Varna. Convert each point into a rule, an override or an alias.

### T6. Later (optional, after T5 feedback)

1. `suggest_plans` tool: a deterministic search that returns the 5 plans with the lowest `buyItemCount` for a protein family (beam search over 30–50 candidates per family; the rules of P4.4 as constraints). The LLM then chooses and explains.
2. Feedback: a rating per dish in saved plans (`liked`, `ok`, `disliked`). Search sorts liked dishes higher and hides disliked ones.
3. Monthly refresh: `npm run scrape && npm run parse && npm run enrich` (all incremental). A launchd job is possible; ask the user first.

## 6. Invariants and pitfalls

1. Effect 4.0.3 differs from Effect 3 (`Result` instead of `Either`, `Effect.catch`, `Context.Service`). Check the `.d.ts` files before using an API.
2. TypeScript 7.0.2 (native compiler) is in use. It works with Effect 4 and Vitest 5.
3. API JSON Schema rules (SPEC A4): `additionalProperties: false` everywhere, no numeric or length limits, no recursion, and no `enum` or `const` together with a type array (HTTP 400). `checkApiSchema` and `--dry-run` check this.
4. Thinking (SPEC A12): Haiku 5.5 `disabled`; Sonnet 5.5 rejects `disabled` and uses `between_tools`.
5. `node_modules` is platform-specific (esbuild, TypeScript native). Do not copy it between machines.
6. Recipe texts never go into git, tests or menus. Only short facts (titles, counts, up to 5 ingredient lines per recipe in tests).
7. Old bundles in `.sync/` contain the full history up to `60d775b` only. Ignore them.
