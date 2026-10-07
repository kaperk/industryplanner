// RealIndustry production planner core: data model, unlock logic and LP-based optimiser.
// Exposed in the browser as window.RIPlanner.
(function (global) {
  "use strict";

  const EPS = 1e-9;
  // Planning effort is time-boxed: a valid whole-run plan always comes first, and the
  // improvement searches stop once this deadline passes.
  let deadline = Infinity;
  const timeUp = () => Date.now() > deadline;
  const USED = 1e-7; // runs below this are treated as zero

  // ---------------------------------------------------------------------------
  // Linear program:  minimise c·x  subject to  A x >= b,  x >= 0
  //
  // Solved through its dual (maximise b·y s.t. Aᵀy <= c, y >= 0). Every recipe
  // cost c is positive, so the all-slack basis of the dual is feasible and no
  // phase-one is needed. The primal x is read from the slack reduced costs.
  // A is given column-wise: cols[j] = Map(row -> coefficient).
  // ---------------------------------------------------------------------------
  function solveLP(m, cols, c, b) {
    const n = cols.length;
    // Scale every column and row to max |coef| = 1 to keep pivots well-conditioned.
    const colScale = new Float64Array(n);
    const rowScale = new Float64Array(m).fill(0);
    for (let j = 0; j < n; j++) {
      let mx = 0;
      for (const v of cols[j].values()) mx = Math.max(mx, Math.abs(v));
      colScale[j] = mx || 1;
      for (const [i, v] of cols[j]) rowScale[i] = Math.max(rowScale[i], Math.abs(v / colScale[j]));
    }
    for (let i = 0; i < m; i++) if (!rowScale[i]) rowScale[i] = 1;

    const W = m + n + 1; // y columns, slack columns, rhs
    const T = new Array(n);
    for (let j = 0; j < n; j++) {
      const row = new Float64Array(W);
      for (const [i, v] of cols[j]) row[i] = v / colScale[j] / rowScale[i];
      row[m + j] = 1;
      row[W - 1] = c[j] / colScale[j];
      T[j] = row;
    }
    const obj = new Float64Array(W);
    for (let i = 0; i < m; i++) obj[i] = -(b[i] || 0) / rowScale[i];
    const basis = new Int32Array(n);
    for (let j = 0; j < n; j++) basis[j] = m + j;

    const nz = new Int32Array(W);
    let degenerate = 0;
    const maxIter = 50 * (m + n) + 1000;
    for (let iter = 0; iter < maxIter; iter++) {
      const bland = degenerate > 50;
      let e = -1;
      let best = -EPS;
      for (let k = 0; k < W - 1; k++) {
        if (obj[k] < best) {
          e = k;
          if (bland) break;
          best = obj[k];
        }
      }
      if (e < 0) {
        const x = new Float64Array(n);
        for (let j = 0; j < n; j++) x[j] = Math.max(0, obj[m + j]) / colScale[j];
        return { status: "optimal", x };
      }
      let r = -1;
      let ratio = Infinity;
      for (let j = 0; j < n; j++) {
        const a = T[j][e];
        if (a > EPS) {
          const q = T[j][W - 1] / a;
          if (q < ratio - EPS || (Math.abs(q - ratio) <= EPS && basis[j] < basis[r])) {
            ratio = q;
            r = j;
          }
        }
      }
      if (r < 0) return { status: "infeasible" }; // dual unbounded
      degenerate = ratio < EPS ? degenerate + 1 : 0;

      const pr = T[r];
      const pv = pr[e];
      // The pivot row is mostly zeros: only update the columns where it has entries.
      let nnz = 0;
      for (let k = 0; k < W; k++) {
        if (pr[k] !== 0) {
          pr[k] /= pv;
          nz[nnz++] = k;
        }
      }
      for (let j = 0; j < n; j++) {
        if (j === r) continue;
        const row = T[j];
        const f = row[e];
        if (f !== 0) {
          for (let t = 0; t < nnz; t++) {
            const k = nz[t];
            const val = row[k] - f * pr[k];
            row[k] = Math.abs(val) < 1e-13 ? 0 : val;
          }
        }
      }
      const f = obj[e];
      for (let t = 0; t < nnz; t++) obj[nz[t]] -= f * pr[nz[t]];
      basis[r] = e;
    }
    return { status: "iteration-limit" };
  }

  // ---------------------------------------------------------------------------
  // Model
  // ---------------------------------------------------------------------------
  function createModel(data) {
    const items = new Map(data.items.map((i) => [i.id, i]));
    const recipes = new Map(data.recipes.map((r) => [r.id, r]));
    const tech = new Map(data.tech.map((t) => [t.id, t]));
    const buildings = new Map(data.buildings.map((b) => [b.id, b]));
    const costs = data.buildingCosts || {};

    const recipeUnlockers = new Map(); // recipeId -> [techId]
    const buildingUnlocker = new Map(); // buildingId -> techId
    const addUnlock = (rid, tid) => {
      const list = recipeUnlockers.get(rid) || [];
      if (!list.includes(tid)) list.push(tid);
      recipeUnlockers.set(rid, list);
    };
    for (const t of data.tech) {
      for (const rid of t.unlocksRecipes || []) addUnlock(rid, t.id);
      for (const bid of [].concat(t.unlockBuilding || [])) buildingUnlocker.set(bid, t.id);
    }
    for (const r of data.recipes) if (r.unlockWithResearch) addUnlock(r.id, r.unlockWithResearch);

    const dependents = new Map(); // techId -> [techIds that require it]
    for (const t of data.tech) {
      for (const p of t.requiredResearch || []) {
        if (!dependents.has(p)) dependents.set(p, []);
        dependents.get(p).push(t.id);
      }
    }

    // Buildings with neither a construction cost nor an unlocking research are always present.
    const baseBuildings = new Set(
      data.buildings.filter((b) => !costs[b.id] && !buildingUnlocker.has(b.id)).map((b) => b.id)
    );

    // One variant per (recipe, fuel option). Tools are consumed fractionally:
    // toolDurability per run divided by the tool's total durability.
    const variants = [];
    for (const r of data.recipes) {
      const fuels = r.fuelOptions && r.fuelOptions.length
        ? r.fuelOptions
        : r.fuelRequired
          ? [{ id: r.fuelRequired, amount: r.fuelAmount || 0 }]
          : [null];
      for (const fuel of fuels) {
        const consumed = new Map(); // gross inputs incl. fuel and tool wear
        const add = (id, amt) => amt > 0 && consumed.set(id, (consumed.get(id) || 0) + amt);
        for (const [id, amt] of Object.entries(r.inputs || {})) add(id, amt);
        if (fuel) add(fuel.id, fuel.amount);
        let tool = null;
        if (r.toolRequired) {
          const dur = (items.get(r.toolRequired) || {}).durability || 1;
          tool = { id: r.toolRequired, amount: (r.toolDurability || dur) / dur, durability: r.toolDurability };
          add(tool.id, tool.amount);
        }
        const produced = new Map(Object.entries(r.outputs || {}).filter(([, a]) => a > 0));
        const net = new Map();
        for (const [id, a] of produced) net.set(id, a);
        for (const [id, a] of consumed) net.set(id, (net.get(id) || 0) - a);
        for (const [id, a] of net) if (Math.abs(a) < 1e-12) net.delete(id);
        // Catalysts: items both consumed and returned. Only the net change flows through the
        // plan, but the returned amount must be on hand once before the first run.
        const catalysts = new Map();
        for (const [id, a] of Object.entries(r.inputs || {})) {
          if (produced.has(id)) catalysts.set(id, Math.min(a, produced.get(id)));
        }
        const pessimisticNet = new Map(net);
        for (const [id, q] of catalysts) {
          const a = (pessimisticNet.get(id) || 0) - q;
          if (Math.abs(a) < 1e-12) pessimisticNet.delete(id);
          else pessimisticNet.set(id, a);
        }
        variants.push({
          key: fuel && (r.fuelOptions || []).length > 1 ? `${r.id}::${fuel.id}` : r.id,
          recipe: r,
          fuel,
          tool,
          consumed,
          produced,
          net,
          pessimisticNet,
          catalysts,
          rawOut: produced, // extraction outputs that count as raw-material cost
          extraction: Object.keys(r.inputs || {}).length === 0,
        });
      }
    }
    const producersOf = new Map();
    for (const v of variants) {
      for (const [id, a] of v.net) {
        if (a > 0) {
          if (!producersOf.has(id)) producersOf.set(id, []);
          producersOf.get(id).push(v);
        }
      }
    }

    return {
      data, items, recipes, tech, buildings, costs, recipeUnlockers, buildingUnlocker,
      dependents, baseBuildings, variants, producersOf,
    };
  }

  // ---------------------------------------------------------------------------
  // Unlock state helpers. state = { research: Set, buildings: Set }
  // ---------------------------------------------------------------------------
  function isRecipeUnlocked(model, recipeId, state) {
    const u = model.recipeUnlockers.get(recipeId);
    return !u || u.length === 0 || u.some((t) => state.research.has(t));
  }

  function isBuildingBuilt(model, buildingId, state) {
    return model.baseBuildings.has(buildingId) || state.buildings.has(buildingId);
  }

  function isBuildingUnlocked(model, buildingId, state) {
    const t = model.buildingUnlocker.get(buildingId);
    return !t || state.research.has(t);
  }

  // What is missing before a recipe can be used: { research: [ids], building: id|null }
  function recipeBlockers(model, recipe, state) {
    const research = [];
    if (!isRecipeUnlocked(model, recipe.id, state)) research.push(...model.recipeUnlockers.get(recipe.id));
    const building = isBuildingBuilt(model, recipe.buildingId, state) ? null : recipe.buildingId;
    if (building) {
      const t = model.buildingUnlocker.get(building);
      if (t && !state.research.has(t) && !research.includes(t)) research.push(t);
    }
    return { research, building };
  }

  function isVariantAvailable(model, v, state) {
    return isRecipeUnlocked(model, v.recipe.id, state) && isBuildingBuilt(model, v.recipe.buildingId, state);
  }

  // All prerequisites of the given research ids (inclusive) that are not yet researched,
  // ordered so prerequisites come first.
  function researchClosure(model, ids, researched) {
    const out = [];
    const seen = new Set();
    const visit = (id) => {
      if (seen.has(id) || researched.has(id) || !model.tech.has(id)) return;
      seen.add(id);
      for (const p of model.tech.get(id).requiredResearch || []) visit(p);
      out.push(id);
    };
    ids.forEach(visit);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Planning
  // ---------------------------------------------------------------------------
  const OBJECTIVES = {
    crafts: { label: "Fewest crafting runs", cost: () => 1 },
    rawValue: {
      label: "Least raw material (by item value)",
      cost: (v, model) => {
        let c = 0.001;
        if (v.extraction) for (const [id, a] of v.rawOut) c += a * ((model.items.get(id) || {}).value || 1);
        return c;
      },
    },
    rawCount: {
      label: "Least raw material (by unit count)",
      cost: (v) => {
        let c = 0.001;
        if (v.extraction) for (const a of v.rawOut.values()) c += a;
        return c;
      },
    },
  };

  // Runs the LP once for a fixed demand and a pool of variants.
  // netOf(v) gives the per-run net item change used for that variant.
  function runLP(model, demand, pool, costOf, netOf) {
    // Collect the variants that can contribute to the demand (backwards reachability).
    const byItem = new Map();
    for (const v of pool) {
      for (const [id, a] of netOf(v)) {
        if (a > 0) {
          if (!byItem.has(id)) byItem.set(id, []);
          byItem.get(id).push(v);
        }
      }
    }
    const chosen = new Set();
    const seenItems = new Set();
    const wanted = [...demand].filter(([, q]) => q > 1e-9).map(([id]) => id);
    const queue = [...wanted];
    while (queue.length) {
      const item = queue.pop();
      if (seenItems.has(item)) continue;
      seenItems.add(item);
      for (const v of byItem.get(item) || []) {
        if (chosen.has(v)) continue;
        chosen.add(v);
        for (const [id, a] of netOf(v)) if (a < 0) queue.push(id);
      }
    }
    const vars = [...chosen];
    const missing = wanted.filter((id) => !byItem.has(id));
    if (missing.length) return { status: "infeasible", missing };

    // Rows: every item with a demand or that some chosen variant consumes.
    const rowIndex = new Map();
    const rowOf = (id) => {
      if (!rowIndex.has(id)) rowIndex.set(id, rowIndex.size);
      return rowIndex.get(id);
    };
    for (const id of wanted) rowOf(id);
    for (const v of vars) for (const [id, a] of netOf(v)) if (a < 0) rowOf(id);
    const cols = vars.map((v) => {
      const col = new Map();
      for (const [id, a] of netOf(v)) if (rowIndex.has(id)) col.set(rowIndex.get(id), a);
      return col;
    });
    const b = new Array(rowIndex.size).fill(0);
    for (const [id, q] of demand) if (rowIndex.has(id)) b[rowIndex.get(id)] = q;
    const c = vars.map(costOf);
    const res = solveLP(rowIndex.size, cols, c, b);
    if (res.status !== "optimal") return { status: res.status };
    const runs = new Map();
    let cost = 0;
    vars.forEach((v, j) => {
      if (res.x[j] > USED) {
        runs.set(v, res.x[j]);
        cost += res.x[j] * c[j];
      }
    });
    return { status: "optimal", runs, cost, demand, netOf };
  }

  // LP that knows runs come in whole numbers: any recipe it uses for less than a full run
  // is re-priced at what that run really costs (cost * ceil(x) / x) and the LP re-solved.
  // Stops a tiny deficit (10 electricity) being met by 0.0006 of a fusion run, which in
  // practice means a full run plus its whole deuterium supply chain.
  function wholeRunLP(model, demand, pool, costOf, netOf, slope) {
    const price = new Map(slope);
    let res;
    for (let k = 0; k < 8; k++) {
      res = runLP(model, demand, pool, (v) => price.get(v) ?? costOf(v), netOf);
      if (res.status !== "optimal") return res;
      let changed = false;
      for (const [v, x] of res.runs) {
        const real = (costOf(v) * Math.ceil(x - 1e-9)) / x;
        if (real > (price.get(v) ?? costOf(v)) * 1.01) {
          price.set(v, real);
          changed = true;
        }
      }
      if (!changed) break;
    }
    return res;
  }

  // Turns fractional LP runs into whole runs. Rounding up makes consumers need more input,
  // so any shortfall is covered by solving again for just the remaining deficit (existing
  // surplus counts as free stock) and rounding that up too, until nothing is short.
  function integerise(model, res, pool, costOf, slope) {
    const { demand, netOf } = res;
    const runs = new Map();
    const addRuns = (lp) => {
      for (const [v, x] of lp) runs.set(v, (runs.get(v) || 0) + Math.ceil(x - 1e-6));
    };
    addRuns(res.runs);
    let ok = true;
    for (let pass = 0; ; pass++) {
      const residual = new Map(demand);
      for (const [v, x] of runs) {
        for (const [id, a] of netOf(v)) residual.set(id, (residual.get(id) || 0) - a * x);
      }
      if (![...residual.values()].some((q) => q > 1e-6)) break;
      const fix = pass < 30 ? wholeRunLP(model, residual, pool, costOf, netOf, slope) : null;
      if (!fix || fix.status !== "optimal") {
        ok = false;
        break;
      }
      addRuns(fix.runs);
    }
    let cost = 0;
    for (const [v, x] of runs) cost += x * costOf(v);
    return { ...res, runs, cost: ok ? cost : Infinity, lpCost: res.cost };
  }

  // Unit price of every item: the cheapest way to make one unit, charging a recipe's
  // whole cost (its own cost plus its inputs at their prices) to each output it nets.
  // A fixed-point iteration, so loops are fine.
  function itemPrices(pool, costOf, netOf) {
    const price = new Map();
    for (let iter = 0; iter < 200; iter++) {
      let changed = false;
      for (const v of pool) {
        let inCost = costOf(v);
        let ok = true;
        for (const [id, a] of netOf(v)) {
          if (a >= 0) continue;
          const p = price.get(id);
          if (p === undefined) {
            ok = false;
            break;
          }
          inCost -= a * p;
        }
        if (!ok) continue;
        for (const [id, a] of netOf(v)) {
          if (a <= 0) continue;
          const unit = inCost / a;
          if (unit < (price.get(id) ?? Infinity) * (1 - 1e-9)) {
            price.set(id, unit);
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
    return price;
  }

  // Top-down whole-run plan, the way a player would work it out: for each item still
  // needed, pick the producer whose whole runs (plus inputs at unit price) cost least, run
  // it, bank all its outputs, then source its inputs the same way. Surplus from earlier
  // runs is used before anything new is made, which also resolves loops.
  function treePlan(model, first, pool, costOf) {
    const { demand, netOf } = first;
    const price = itemPrices(pool, costOf, netOf);
    const producers = new Map();
    for (const v of pool) {
      for (const [id, a] of netOf(v)) {
        if (a > 0) {
          if (!producers.has(id)) producers.set(id, []);
          producers.get(id).push(v);
        }
      }
    }
    const stock = new Map();
    const runs = new Map();
    let steps = 0;
    const need = (item, q, depth) => {
      const have = stock.get(item) || 0;
      if (have >= q - 1e-9) {
        stock.set(item, have - q);
        return true;
      }
      stock.set(item, 0);
      q -= have;
      if (depth > 60 || ++steps > 20000) return false;
      let best = null;
      for (const v of producers.get(item) || []) {
        const yieldPer = netOf(v).get(item);
        const n = Math.ceil(q / yieldPer - 1e-9);
        let est = n * costOf(v);
        let ok = true;
        for (const [id, a] of netOf(v)) {
          if (a >= 0) continue;
          const p = price.get(id);
          if (p === undefined) {
            ok = false;
            break;
          }
          est += Math.max(0, -a * n - (stock.get(id) || 0)) * p;
        }
        if (ok && (!best || est < best.est - 1e-12)) best = { v, n, est };
      }
      if (!best) return false;
      const { v, n } = best;
      runs.set(v, (runs.get(v) || 0) + n);
      for (const [id, a] of netOf(v)) if (a > 0) stock.set(id, (stock.get(id) || 0) + a * n);
      for (const [id, a] of netOf(v)) if (a < 0 && !need(id, -a * n, depth + 1)) return false;
      return need(item, q, depth + 1);
    };
    for (const [id, q] of demand) if (q > 0 && !need(id, q, 0)) return null;
    let cost = 0;
    for (const [v, x] of runs) cost += x * costOf(v);
    return { ...first, runs, cost };
  }

  // Best whole-run plan for one recipe pool, from several starting points:
  // - dynamic slope scaling: re-solve with each recipe's per-run cost scaled by
  //   ceil(runs)/runs from the previous solve, so slivers become expensive;
  // - a top-down whole-run plan (treePlan);
  // - recipe sets that are optimal for larger batches (a plan for 8 also covers 6).
  function wholeRunSearch(model, demand, netOf, pool, costOf) {
    const first = runLP(model, demand, pool, costOf, netOf);
    if (first.status !== "optimal") return null;
    const slope = new Map();
    let best = integerise(model, first, pool, costOf, slope);
    const consider = (plan) => {
      if (plan && plan.cost < best.cost - 1e-9) best = plan;
    };
    consider(treePlan(model, first, pool, costOf));
    let prev = first;
    for (let k = 0; k < 15 && !timeUp(); k++) {
      for (const [v, x] of prev.runs) slope.set(v, (costOf(v) * Math.ceil(x - 1e-9)) / x);
      const res = runLP(model, demand, pool, (v) => slope.get(v) ?? costOf(v), netOf);
      if (res.status !== "optimal") break;
      consider(integerise(model, res, pool, costOf, slope));
      const same =
        res.runs.size === prev.runs.size &&
        [...res.runs].every(([v, x]) => Math.abs((prev.runs.get(v) || 0) - x) <= 1e-6 * Math.max(1, x));
      prev = res;
      if (same) break;
    }
    for (const k of [2, 4, 10, 50]) {
      if (timeUp()) break;
      const scaled = new Map([...demand].map(([id, q]) => [id, q * k]));
      const lp = wholeRunLP(model, scaled, pool, costOf, netOf, new Map());
      if (lp.status !== "optimal") continue;
      const subset = [...lp.runs.keys()];
      const sub = wholeRunLP(model, demand, subset, costOf, netOf, slope);
      if (sub.status === "optimal") consider(integerise(model, sub, subset, costOf, slope));
      consider(treePlan(model, first, subset, costOf));
    }
    return best;
  }

  // Whole-run refinement (time-boxed, see deadline): the best plan from wholeRunSearch,
  // then local search. Each round
  // bans, in turn, each recipe of the current best plan, re-runs the whole search without
  // it, and keeps the single best improvement. This is what moves a plan from one production route
  // to another (say, bloomery iron to blast-furnace iron) when the first route only looked
  // cheaper because of rounding. Bounded by a time budget.
  function refineWholeRuns(model, first, pool, costOf) {
    const { demand, netOf } = first;
    let best = wholeRunSearch(model, demand, netOf, pool, costOf) || integerise(model, first, pool, costOf, new Map());
    const banned = new Set();
    for (let round = 0; round < 10 && !timeUp(); round++) {
      let bestMove = null;
      for (const v of best.runs.keys()) {
        if (timeUp()) break;
        const smaller = pool.filter((u) => u !== v && !banned.has(u));
        const alt = wholeRunSearch(model, demand, netOf, smaller, costOf);
        if (alt && alt.cost < (bestMove ? bestMove.plan.cost : best.cost) - 1e-9) bestMove = { v, plan: alt };
      }
      if (!bestMove) break;
      best = bestMove.plan;
      banned.add(bestMove.v);
    }
    best.catalystStock = first.catalystStock;
    best.trusted = first.trusted;
    return best;
  }

  // Catalyst recipes (an input is handed back, e.g. a pump or 1000 solar modules) are
  // first modelled pessimistically: the catalyst counts as consumed every run. Each one
  // that touches the plan is then trialled as "trusted": the catalyst stock is built once
  // and only the true net change flows through. A trial is kept if it lowers the cost.
  function solveWithCatalysts(model, targets, pool, costOf) {
    const attempt = (trusted) => {
      const demand = new Map(targets);
      const stock = new Map();
      for (const v of trusted) {
        for (const [id, q] of v.catalysts) stock.set(id, Math.max(stock.get(id) || 0, q));
      }
      for (const [id, q] of stock) demand.set(id, (demand.get(id) || 0) + q);
      const netOf = (v) => (trusted.has(v) ? v.net : v.pessimisticNet);
      const res = runLP(model, demand, pool, costOf, netOf);
      if (res.status === "optimal") {
        res.catalystStock = stock;
        res.trusted = trusted;
      }
      return res;
    };

    let best = attempt(new Set());
    if (best.status !== "optimal") return best;
    const catalystPool = pool.filter((v) => v.catalysts.size);
    const tried = new Set();
    for (let guard = 0; guard < 40; guard++) {
      const touched = new Set();
      for (const v of best.runs.keys()) {
        for (const id of v.produced.keys()) touched.add(id);
        for (const id of v.consumed.keys()) touched.add(id);
      }
      for (const id of targets.keys()) touched.add(id);
      const candidate = catalystPool.find(
        (v) => !tried.has(v) && !best.trusted.has(v) && [...v.produced.keys()].some((id) => touched.has(id))
      );
      if (!candidate) break;
      tried.add(candidate);
      const alt = attempt(new Set(best.trusted).add(candidate));
      if (alt.status === "optimal" && alt.cost < best.cost * (1 - 1e-6) - 1e-9) best = alt;
    }
    // Only report stock for catalyst recipes the final plan actually runs.
    const stock = new Map();
    for (const v of best.runs.keys()) {
      if (!best.trusted.has(v)) continue;
      for (const [id, q] of v.catalysts) stock.set(id, Math.max(stock.get(id) || 0, q));
    }
    best.catalystStock = stock;
    best.pool = pool;
    best.costOf = costOf;
    return best;
  }

  // Research a "what-if" plan may use: everything up to a tech level, plus what is done.
  function stateUpToLevel(model, state, level) {
    const research = new Set(state.research);
    for (const t of model.tech.values()) if (t.techLevel <= level) research.add(t.id);
    const buildings = new Set(state.buildings);
    for (const b of model.buildings.keys()) {
      if (isBuildingUnlocked(model, b, { research })) buildings.add(b);
    }
    return { research, buildings };
  }

  // Items marked unlimited are treated as always on hand: they drop out of every recipe's
  // net flow (so nothing is planned to make them) and out of raw-material cost, while the
  // gross amounts used stay visible in the plan.
  function variantsWithUnlimited(model, unlimited) {
    if (!unlimited || !unlimited.size) return model.variants;
    const strip = (map) => new Map([...map].filter(([id]) => !unlimited.has(id)));
    return model.variants.map((v) => ({
      ...v,
      net: strip(v.net),
      pessimisticNet: strip(v.pessimisticNet),
      catalysts: strip(v.catalysts),
      rawOut: strip(v.rawOut),
    }));
  }

  // targets: Map(itemId -> quantity).
  // opts: { objective, allowLocked, timeBudget (ms), unlimited: Set(itemId) }
  function plan(model, targets, state, opts = {}) {
    const objective = OBJECTIVES[opts.objective] || OBJECTIVES.crafts;
    const baseCost = (v) => objective.cost(v, model);
    const unlimited = opts.unlimited || new Set();
    const variants = variantsWithUnlimited(model, unlimited);
    const fromSupply = new Map([...targets].filter(([id]) => unlimited.has(id)));
    targets = new Map([...targets].filter(([id]) => !unlimited.has(id)));
    if (!targets.size) {
      const empty = { runs: new Map(), cost: 0 };
      return summarise(model, targets, state, empty, false, objective, unlimited, fromSupply);
    }
    const available = variants.filter((v) => isVariantAvailable(model, v, state));

    let res = solveWithCatalysts(model, targets, available, baseCost);
    let whatIf = false;
    if (res.status !== "optimal" && opts.allowLocked !== false) {
      // Not possible yet: find the lowest tech level that makes it possible, then plan
      // with locked recipes penalised so as few as possible need unlocking.
      const avail = new Set(available);
      const penalised = (v) => (avail.has(v) ? baseCost(v) : 25 + 5 * baseCost(v));
      const levels = [...new Set([...model.tech.values()].map((t) => t.techLevel))].sort((a, b) => a - b);
      for (const level of levels) {
        const s = stateUpToLevel(model, state, level);
        const pool = variants.filter((v) => isVariantAvailable(model, v, s));
        const alt = solveWithCatalysts(model, targets, pool, penalised);
        if (alt.status === "optimal") {
          res = alt;
          whatIf = level;
          break;
        }
      }
      if (!whatIf) return { status: "impossible", missing: res.missing || [] };
    }
    if (res.status !== "optimal") return { status: "infeasible", missing: res.missing || [] };
    deadline = Date.now() + (opts.timeBudget ?? 1500);
    try {
      res = refineWholeRuns(model, res, res.pool, res.costOf);
    } finally {
      deadline = Infinity;
    }
    return summarise(model, targets, state, res, whatIf, objective, unlimited, fromSupply);
  }

  // Orders steps so producers come before the steps that use their output. Byproducts
  // and loops (rolling makes scrap, scrap becomes iron plate, iron plate becomes steel;
  // mining needs iron tools made from mined ore) mean the "feeds" graph has cycles, so:
  // 1. weight each link by the value of material that actually flows along it (an item's
  //    output is shared among its consumers in proportion to what they use);
  // 2. break every cycle at its weakest link (a trickle of scrap, half a tool's wear);
  // 3. topologically sort what is left, putting deeper supply chains first.
  function orderSteps(model, steps, unlimited) {
    const valueOf = (id) => Math.max((model.items.get(id) || {}).value || 0, 0.01);
    const n = steps.length;
    const made = new Map();
    for (const s of steps) {
      for (const [id, a] of s.variant.produced) made.set(id, (made.get(id) || 0) + a * s.runs);
    }
    // w[i] = Map(j -> weight) for links step i feeds step j.
    const w = steps.map(() => new Map());
    steps.forEach((b, j) => {
      for (const [id, use] of b.variant.consumed) {
        if (unlimited.has(id) || !made.get(id)) continue;
        steps.forEach((a, i) => {
          if (i === j || !a.variant.produced.has(id)) return;
          const share = (a.variant.produced.get(id) * a.runs) / made.get(id);
          const weight = share * use * b.runs * valueOf(id);
          if (weight > 1e-12) w[i].set(j, (w[i].get(j) || 0) + weight);
        });
      }
    });

    // Find a cycle (iterative DFS); returns its links as [from, to] pairs, or null.
    const findCycle = () => {
      const state = new Uint8Array(n); // 0 new, 1 on stack, 2 done
      const parent = new Int32Array(n).fill(-1);
      for (let root = 0; root < n; root++) {
        if (state[root]) continue;
        const stack = [[root, [...w[root].keys()], 0]];
        state[root] = 1;
        while (stack.length) {
          const top = stack[stack.length - 1];
          const [u, next] = top;
          if (top[2] >= next.length) {
            state[u] = 2;
            stack.pop();
            continue;
          }
          const v = next[top[2]++];
          if (state[v] === 1) {
            const cycle = [[u, v]];
            for (let x = u; x !== v; x = parent[x]) cycle.push([parent[x], x]);
            return cycle;
          }
          if (state[v] === 0) {
            state[v] = 1;
            parent[v] = u;
            stack.push([v, [...w[v].keys()], 0]);
          }
        }
      }
      return null;
    };
    for (let guard = 0; guard < 10000; guard++) {
      const cycle = findCycle();
      if (!cycle) break;
      let weakest = cycle[0];
      for (const e of cycle) if (w[e[0]].get(e[1]) < w[weakest[0]].get(weakest[1])) weakest = e;
      w[weakest[0]].delete(weakest[1]);
    }

    // Longest path from each step down to the end of the chain: deeper chains go first.
    const depth = new Array(n).fill(-1);
    const depthOf = (i) => {
      if (depth[i] >= 0) return depth[i];
      depth[i] = 0;
      let d = 0;
      for (const j of w[i].keys()) d = Math.max(d, depthOf(j) + 1);
      return (depth[i] = d);
    };
    const indeg = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      depthOf(i);
      for (const j of w[i].keys()) indeg[j]++;
    }
    const ready = [];
    for (let i = 0; i < n; i++) if (!indeg[i]) ready.push(i);
    const order = [];
    while (ready.length) {
      ready.sort((x, y) => depth[y] - depth[x] || x - y);
      const i = ready.shift();
      order.push(steps[i]);
      for (const j of w[i].keys()) if (--indeg[j] === 0) ready.push(j);
    }
    return order;
  }

  function summarise(model, targets, state, res, whatIf, objective, unlimited = new Set(), fromSupply = new Map()) {
    const steps = [];
    const flow = new Map(); // item -> { produced, consumed, demand }
    const f = (id) => {
      if (!flow.has(id)) flow.set(id, { produced: 0, consumed: 0, demand: 0 });
      return flow.get(id);
    };
    for (const [id, q] of targets) f(id).demand += q;
    for (const [id, q] of res.catalystStock || []) f(id).stock = q;

    for (const [v, runs] of res.runs) {
      for (const [id, a] of v.produced) f(id).produced += a * runs;
      for (const [id, a] of v.consumed) f(id).consumed += a * runs;
      const blockers = recipeBlockers(model, v.recipe, state);
      steps.push({
        variant: v,
        runs,
        locked: blockers.research.length > 0 || !!blockers.building,
        blockers,
      });
    }

    const ordered = orderSteps(model, steps, unlimited);
    // Inputs that only come from a later step: a loop the player has to bootstrap with
    // some stock on hand (e.g. iron tools to mine the ore that iron tools are made from).
    ordered.forEach((s, i) => {
      s.loopsBack = [];
      for (const id of s.variant.consumed.keys()) {
        if (unlimited.has(id)) continue;
        const from = [];
        ordered.forEach((o, k) => o !== s && o.variant.produced.has(id) && from.push(k));
        if (from.length && from.every((k) => k > i)) s.loopsBack.push({ id, step: Math.min(...from) + 1 });
      }
    });

    const gathered = [];
    for (const s of ordered) {
      if (s.variant.extraction) for (const [id, a] of s.variant.rawOut) gathered.push([id, a * s.runs]);
    }
    const gatheredTotals = new Map();
    for (const [id, a] of gathered) gatheredTotals.set(id, (gatheredTotals.get(id) || 0) + a);

    const surplus = [];
    const unlimitedUsed = new Map(fromSupply);
    for (const [id, x] of flow) {
      if (unlimited.has(id)) {
        const used = x.consumed - x.produced;
        if (used > 1e-6) unlimitedUsed.set(id, (unlimitedUsed.get(id) || 0) + used);
        continue;
      }
      const extra = x.produced - x.consumed - x.demand;
      if (extra > 1e-6) surplus.push([id, extra]);
    }

    // Unlock requirements when the plan relies on locked recipes.
    const needResearch = new Set();
    const needBuildings = new Set();
    for (const s of ordered) {
      if (!s.locked) continue;
      s.blockers.research.forEach((t) => needResearch.add(t));
      if (s.blockers.building) needBuildings.add(s.blockers.building);
    }
    const researchPath = researchClosure(model, [...needResearch], state.research);

    return {
      status: "optimal",
      whatIf,
      objective: objective.label,
      cost: res.cost,
      totalRuns: ordered.reduce((a, s) => a + s.runs, 0),
      steps: ordered,
      flow,
      gathered: gatheredTotals,
      surplus,
      unlimitedUsed,
      catalysts: res.catalystStock || new Map(),
      researchPath,
      buildingsNeeded: [...needBuildings],
    };
  }

  const api = {
    solveLP, createModel, plan, OBJECTIVES,
    isRecipeUnlocked, isBuildingBuilt, isBuildingUnlocked, isVariantAvailable,
    recipeBlockers, researchClosure,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else global.RIPlanner = api;
})(typeof window !== "undefined" ? window : globalThis);
