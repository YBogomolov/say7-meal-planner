---
name: weekly-menu
description: Plan the household's weekly lunch and dinner menu from say7.info recipes with the say7 MCP server (search_recipes, evaluate_plan, shopping_list, save_plan), following the family's food preferences, and produce the menu table, the cooking-session schedule and the shopping list. Use this skill whenever the user asks for a menu, a meal plan, «меню на неделю», «составь меню», «что готовим на неделе», «план питания», a shopping list for the week, or wants to change or redo a planned week — even if they do not mention say7 or the MCP server.
---

# Weekly menu

Plan 1 week of lunches and dinners for the household with the tools of the `say7` MCP server. The code checks the rules and counts; you choose the dishes and explain the choice. The user speaks Russian: talk to them in Russian.

## Before you start

1. Read `references/preferences.md`. It holds the family's taste rules that the code does not check yet. They matter as much as the errors of `evaluate_plan`: the first menu of this household passed every code rule and the user still rejected it twice for taste reasons.
2. Find the week. Day 0 is the shopping day and the day of session A. Default: the next Saturday after today. If the user names a date, use it as day 0, also when it is not a Saturday, and name its weekday in the answer.
3. Call `household`, `plan_history` and `simple_breakfasts`. Lunch and dinner are for 3 persons, breakfast for 2 (`mealPersons`): the third person makes her own simple breakfast and is not in the plan. Session A covers days 0–3, session B covers days 4–6. Put the dishes of the last plans in `excludeIds`, and prefer a protein family that the last plans used little.

If the `say7` tools are not available, tell the user that the MCP server is not connected (`claude mcp list`) and stop.

## Build the menu

Think of the week as 5 groups of slots, and choose dishes for each:

| Group      | Slots              | Portions     |
| ---------- | ------------------ | ------------ |
| A lunches  | days 0–3 lunch     | 12           |
| A dinners  | days 0–3 dinner    | 12           |
| B lunches  | days 4–6 lunch     | 9            |
| B dinners  | days 4–6 dinner    | 9            |
| Breakfasts | days 0–6 breakfast | 14 (2 a day) |

Every meal needs protein: `low_protein` warns below 15 g at breakfast and 20 g at lunch and dinner per portion (`proteinPerPortion` in the search rows; the slot sums its dishes). Treat it like the taste warnings: fix it, for example with a protein side or a richer dish.

Lunches are the main, filling meal. Dinners are light (see the preferences). This split is the main reason to search lunches and dinners separately: a dish that is fine for lunch can be wrong for dinner.

Choose the protein first: 1 family for the lunches (meat or poultry), and fish or vegetarian dishes for the dinners. Then the week has at most 2 families, the code limit.

How to search:

- In every search, set `requiresOnly` to the `equipment` list of `household` and `maxHeat: 1`.
- Lunches: `dishTypes: ["main"]`, `mealFits: ["full_meal"]` or a `needs_side` dish plus a side recipe. A lunch is a real piece of meat or poultry with a side dish. Sausages and other processed meat are a weak lunch: use them at most once, never as the only lunch of a session.
- Dinners: fish (`proteinFamilies: ["fish"]`), `vegetarian: true` with `dishTypes: ["main", "savory_bake", "pancakes"]`. Vary the kind of dinner: at most 1 pie or quiche per session, and mix it with a fish dish, a cottage cheese dish, an omelette or filled pancakes. Pies are tempting because they give many portions, but 3 pies in a week are both monotonous and heavy (dough and butter). A dinner has no pasta, couscous, bulgur or rice. Potato at dinner is allowed (for example fish baked with potato); vegetables are also a good side for fish. Fish dinners every week are fine.
- Light dinners: simple entries of `simple_breakfasts` that have `dinner` in `meals` (cottage cheese with sour cream, sandwiches) go into `simpleIds` of a dinner slot. Recipes with `lightDinner: true` (cottage cheese casseroles that last 3–4 days; search with `forMeal: "dinner"`) are good light dinners too, and are allowed in dinner slots even when `mealFit` is `not_a_meal`. Use them on busy days. One casserole can cover 3–4 dinners.
- `proteinFamilies` of a recipe can list several families (mixed mince is `["pork", "beef"]`). Use only dishes whose families are all inside the 1–2 families of the week.
- Read `buyItems` of each candidate: it is the fastest way to see rice, mayonnaise, cream or a repeated side dish. For a dinner with `сметана`, `сливки` or `сыр` in `buyItems`, call `get_recipe` and look at the amounts: a filling with cream and a lot of cheese is not light.
- "A side dish does not repeat" means the starchy or vegetable base of the plate: potato in any form counts as potato, any pasta counts as pasta.
- If no recipe matches a wish exactly (for example «курица с грибами и гречкой»), put 2 recipes in 1 slot: a `needs_side` main and a side recipe (`recipeIds: [main, side]`). Tell the user that you did this.

Breakfasts:

- Mix 3 kinds over the week. Use a varied pattern, for example 2–3 simple breakfasts, 2 days of a session dish, 2 fresh mornings.
  - Simple breakfasts from `simple_breakfasts` go into `simpleIds` of the slot (no cooking entry). They are quick and give enough protein.
  - Session dishes (`session` "A" or "B"): сырники, запеканки, filled pancakes. They are reheated in the morning, so they must reheat well (`reheats`) and stay fresh (`fridgeDays`).
  - Fresh dishes (`session: "fresh"`): omelettes, eggs, quick pancakes, cooked in the morning of each day they are eaten; `scale` is per morning (2 portions). The active time of 1 morning must stay within `freshMinutesMax` (20 min, rule `fresh_time`).
- Search with `forMeal: "breakfast"`. Some breakfast recipes are `not_a_meal` (sweet pancakes): they are allowed only at breakfast, unless the recipe has `lightDinner: true` (then also at dinner). A simple entry is allowed only in the meals of its `meals` (else `simple_meal_not_allowed`).
- Do not repeat the same breakfast on more than 2 days. Sweet breakfasts (pancakes with jam) need a protein part in the same slot (a simple breakfast with cottage cheese or yogurt, or eggs).

Rules of thumb that the code does not state:

- Fewer dishes is the right size: the household prefers about 4 cooked dishes a week, and each dish covers 3–4 days. In session A one lunch dish covers days 0–3 and one dinner dish covers 3 days (day 0 dinner can be a simple entry). In session B one lunch dish and one dinner dish cover days 4–6. Repetition is fine for the household. Prefer a `full_meal` dish to a main plus a separate side recipe. Make the two lunch dishes different (for example, not two mince casseroles).
- Each dish is eaten on at most `maxDaysPerDish` days (4), and the last day must be within its `fridgeDays` from the cooking day. Scale the dish so that it gives enough portions.
- The shopping list tells you which products to freeze on the shopping day for session B (raw fish and meat, also sausages). Repeat these actions in the answer.
- At most 2 protein families. Chicken for lunches and fish for dinners is an accepted pair.
- Keep active minutes per session under 150.

## Check and fix

1. Call `evaluate_plan`. Fix every error.
2. Fix `portions_tight` by a higher `scale` (0.5 steps) until the lower end of "made" is at least "eaten". Leftovers of 1–3 portions are fine; too little food is worse than too much.
3. Accept `long_wait` of less than 1 h and `protein_families` with 2 families, but mention them. For a longer wait (a marinade of several hours), replace the dish unless the user asked for it: the cooking day is already full.
4. Part of the preferences is now in the code (`household.preferences`): `dish_type_excluded` (a soup, an error), `side_repeated` (the same side dish in 2 dishes), `heavy_dinner` (a starchy side, mayonnaise or cream at dinner), `item_limit` (more than 1 dish with rice or sausages). Treat these 4 warnings like errors: fix them, or explain to the user why you keep one. Then check the rest of `references/preferences.md` yourself (variety of dinners, pies, real meat at lunch): the code does not see it.
5. A lower `buyItemCount` is good only when the menu still has variety. Do not trade taste for 2–3 fewer items.
6. Call `shopping_list` and read it for odd amounts. Translate them into what the user buys:
   - eggs and yolks in grams: about 55 g per egg, 20 g per yolk; give 1 total number of eggs;
   - cereals in ml: about 0.85 g per ml for buckwheat and rice, 0.65 g per ml for semolina;
   - canned fish: a can is about 185–250 g;
   - whole vegetables scaled by weight (for example 5 kg of pumpkin): say how many pieces that is, and offer an alternative if it is awkward;
   - items without an amount: say so.

## Show the draft, then save

Do not call `save_plan` before the user approves. Show the draft in Russian:

1. One line: status of `evaluate_plan`, protein families, `buyItemCount`.
2. A table: day (weekday and date) × breakfast, lunch, dinner. The first time a dish appears, write it as a link `[title](url)`; on later days, use a short name.
3. The sessions: for each dish the scale, portions made vs. eaten. Active minutes per session. Then the fresh breakfasts («утром»): dish, days, minutes per morning.
4. The shopping list, grouped (vegetables, meat and fish, dairy, other), with the freezing action and "проверить дома". Add the section «Каждую неделю» (`extras` of `shopping_list`: the breakfast products of the third person).
5. «Что смущает»: 1–3 honest doubts (odd amounts, seasonal products, items that are hard to buy in Varna) with a concrete alternative.
6. A question: approve or change.

When the user asks for changes, change only what they asked for, run `evaluate_plan` again and show the new draft the same way.

When the user approves: call `save_plan` and give the path `data/plans/<weekStart>.md`. Then copy the shopping list for Google Keep: run `npm run -s shopping:text -- <weekStart> | pbcopy` and tell the user to paste it into a Keep checklist note (each line becomes 1 checkbox). Remind them of the freezing actions, which are not in the Keep text. Then ask whether new wishes from this conversation should go into `references/preferences.md`. If yes, add them there in the same style (the rule, then why).

## Limits

- Show titles, links and facts only. Do not copy intros or steps of recipes (the site forbids republication).
- Do not invent recipes or IDs. Every dish comes from `search_recipes` or `get_recipe`.
