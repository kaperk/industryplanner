# RealIndustry Production Planner

This is a research/building/item planner for the game [RealIndustry](https://realindustrygame.com/). Throw in your research, buildings, and what you want to make. The planner generates a production plan with recipes, number of runs, and necessary research.

No server necessary. Just load `index.html` in a browser.

Assuming I can even copyright this (and that is still a debate), this is released
under the [Zero-Clause BSD license](LICENSE). Do what you want with it.

This is 95% AI generated. My only contribution was the `data.js` for the recipes (which admittedly was also very AI-assisted), buildings, and tech tree. And I guess the overall direction, features, testing, etc.  

The rest of this README and all other content within, except for the data.js recipe file, are generated from Claude. I've tried to tease out obvious buggy scenarios (self-looping catalyst recipes, infinite power), but I can guarantee there are plenty more. I don't plan on maintaining this. 

~

# RealIndustry Planner

Finds the most efficient way to make items, buildings or research, limited to the research you've completed and the buildings you've built.

## Use

Open `index.html` in a browser (double-click works, no server needed).

1. **Research tab**: tick what you've researched. Ticking one also ticks its prerequisites.
2. **Buildings tab**: tick what you've built, or turn on *Treat every unlocked building as built*.
3. Search for a target (item, building construction cost, or research cost), set a quantity and add it. You can add several targets.
4. Choose what to optimise for: fewest crafting runs, least raw material by item value, or least raw material by unit count.

**Unlimited tab**: tick items you have plenty of (water, electricity, wood, coal…), or use a preset. The planner treats them as always on hand and never plans recipes to make them. The plan still shows how much of each it uses, marked ∞. You can also toggle this from any item's details.

Steps are listed so each one only uses things made in earlier steps. Some chains are genuine loops (mining magnetite needs iron tools, which are made from magnetite). The step that has to start such a loop is tagged *loops back*, meaning you need some of that item on hand to begin. Marking that item unlimited removes the loop.

Progress is saved in the browser automatically. *Export progress* / *Import* copy it as JSON. Click any item to see every recipe that makes it and what's blocking the locked ones.

If a target can't be made yet, the planner finds the lowest tech level that makes it possible and lists the research (in order) and buildings you need, with the locked steps highlighted.

## How it works

- Every recipe, and each fuel option for it, is a variable in a linear program that minimises the chosen cost while net production meets the targets. Byproducts and loops are handled.
- Tool wear counts as a fraction of a tool per run: the recipe's `toolDurability` divided by the tool's `durability`.
- At first, catalysts (inputs handed back, such as a pump or 1000 solar modules) count as  consumed every run. Each catalyst recipe is then tried with its stock built once and reused, and kept only if that makes the plan cheaper.
- Runs are whole numbers, which the plain ignores: on its own, it would cover 10 missing electricity with 0.0006 of a fusion run, which in practice means a full run plus its whole deuterium supply chain. So the plan is refined in whole runs:
  - it is re-solved with each recipe priced at what its whole runs really cost;
  - a top-down plan that picks each producer by whole-run cost is compared;
  - recipe sets that are optimal for larger batches are tried at the real quantity;
  - a local search bans one recipe of the best plan at a time and keeps the best improvement.
- That search is time-boxed to about 1.5 seconds per plan. A valid whole-run plan always comes first, so a long search only means less polish, never a missing plan. Small quantities can occasionally differ a little from the true optimum.