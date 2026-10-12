# Gold set for the enrichment evaluation

The file `gold.json` has 20 recipes with expected facts. P3.5 in `docs/SPEC.md` uses it to score the enrichment output.
A person checked each page by hand. The file has only short facts: titles, numbers and 3 ingredient lines for each recipe.
Each entry has the keys `id`, `title`, `dishType`, `mealFit`, `proteinFamilies`, `vegetarian`, `heat`, `servings`, `activeMinutes`, `longWait`, `keyLines` and `note`.
The enum values come from P3.4. `dishType` and `mealFit` list 1 or 2 accepted values. `proteinFamilies` is the exact expected set.
`heat`, `servings` and `activeMinutes` have `min` and `max`. The evaluation adds `servings.tolerance` portions to both ends of the servings range.
`tolerance` is 0 when the page states the portions. It is 1 or 2 when the page has no servings and the value is an estimate.
`longWait` is `true` when the recipe needs a wait of 6 hours or more.
Each `keyLines` item has `raw`, `item`, `category` and `pantry`. `raw` is the exact line from the parsed `ingredientGroups` and is unique in its recipe. `item` and `category` list accepted values.

Coverage of the P3.5 rules:

- Hot or spicy (heat up to 2): 1635, 1653, 1701. No page in the set is hot (3).
- Soups: 246, 1688. Salads: 61, 1434. Fish or seafood: 38, 1171, 1321, 1623, 1731. Vegetarian: 61, 1601, 1688, 1701.
- No servings on the page: 246, 935, 1679, 1688. Needs a side: 38, 1057, 1171, 1429, 1623, 1679 (and others, see `mealFit`).
- Long wait: 1688 (bean soak, 6–8 h). Long marinade or chill, below 6 h: 38, 1587, 1731.
- Savory bake or pancake: none. No fixture page has category 48 or 50. The desserts 401 and 1590 are not in the set.
