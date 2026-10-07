(function () {
  "use strict";

  const P = window.RIPlanner;
  const data = window.RI_DATA;
  const model = P.createModel(data);
  const STORE = "ri-planner-v1";

  const $ = (id) => document.getElementById(id);
  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const itemName = (id) => (model.items.get(id) || {}).name || id;
  const techName = (id) => (model.tech.get(id) || {}).name || id;
  const buildingName = (id) => (model.buildings.get(id) || {}).name || id;
  const fmt = (n) => {
    if (Math.abs(n - Math.round(n)) < 1e-6) return Math.round(n).toLocaleString();
    if (Math.abs(n) >= 100) return n.toLocaleString(undefined, { maximumFractionDigits: 1 });
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  const state = {
    research: new Set(),
    buildings: new Set(),
    autoBuild: false,
    targets: [], // { kind: "item"|"building"|"research", id, qty }
    objective: "crafts",
    unlimited: new Set(), // items assumed always on hand; nothing is planned to make them
  };

  function load() {
    try {
      const raw = JSON.parse(localStorage.getItem(STORE) || "null");
      if (raw) applySaved(raw);
    } catch (e) {
      /* storage unavailable or corrupt: start fresh */
    }
  }
  function applySaved(raw) {
    state.research = new Set((raw.research || []).filter((id) => model.tech.has(id)));
    state.buildings = new Set((raw.buildings || []).filter((id) => model.buildings.has(id)));
    state.autoBuild = !!raw.autoBuild;
    if (Array.isArray(raw.targets)) state.targets = raw.targets.filter((t) => targetExists(t));
    if (raw.objective && P.OBJECTIVES[raw.objective]) state.objective = raw.objective;
    state.unlimited = new Set((raw.unlimited || []).filter((id) => model.items.has(id)));
  }
  function serialise() {
    return {
      research: [...state.research],
      buildings: [...state.buildings],
      autoBuild: state.autoBuild,
      targets: state.targets,
      objective: state.objective,
      unlimited: [...state.unlimited],
    };
  }
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(serialise()));
    } catch (e) {
      /* ignore */
    }
  }
  function targetExists(t) {
    if (t.kind === "item") return model.items.has(t.id);
    if (t.kind === "building") return !!model.costs[t.id];
    if (t.kind === "research") return model.tech.has(t.id);
    return false;
  }

  // The unlock state the planner sees.
  function effectiveState() {
    const buildings = new Set(state.buildings);
    if (state.autoBuild) {
      for (const id of model.buildings.keys()) {
        if (P.isBuildingUnlocked(model, id, state)) buildings.add(id);
      }
    }
    return { research: state.research, buildings };
  }

  // ---------------------------------------------------------------------------
  // Research list
  // ---------------------------------------------------------------------------
  const techByLevel = new Map();
  for (const t of data.tech) {
    if (!techByLevel.has(t.techLevel)) techByLevel.set(t.techLevel, []);
    techByLevel.get(t.techLevel).push(t);
  }
  const levels = [...techByLevel.keys()].sort((a, b) => a - b);

  function setResearch(id, on) {
    if (on) {
      for (const p of P.researchClosure(model, [id], state.research)) state.research.add(p);
    } else {
      const drop = (x) => {
        if (!state.research.delete(x)) return;
        for (const d of model.dependents.get(x) || []) drop(d);
      };
      drop(id);
    }
  }

  function costText(inputs) {
    return Object.entries(inputs || {})
      .map(([id, q]) => `${fmt(q)} ${itemName(id)}`)
      .join(", ");
  }

  function renderResearch() {
    const q = $("researchSearch").value.trim().toLowerCase();
    let html = "";
    for (const level of levels) {
      const list = techByLevel.get(level).filter(
        (t) => !q || t.name.toLowerCase().includes(q) || t.id.includes(q)
      );
      if (!list.length) continue;
      const done = techByLevel.get(level).filter((t) => state.research.has(t.id)).length;
      const all = techByLevel.get(level).length;
      html += `<div class="group"><label class="group-head">
        <input type="checkbox" data-level="${level}" ${done === all ? "checked" : ""}>
        Tech level ${level}<span class="count">${done}/${all}</span></label>`;
      for (const t of list) {
        const on = state.research.has(t.id);
        const prereqMet = (t.requiredResearch || []).every((p) => state.research.has(p));
        const unlocks = [];
        const b = [].concat(t.unlockBuilding || []);
        if (b.length) unlocks.push(b.map(buildingName).join(", "));
        const nr = (t.unlocksRecipes || []).length;
        if (nr) unlocks.push(`${nr} recipe${nr > 1 ? "s" : ""}`);
        const tip = `Cost: ${costText(t.inputs)}` +
          ((t.requiredResearch || []).length ? `\nRequires: ${t.requiredResearch.map(techName).join(", ")}` : "");
        html += `<label class="row ${on || prereqMet ? "" : "unavailable"}" title="${esc(tip)}">
          <input type="checkbox" data-tech="${t.id}" ${on ? "checked" : ""}>
          <span><span class="name">${esc(t.name)}</span>
          ${!on && prereqMet ? '<span class="tag ok">ready</span>' : ""}
          <br><span class="meta">${esc(unlocks.join(" · ") || "—")}</span></span></label>`;
      }
      html += "</div>";
    }
    $("researchList").innerHTML = html || '<p class="empty">No research matches.</p>';
    $("tabResearch").textContent = `Research (${state.research.size}/${model.tech.size})`;
  }

  // ---------------------------------------------------------------------------
  // Buildings list
  // ---------------------------------------------------------------------------
  const buildingsByCat = new Map();
  for (const b of data.buildings) {
    if (!buildingsByCat.has(b.category)) buildingsByCat.set(b.category, []);
    buildingsByCat.get(b.category).push(b);
  }
  for (const list of buildingsByCat.values()) list.sort((a, b) => a.techLevel - b.techLevel || a.name.localeCompare(b.name));

  function renderBuildings() {
    const q = $("buildingSearch").value.trim().toLowerCase();
    const eff = effectiveState();
    let html = "";
    let builtCount = 0;
    for (const id of model.buildings.keys()) if (P.isBuildingBuilt(model, id, eff)) builtCount++;
    for (const [cat, list] of buildingsByCat) {
      const shown = list.filter((b) => !q || b.name.toLowerCase().includes(q) || b.id.includes(q));
      if (!shown.length) continue;
      html += `<div class="group"><div class="group-head">${esc(cat[0].toUpperCase() + cat.slice(1))}</div>`;
      for (const b of shown) {
        const base = model.baseBuildings.has(b.id);
        const built = P.isBuildingBuilt(model, b.id, eff);
        const unlocked = P.isBuildingUnlocked(model, b.id, state);
        const unlocker = model.buildingUnlocker.get(b.id);
        let tag = "";
        if (base) tag = '<span class="tag ok">always available</span>';
        else if (!unlocked) tag = `<span class="tag lock">needs ${esc(techName(unlocker))}</span>`;
        else if (!built) tag = '<span class="tag warn">unlocked</span>';
        const disabled = base || (state.autoBuild && unlocked);
        const cost = model.costs[b.id] ? `Construction: ${costText(model.costs[b.id])}` : "";
        html += `<label class="row ${built || unlocked ? "" : "unavailable"}" title="${esc(cost)}">
          <input type="checkbox" data-building="${b.id}" ${built ? "checked" : ""} ${disabled ? "disabled" : ""}>
          <span><span class="name">${esc(b.name)}</span>${tag}
          <br><span class="meta">Level ${b.techLevel} · ${esc(b.energySource)}</span></span></label>`;
      }
      html += "</div>";
    }
    $("buildingList").innerHTML = html || '<p class="empty">No buildings match.</p>';
    $("tabBuildings").textContent = `Buildings (${builtCount}/${model.buildings.size})`;
    $("autoBuild").checked = state.autoBuild;
  }

  // ---------------------------------------------------------------------------
  // Unlimited resources
  // ---------------------------------------------------------------------------
  const CATEGORY_ORDER = ["raw", "ore", "energy", "processed", "metal", "intermediate", "component", "tools", "advanced", "final"];
  const itemsByCat = new Map();
  for (const it of data.items) {
    if (!itemsByCat.has(it.category)) itemsByCat.set(it.category, []);
    itemsByCat.get(it.category).push(it);
  }
  for (const list of itemsByCat.values()) list.sort((a, b) => a.name.localeCompare(b.name));
  const categories = [...itemsByCat.keys()].sort(
    (a, b) => (CATEGORY_ORDER.indexOf(a) + 1 || 99) - (CATEGORY_ORDER.indexOf(b) + 1 || 99)
  );
  const PRESETS = {
    utilities: ["water", "electricity"],
    basics: ["water", "electricity", "wood", "stone", "clay", "coal", "sand"],
  };

  function renderUnlimited() {
    const q = $("unlimitedSearch").value.trim().toLowerCase();
    let html = "";
    for (const cat of categories) {
      const list = itemsByCat.get(cat).filter((i) => !q || i.name.toLowerCase().includes(q) || i.id.includes(q));
      if (!list.length) continue;
      const on = itemsByCat.get(cat).filter((i) => state.unlimited.has(i.id)).length;
      html += `<div class="group"><div class="group-head">${esc(cat[0].toUpperCase() + cat.slice(1))}
        <span class="count">${on}/${itemsByCat.get(cat).length}</span></div>`;
      for (const it of list) {
        html += `<label class="row">
          <input type="checkbox" data-unlimited="${it.id}" ${state.unlimited.has(it.id) ? "checked" : ""}>
          <span class="name">${esc(it.name)}</span></label>`;
      }
      html += "</div>";
    }
    $("unlimitedList").innerHTML = html || '<p class="empty">No items match.</p>';
    $("tabUnlimited").textContent = `Unlimited (${state.unlimited.size})`;
  }

  // ---------------------------------------------------------------------------
  // Targets
  // ---------------------------------------------------------------------------
  const searchIndex = [
    ...data.items.map((i) => ({ kind: "item", id: i.id, name: i.name, extra: i.category })),
    ...data.buildings
      .filter((b) => model.costs[b.id])
      .map((b) => ({ kind: "building", id: b.id, name: b.name, extra: "construction cost" })),
    ...data.tech.map((t) => ({ kind: "research", id: t.id, name: t.name, extra: `research cost · L${t.techLevel}` })),
  ];
  let suggestions = [];
  let activeSuggestion = 0;
  let picked = null;

  function renderSuggest() {
    const q = $("targetSearch").value.trim().toLowerCase();
    const box = $("suggest");
    if (!q) {
      box.classList.add("hidden");
      return;
    }
    const score = (e) => {
      const n = e.name.toLowerCase();
      if (n === q) return 0;
      if (n.startsWith(q)) return 1;
      if (n.includes(q)) return 2;
      if (e.id.includes(q)) return 3;
      return 9;
    };
    suggestions = searchIndex
      .map((e) => [score(e), e])
      .filter(([s]) => s < 9)
      .sort((a, b) => a[0] - b[0] || (a[1].kind === "item" ? -1 : 1) || a[1].name.localeCompare(b[1].name))
      .slice(0, 30)
      .map(([, e]) => e);
    activeSuggestion = 0;
    box.innerHTML = suggestions.length
      ? suggestions
          .map((e, i) => `<li role="option" data-i="${i}" class="${i === 0 ? "active" : ""}">${esc(e.name)}<span class="kind">${esc(e.kind === "item" ? e.extra : e.extra)}</span></li>`)
          .join("")
      : '<li class="empty">No matches</li>';
    box.classList.remove("hidden");
  }

  function pickSuggestion(i) {
    const e = suggestions[i];
    if (!e) return;
    picked = e;
    $("targetSearch").value = e.name;
    $("suggest").classList.add("hidden");
    $("targetQty").focus();
    $("targetQty").select();
  }

  function addTarget(kind, id, qty) {
    if (!(qty > 0)) qty = 1;
    const existing = state.targets.find((t) => t.kind === kind && t.id === id);
    if (existing) existing.qty += qty;
    else state.targets.push({ kind, id, qty });
    changed();
  }

  function renderTargets() {
    const box = $("targets");
    if (!state.targets.length) {
      box.innerHTML = '<span class="hint">Add one or more targets. Buildings and research count as their construction or research cost.</span>';
      return;
    }
    box.innerHTML = state.targets
      .map((t, i) => {
        const name = t.kind === "item" ? itemName(t.id) : t.kind === "building" ? buildingName(t.id) : techName(t.id);
        const kind = t.kind === "item" ? "" : `<span class="kind">${t.kind === "building" ? "build" : "research"}</span>`;
        return `<span class="target-chip">${esc(name)} ${kind}
          <input type="number" min="0" step="any" value="${t.qty}" data-qty="${i}" aria-label="Quantity of ${esc(name)}">
          <button data-remove="${i}" aria-label="Remove ${esc(name)}">✕</button></span>`;
      })
      .join("");
  }

  function targetDemand() {
    const demand = new Map();
    const add = (id, q) => q > 0 && demand.set(id, (demand.get(id) || 0) + q);
    for (const t of state.targets) {
      if (t.kind === "item") add(t.id, t.qty);
      else if (t.kind === "building") for (const [id, q] of Object.entries(model.costs[t.id] || {})) add(id, q * t.qty);
      else for (const [id, q] of Object.entries((model.tech.get(t.id) || {}).inputs || {})) add(id, q * t.qty);
    }
    return demand;
  }

  // ---------------------------------------------------------------------------
  // Planning + results
  // ---------------------------------------------------------------------------
  let planTimer = null;
  let planSeq = 0;

  function schedulePlan() {
    clearTimeout(planTimer);
    const seq = ++planSeq;
    const demand = targetDemand();
    if (!demand.size) {
      $("calcState").textContent = "";
      $("results").innerHTML = "";
      return;
    }
    $("calcState").textContent = "Calculating…";
    planTimer = setTimeout(() => {
      const t0 = performance.now();
      let res;
      try {
        res = P.plan(model, demand, effectiveState(), { objective: state.objective, unlimited: state.unlimited });
      } catch (e) {
        console.error(e);
        res = { status: "error", message: e.message };
      }
      if (seq !== planSeq) return;
      $("calcState").textContent = `Solved in ${Math.round(performance.now() - t0)} ms`;
      renderResults(res, demand);
    }, 400);
  }

  const chip = (id, q) => {
    const free = state.unlimited.has(id);
    const title = free ? `${itemName(id)} (unlimited supply)` : itemName(id);
    return `<button class="chip${free ? " free" : ""}" data-item="${esc(id)}" title="${esc(title)}"><b>${fmt(q)}</b> ${esc(itemName(id))}${free ? " ∞" : ""}</button>`;
  };
  const chips = (pairs) => `<div class="chips">${pairs.map(([id, q]) => chip(id, q)).join("")}</div>`;

  function renderResults(res, demand) {
    const out = $("results");
    if (res.status === "error") {
      out.innerHTML = `<div class="banner bad"><h3>Something went wrong</h3><p>${esc(res.message)}</p></div>`;
      return;
    }
    if (res.status !== "optimal") {
      const missing = res.missing && res.missing.length ? `No recipe in the game produces: ${res.missing.map(itemName).join(", ")}.` : "No combination of recipes can produce this, even with everything unlocked.";
      out.innerHTML = `<div class="banner bad"><h3>Can't be made</h3><p>${esc(missing)}</p></div>`;
      return;
    }

    let html = "";
    if (!res.steps.length) {
      out.innerHTML = `<div class="banner ok"><h3>Nothing to make</h3><p>Every target is marked as unlimited.</p></div>`;
      return;
    }
    if (res.whatIf) {
      const rp = res.researchPath;
      const bn = res.buildingsNeeded;
      html += `<div class="banner warn"><h3>Not possible with your current progress</h3>
        <p>The cheapest route needs tech up to level ${res.whatIf}: ${rp.length} research and ${bn.length} building${bn.length === 1 ? "" : "s"} to unlock. Locked steps are highlighted below.</p></div>`;
      html += `<div class="two-col">`;
      html += `<section class="panel card"><h3>Research to complete (in order)</h3>`;
      html += rp.length
        ? `<ol class="unlock-list">${rp.map((id) => {
            const t = model.tech.get(id);
            return `<li><b>${esc(t.name)}</b> <span class="tag">L${t.techLevel}</span>
              <button class="link" data-plan-research="${id}">plan cost</button>
              <br><span class="hint">${esc(costText(t.inputs))}</span></li>`;
          }).join("")}</ol>
          <div class="toolbar"><button data-mark-research="${rp.join(",")}">Mark all as researched</button></div>`
        : '<p class="hint">None — only buildings are missing.</p>';
      html += `</section><section class="panel card"><h3>Buildings to construct</h3>`;
      html += bn.length
        ? `<ul class="unlock-list">${bn.map((id) => `<li><b>${esc(buildingName(id))}</b>
            ${model.costs[id] ? `<button class="link" data-plan-building="${id}">plan construction</button><br><span class="hint">${esc(costText(model.costs[id]))}</span>` : ""}</li>`).join("")}</ul>
          <div class="toolbar"><button data-mark-buildings="${bn.join(",")}">Mark all as built</button></div>`
        : '<p class="hint">None — only research is missing.</p>';
      html += `</section></div>`;
    } else {
      html += `<div class="banner ok"><h3>You can make this now</h3><p>Every step below uses research and buildings you already have.</p></div>`;
    }

    const distinct = new Set(res.steps.map((s) => s.variant.recipe.id)).size;
    let gatheredUnits = 0;
    for (const q of res.gathered.values()) gatheredUnits += q;
    html += `<div class="stats">
      <div class="panel stat"><div class="v">${fmt(res.totalRuns)}</div><div class="l">crafting runs</div></div>
      <div class="panel stat"><div class="v">${distinct}</div><div class="l">different recipes</div></div>
      <div class="panel stat"><div class="v">${new Set(res.steps.map((s) => s.variant.recipe.buildingId)).size}</div><div class="l">buildings used</div></div>
      <div class="panel stat"><div class="v">${fmt(gatheredUnits)}</div><div class="l">raw units gathered</div></div>
    </div>`;

    html += `<section class="panel card"><h3>Production steps</h3>
      <p class="hint">Run top to bottom: each step uses things made in earlier steps. A "loops back" tag marks an input only made later (such as tools to mine the ore they're made from), so you need some on hand to start. ∞ marks items you've set as unlimited. Optimised for: ${esc(res.objective.toLowerCase())}.</p>
      <div class="table-wrap"><table class="steps"><thead><tr><th>#</th><th>Recipe</th><th>Runs</th><th>Uses</th><th></th><th>Makes</th></tr></thead><tbody>`;
    res.steps.forEach((s, i) => {
      const v = s.variant;
      const r = v.recipe;
      const uses = [...v.consumed].map(([id, a]) => [id, a * s.runs]);
      const makes = [...v.produced].map(([id, a]) => [id, a * s.runs]);
      const notes = [];
      if (v.fuel) notes.push(`fuel: ${itemName(v.fuel.id)}`);
      if (v.tool) notes.push(`tool: ${itemName(v.tool.id)} (${fmt(v.tool.durability)} durability/run)`);
      if (v.catalysts.size) notes.push(`keeps: ${[...v.catalysts].map(([id, q]) => `${fmt(q)} ${itemName(id)}`).join(", ")}`);
      let lock = "";
      if (s.locked) {
        const parts = [];
        if (s.blockers.research.length) parts.push(`research ${s.blockers.research.map(techName).join(" + ")}`);
        if (s.blockers.building) parts.push(`build ${buildingName(s.blockers.building)}`);
        lock = `<br><span class="tag lock">needs ${esc(parts.join(" + "))}</span>`;
      }
      const loops = (s.loopsBack || [])
        .map((l) => `<br><span class="tag warn" title="This step's input is made in a later step. Have some on hand to start, or mark it unlimited.">loops back: uses ${esc(itemName(l.id))} from step ${l.step}</span>`)
        .join("");
      html += `<tr class="${s.locked ? "locked" : ""}">
        <td class="n">${i + 1}</td>
        <td><div class="rname">${esc(r.name)}</div>
          <div class="bname">${esc(buildingName(r.buildingId))}${notes.length ? " · " + esc(notes.join(" · ")) : ""}</div>${lock}${loops}</td>
        <td class="runs">× ${fmt(s.runs)}</td>
        <td>${uses.length ? chips(uses) : '<span class="hint">nothing</span>'}</td>
        <td class="arrow">→</td>
        <td>${chips(makes)}</td></tr>`;
    });
    html += `</tbody></table></div></section>`;

    html += `<div class="two-col">`;
    html += `<section class="panel card"><h3>Raw materials gathered</h3>${
      res.gathered.size ? chips([...res.gathered].sort((a, b) => b[1] - a[1])) : '<p class="hint">None.</p>'
    }</section>`;
    html += `<section class="panel card"><h3>Leftovers</h3><p class="hint">Byproducts and rounding surplus after the targets are met.</p>${
      res.surplus.length ? chips(res.surplus.sort((a, b) => b[1] - a[1])) : '<p class="hint">None.</p>'
    }</section>`;
    html += `</div>`;

    if (res.unlimitedUsed && res.unlimitedUsed.size) {
      html += `<section class="panel card"><h3>Drawn from unlimited supply</h3>
        <p class="hint">Items you've marked unlimited. The plan doesn't make these; this is how much it uses.</p>
        ${chips([...res.unlimitedUsed].sort((a, b) => b[1] - a[1]))}</section>`;
    }

    if (res.catalysts.size) {
      html += `<section class="panel card"><h3>Catalysts to keep on hand</h3>
        <p class="hint">Some recipes hand these back after each run. They are made once (included above) and reused.</p>
        ${chips([...res.catalysts])}</section>`;
    }
    out.innerHTML = html;
  }

  // ---------------------------------------------------------------------------
  // Item dialog
  // ---------------------------------------------------------------------------
  function showItem(id) {
    const it = model.items.get(id);
    if (!it) return;
    const eff = effectiveState();
    const status = (r) => {
      const b = P.recipeBlockers(model, r, eff);
      if (!b.research.length && !b.building) return '<span class="tag ok">available</span>';
      const parts = [];
      if (b.research.length) parts.push(b.research.map(techName).join(" + "));
      if (b.building) parts.push(`build ${buildingName(b.building)}`);
      return `<span class="tag lock">needs ${esc(parts.join(" + "))}</span>`;
    };
    const line = (r) => {
      const ins = Object.entries(r.inputs || {});
      const fuel = r.fuelOptions && r.fuelOptions.length
        ? ` · fuel: ${r.fuelOptions.map((f) => `${fmt(f.amount)} ${itemName(f.id)}`).join(" or ")}`
        : r.fuelRequired ? ` · fuel: ${fmt(r.fuelAmount)} ${itemName(r.fuelRequired)}` : "";
      const tool = r.toolRequired ? ` · tool: ${itemName(r.toolRequired)}` : "";
      return `<div class="recipe-line"><b>${esc(r.name)}</b> ${status(r)}
        <div class="hint">${esc(buildingName(r.buildingId))}${esc(fuel)}${esc(tool)}</div>
        <div class="io chips">${ins.length ? ins.map(([i, q]) => chip(i, q)).join("") : '<span class="hint">no inputs</span>'}
        <span class="arrow">→</span>${Object.entries(r.outputs).map(([i, q]) => chip(i, q)).join("")}</div></div>`;
    };
    const makers = data.recipes.filter((r) => (r.outputs || {})[id] > 0 && !((r.inputs || {})[id] >= r.outputs[id]));
    const users = data.recipes.filter((r) => (r.inputs || {})[id] > 0 || r.toolRequired === id || r.fuelRequired === id || (r.fuelOptions || []).some((f) => f.id === id));
    const buildingsUsing = Object.entries(model.costs).filter(([, c]) => c[id]).map(([b]) => buildingName(b));
    const researchUsing = data.tech.filter((t) => (t.inputs || {})[id]).map((t) => t.name);
    $("itemBody").innerHTML = `
      <div class="item-head"><h3>${esc(it.name)}</h3><span class="tag">${esc(it.category)}</span>
        ${it.formula ? `<span class="hint">${esc(it.formula)}</span>` : ""}
        <span class="hint">value ${fmt(it.value || 0)}${it.durability ? ` · durability ${it.durability}` : ""}</span></div>
      <div class="toolbar"><button class="primary" data-plan-item="${esc(id)}">Plan this item</button>
        <button data-toggle-unlimited="${esc(id)}">${state.unlimited.has(id) ? "Stop treating as unlimited" : "Treat as unlimited"}</button></div>
      <h4 style="margin-top:14px">Made by (${makers.length})</h4>${makers.map(line).join("") || '<p class="hint">Nothing.</p>'}
      <h4 style="margin-top:14px">Used by ${users.length} recipe${users.length === 1 ? "" : "s"}</h4>
      <p class="hint">${esc(users.map((r) => r.name).join(", ") || "None.")}</p>
      ${buildingsUsing.length ? `<h4>Building construction</h4><p class="hint">${esc(buildingsUsing.join(", "))}</p>` : ""}
      ${researchUsing.length ? `<h4>Research</h4><p class="hint">${esc(researchUsing.join(", "))}</p>` : ""}`;
    const dlg = $("itemDialog");
    if (!dlg.open) dlg.showModal();
    $("itemBody").scrollTop = 0;
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  function changed(opts = {}) {
    save();
    renderTargets();
    if (opts.lists !== false) {
      renderResearch();
      renderBuildings();
      renderUnlimited();
    }
    schedulePlan();
  }

  function init() {
    load();
    $("dataInfo").textContent = `${data.items.length} items · ${data.recipes.length} recipes · ${data.tech.length} research · ${data.buildings.length} buildings`;
    $("levelSelect").innerHTML = levels.map((l) => `<option value="${l}">${l}</option>`).join("");
    $("objective").innerHTML = Object.entries(P.OBJECTIVES)
      .map(([k, o]) => `<option value="${k}" ${k === state.objective ? "selected" : ""}>${esc(o.label)}</option>`)
      .join("");

    document.querySelectorAll(".tab").forEach((tab) =>
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
        $("researchPane").classList.toggle("hidden", tab.dataset.tab !== "research");
        $("buildingsPane").classList.toggle("hidden", tab.dataset.tab !== "buildings");
        $("unlimitedPane").classList.toggle("hidden", tab.dataset.tab !== "unlimited");
      })
    );

    $("researchSearch").addEventListener("input", renderResearch);
    $("unlimitedSearch").addEventListener("input", renderUnlimited);
    $("unlimitedList").addEventListener("change", (e) => {
      const id = e.target.dataset.unlimited;
      if (!id) return;
      if (e.target.checked) state.unlimited.add(id);
      else state.unlimited.delete(id);
      changed();
    });
    document.querySelectorAll("[data-preset]").forEach((b) =>
      b.addEventListener("click", () => {
        const p = b.dataset.preset;
        if (p === "clear") state.unlimited.clear();
        else if (p === "raw") data.items.filter((i) => i.category === "raw").forEach((i) => state.unlimited.add(i.id));
        else PRESETS[p].forEach((id) => model.items.has(id) && state.unlimited.add(id));
        changed();
      })
    );
    $("buildingSearch").addEventListener("input", renderBuildings);
    $("researchList").addEventListener("change", (e) => {
      const el = e.target;
      if (el.dataset.tech) setResearch(el.dataset.tech, el.checked);
      else if (el.dataset.level) {
        for (const t of techByLevel.get(+el.dataset.level)) setResearch(t.id, el.checked);
      }
      changed();
    });
    $("levelApply").addEventListener("click", () => {
      const max = +$("levelSelect").value;
      for (const t of data.tech) if (t.techLevel <= max) state.research.add(t.id);
      changed();
    });
    $("researchClear").addEventListener("click", () => {
      state.research.clear();
      changed();
    });
    $("buildingList").addEventListener("change", (e) => {
      const id = e.target.dataset.building;
      if (!id) return;
      if (e.target.checked) state.buildings.add(id);
      else state.buildings.delete(id);
      changed();
    });
    $("autoBuild").addEventListener("change", (e) => {
      state.autoBuild = e.target.checked;
      changed();
    });
    $("buildUnlocked").addEventListener("click", () => {
      for (const id of model.buildings.keys()) if (P.isBuildingUnlocked(model, id, state)) state.buildings.add(id);
      changed();
    });
    $("buildingClear").addEventListener("click", () => {
      state.buildings.clear();
      changed();
    });

    const search = $("targetSearch");
    search.addEventListener("input", () => {
      picked = null;
      renderSuggest();
    });
    search.addEventListener("focus", renderSuggest);
    search.addEventListener("keydown", (e) => {
      const box = $("suggest");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        activeSuggestion = Math.max(0, Math.min(suggestions.length - 1, activeSuggestion + (e.key === "ArrowDown" ? 1 : -1)));
        box.querySelectorAll("li").forEach((li, i) => li.classList.toggle("active", i === activeSuggestion));
        box.querySelector("li.active")?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (!box.classList.contains("hidden")) pickSuggestion(activeSuggestion);
        else if (picked) $("addTarget").click();
      } else if (e.key === "Escape") box.classList.add("hidden");
    });
    $("suggest").addEventListener("mousedown", (e) => {
      const li = e.target.closest("li[data-i]");
      if (li) {
        e.preventDefault();
        pickSuggestion(+li.dataset.i);
      }
    });
    search.addEventListener("blur", () => setTimeout(() => $("suggest").classList.add("hidden"), 100));
    $("addTarget").addEventListener("click", () => {
      if (!picked && suggestions.length && search.value.trim()) picked = suggestions[0];
      if (!picked) return;
      addTarget(picked.kind, picked.id, parseFloat($("targetQty").value));
      picked = null;
      search.value = "";
      $("targetQty").value = 1;
      search.focus();
    });
    $("targetQty").addEventListener("keydown", (e) => {
      if (e.key === "Enter") $("addTarget").click();
    });
    $("targets").addEventListener("change", (e) => {
      const i = e.target.dataset.qty;
      if (i == null) return;
      const v = parseFloat(e.target.value);
      if (v > 0) state.targets[+i].qty = v;
      else state.targets.splice(+i, 1);
      changed({ lists: false });
    });
    $("targets").addEventListener("click", (e) => {
      const i = e.target.closest("[data-remove]")?.dataset.remove;
      if (i == null) return;
      state.targets.splice(+i, 1);
      changed({ lists: false });
    });
    $("objective").addEventListener("change", (e) => {
      state.objective = e.target.value;
      changed({ lists: false });
    });

    document.addEventListener("click", (e) => {
      const el = e.target.closest("[data-item],[data-plan-item],[data-toggle-unlimited],[data-plan-research],[data-plan-building],[data-mark-research],[data-mark-buildings]");
      if (!el) return;
      const ds = el.dataset;
      if (ds.toggleUnlimited) {
        const id = ds.toggleUnlimited;
        if (state.unlimited.has(id)) state.unlimited.delete(id);
        else state.unlimited.add(id);
        changed();
        showItem(id);
      } else if (ds.planItem) {
        $("itemDialog").close();
        addTarget("item", ds.planItem, 1);
      } else if (ds.item) showItem(ds.item);
      else if (ds.planResearch) addTarget("research", ds.planResearch, 1);
      else if (ds.planBuilding) addTarget("building", ds.planBuilding, 1);
      else if (ds.markResearch) {
        ds.markResearch.split(",").forEach((id) => setResearch(id, true));
        changed();
      } else if (ds.markBuildings) {
        ds.markBuildings.split(",").forEach((id) => state.buildings.add(id));
        changed();
      }
    });

    let ioMode = "export";
    $("exportBtn").addEventListener("click", () => {
      ioMode = "export";
      $("ioTitle").textContent = "Your progress (copy to save or share)";
      $("ioText").value = JSON.stringify(serialise(), null, 1);
      $("ioApply").textContent = "Copy";
      $("ioDialog").showModal();
      $("ioText").select();
    });
    $("importBtn").addEventListener("click", () => {
      ioMode = "import";
      $("ioTitle").textContent = "Paste exported progress";
      $("ioText").value = "";
      $("ioApply").textContent = "Import";
      $("ioDialog").showModal();
    });
    $("ioApply").addEventListener("click", async () => {
      if (ioMode === "export") {
        try {
          await navigator.clipboard.writeText($("ioText").value);
          $("ioApply").textContent = "Copied";
        } catch (e) {
          $("ioText").select();
        }
        return;
      }
      try {
        applySaved(JSON.parse($("ioText").value));
        $("objective").value = state.objective;
        $("ioDialog").close();
        changed();
      } catch (e) {
        $("ioTitle").textContent = "That doesn't look like exported progress JSON";
      }
    });

    renderTargets();
    renderResearch();
    renderBuildings();
    renderUnlimited();
    schedulePlan();
  }

  init();
})();
