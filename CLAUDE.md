# Rules for coding agents

1. Read `docs/SPEC.md` before you start. Implement only the phase in your task.
2. Do not edit `docs/SPEC.md`. If the spec is wrong, unclear or conflicts with these rules, do not guess. Write the question in your final report and choose the most conservative option.
3. This environment cannot reach say7.info. Do not try to bypass the proxy. Use local fixtures.
4. Do not invent the HTML structure of say7.info. Selectors come only from real page files that the coordinator supplies.
5. Do not write Effect or library APIs from memory. Effect 4 differs from Effect 3. Before you use an API, find it in the installed type definitions (`node_modules/<pkg>/dist/**/*.d.ts`) or in the package source. Typecheck often.
6. TypeScript strict. Do not use `any`. Do not use `as` casts, except `as const`. Decode all external data with Effect Schema.
7. Errors are tagged errors. Domain code does not throw.
8. Keep decisions in pure functions (what to fetch, how to parse). Keep effects at the edges.
9. Do not add native addons that compile at install time. The code runs on macOS; development is on Linux.
10. Pin exact dependency versions in `package.json`. Commit `package-lock.json`.
11. Before you finish, run `npm run typecheck` and `npm test`. Both must pass.
12. Do not put fetched recipe content into git. `data/` and `test/fixtures/real/` are git-ignored. Committed tests contain only short facts from pages (titles, counts, up to 5 ingredient lines per recipe). No intro or step texts.
13. Do not run `git commit`, `git push` or commands that rewrite history. The coordinator commits.
14. Final report: files changed, commands run and their results, open questions, known limitations. Keep it short.
