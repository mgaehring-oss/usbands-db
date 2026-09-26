"use strict";

const DB_PATH = "data/usbands.db";
const SQLJS_CDN = "https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/";

const els = {
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  seasonSelect: document.getElementById("season-select"),
  divisionFilter: document.getElementById("filter-division"),
  stateFilter: document.getElementById("filter-state"),
  finalsFilter: document.getElementById("filter-finals"),
  favoritesFilter: document.getElementById("filter-favorites"),
  searchFilter: document.getElementById("filter-search"),
  mybands: document.getElementById("mybands"),
  themeToggle: document.getElementById("theme-toggle"),
  themeToggleIcon: document.getElementById("theme-toggle-icon"),
  overlay: document.getElementById("detail-overlay"),
  overlayClose: document.getElementById("detail-close"),
  detailTitle: document.getElementById("detail-title"),
  detailTitleRow: document.getElementById("detail-title-row"),
  detailSub: document.getElementById("detail-sub"),
  detailChart: document.getElementById("detail-chart"),
  detailTableBody: document.getElementById("detail-table-body"),
};

/** In-memory model for the currently-selected season. Populated by
 * buildModelForSeason() against the db handle openDatabase() returns. */
const model = {
  seasonYear: null,
  allSeasons: [],                 // [year, ...] descending, every season in the db
  divisions: [],                 // [{id, class, group_number, label}] fixed order
  stateGroups: [],                // [{id, name}] kind='state', this season
  bandsByDivision: new Map(),      // division_id -> Set(unit_id)
  bandNames: new Map(),            // unit_id -> name
  historyByKey: new Map(),         // "unitId|divisionId" -> [{date,name,score,rank}] asc by date
  stateGroupsByBand: new Map(),    // unit_id -> Set(group_id)
  stateGroupNameById: new Map(),   // group_id -> name
  finalsByBand: new Set(),         // unit_id with any finals appearance this season
  favorites: new Set(),            // unit_id, persisted to localStorage
};

/* ---------------- Favorites ---------------- */

function loadFavorites() {
  try {
    const raw = safeLocalStorageGet("usbands-favorites");
    const list = raw ? JSON.parse(raw) : [];
    model.favorites = new Set(list);
  } catch {
    model.favorites = new Set();
  }
}

function saveFavorites() {
  safeLocalStorageSet("usbands-favorites", JSON.stringify([...model.favorites]));
}

function isFavorite(unitId) {
  return model.favorites.has(unitId);
}

function toggleFavorite(unitId) {
  if (model.favorites.has(unitId)) model.favorites.delete(unitId);
  else model.favorites.add(unitId);
  saveFavorites();
  renderAll();
  // renderAll() rebuilds the main table + My Bands, but the detail panel
  // (if open) is a separate DOM subtree it doesn't touch -- refresh its star.
  if (!els.overlay.hidden && currentDetailUnitId === unitId) {
    const existingStar = els.detailTitleRow.querySelector(".star-toggle");
    if (existingStar) existingStar.remove();
    els.detailTitleRow.appendChild(starButton(unitId, model.bandNames.get(unitId) || ""));
  }
}

let currentDetailUnitId = null;

function starButton(unitId, name) {
  const fav = isFavorite(unitId);
  const btn = el(
    "button",
    {
      type: "button",
      class: "star-toggle",
      "aria-pressed": String(fav),
      "aria-label": `${fav ? "Unfavorite" : "Favorite"} ${name}`,
    },
    [fav ? "★" : "☆"]
  );
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleFavorite(unitId);
  });
  return btn;
}

function queryAll(db, sql, params) {
  const stmt = db.prepare(sql);
  if (params) stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

/** Fetches the db file once and opens it; the handle is kept open for the
 * whole session (see main()) so switching seasons is a re-query against
 * already-in-memory data, never a re-fetch over the network. */
async function openDatabase() {
  const SQL = await initSqlJs({ locateFile: (f) => SQLJS_CDN + f });
  const buf = await fetch(DB_PATH).then((r) => {
    if (!r.ok) throw new Error(`Could not load ${DB_PATH} (${r.status})`);
    return r.arrayBuffer();
  });
  return new SQL.Database(new Uint8Array(buf));
}

/** Populates `model` for one season, scoped strictly to that season's rows
 * -- e.g. `scores` is joined to `events` and filtered by season_year, since
 * without that a band's Latest/Prior/history would silently blend scores
 * across season boundaries once the db holds more than one season. */
function buildModelForSeason(db, year) {
  model.seasonYear = year;
  model.divisions = queryAll(db, "SELECT id, class, group_number, label FROM divisions ORDER BY id");

  model.stateGroups = queryAll(
    db,
    "SELECT id, name FROM championship_groups WHERE season_year = ? AND kind = 'state' ORDER BY name",
    [year]
  );
  model.stateGroupNameById = new Map(model.stateGroups.map((g) => [g.id, g.name]));

  model.bandNames = new Map();
  for (const row of queryAll(db, "SELECT unit_id, name FROM bands")) {
    model.bandNames.set(row.unit_id, row.name);
  }

  model.bandsByDivision = new Map();
  for (const row of queryAll(
    db,
    "SELECT unit_id, division_id FROM band_season_division WHERE season_year = ?",
    [year]
  )) {
    if (!model.bandsByDivision.has(row.division_id)) model.bandsByDivision.set(row.division_id, new Set());
    model.bandsByDivision.get(row.division_id).add(row.unit_id);
  }

  model.stateGroupsByBand = new Map();
  for (const row of queryAll(
    db,
    "SELECT unit_id, championship_group_id FROM band_season_state_championship WHERE season_year = ?",
    [year]
  )) {
    if (!model.stateGroupsByBand.has(row.unit_id)) model.stateGroupsByBand.set(row.unit_id, new Set());
    model.stateGroupsByBand.get(row.unit_id).add(row.championship_group_id);
  }

  model.finalsByBand = new Set();
  for (const row of queryAll(
    db,
    "SELECT DISTINCT unit_id FROM band_season_final WHERE season_year = ?",
    [year]
  )) {
    model.finalsByBand.add(row.unit_id);
  }

  model.historyByKey = new Map();
  const scoreRows = queryAll(
    db,
    `SELECT s.event_id, s.unit_id, s.division_id, s.score, s.rank, e.event_date, e.name AS event_name
     FROM scores s JOIN events e ON e.id = s.event_id
     WHERE e.season_year = ?`,
    [year]
  );
  const grouped = new Map();
  for (const row of scoreRows) {
    const key = `${row.unit_id}|${row.division_id}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({
      date: row.event_date,
      name: row.event_name,
      score: row.score,
      rank: row.rank,
    });
  }
  for (const [key, list] of grouped) {
    list.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    model.historyByKey.set(key, list);
  }
}

function historyFor(unitId, divisionId) {
  return model.historyByKey.get(`${unitId}|${divisionId}`) || [];
}

function computeRows(division, opts) {
  const roster = model.bandsByDivision.get(division.id) || new Set();
  const rows = [];
  for (const unitId of roster) {
    const history = historyFor(unitId, division.id);
    const stateGroups = model.stateGroupsByBand.get(unitId) || new Set();
    const isFinals = model.finalsByBand.has(unitId);

    if (opts.stateGroupId !== "all" && !stateGroups.has(opts.stateGroupId)) continue;
    if (opts.finalsOnly && !isFinals) continue;
    const name = model.bandNames.get(unitId) || `Unit ${unitId}`;
    if (opts.search && !name.toLowerCase().includes(opts.search)) continue;

    const latest = history.length ? history[history.length - 1] : null;
    const prior = history.length > 1 ? history[history.length - 2] : null;
    const delta = latest && prior ? round1(latest.score - prior.score) : null;

    rows.push({
      unitId,
      name,
      history,
      latest,
      prior,
      delta,
      stateGroups,
      isFinals,
    });
  }

  // Rank by latest score, descending; ties share a rank (1224 style); no-score rows unranked.
  rows.sort((a, b) => {
    const as = a.latest ? a.latest.score : -Infinity;
    const bs = b.latest ? b.latest.score : -Infinity;
    if (as !== bs) return bs - as;
    return a.name.localeCompare(b.name);
  });
  let rank = 0;
  let lastScore = null;
  rows.forEach((row, i) => {
    if (!row.latest) {
      row.rank = null;
      return;
    }
    if (row.latest.score !== lastScore) {
      rank = i + 1;
      lastScore = row.latest.score;
    }
    row.rank = rank;
  });

  // Favorites-only is a pure display filter applied AFTER ranking, so the
  // rank shown always reflects the real (division/state/finals) field --
  // ranking only among a handful of arbitrarily-starred bands would be
  // meaningless as a competitive number.
  if (opts.favoritesOnly) return rows.filter((r) => isFavorite(r.unitId));
  return rows;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function fmtScore(n) {
  return n === null || n === undefined ? "—" : n.toFixed(1);
}

function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  return `${m}/${d}`;
}

function rankColumnLabel(opts) {
  if (opts.stateGroupId !== "all") return `${model.stateGroupNameById.get(opts.stateGroupId)} Rank`;
  if (opts.finalsOnly) return "Finals Rank";
  return "Rank";
}

function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") node.className = v;
      else if (k === "html") node.innerHTML = v;
      else node.setAttribute(k, v);
    }
  }
  for (const child of children || []) {
    if (child === null || child === undefined) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

function sparklineSVG(history) {
  const w = 70, h = 24, pad = 3;
  if (history.length < 2) {
    return `<svg class="sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"></svg>`;
  }
  const scores = history.map((p) => p.score);
  const min = Math.min(...scores), max = Math.max(...scores);
  const range = max - min || 1;
  const stepX = (w - pad * 2) / (history.length - 1);
  const pts = history.map((p, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((p.score - min) / range) * (h - pad * 2);
    return [x, y];
  });
  const d = pts.map((p, i) => (i === 0 ? `M${p[0]},${p[1]}` : `L${p[0]},${p[1]}`)).join(" ");
  const last = pts[pts.length - 1];
  return `<svg class="sparkline" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <path d="${d}"></path>
    <circle cx="${last[0]}" cy="${last[1]}" r="2.5"></circle>
  </svg>`;
}

function deltaCell(delta) {
  if (delta === null || delta === undefined) return el("span", { class: "delta delta--none" }, ["—"]);
  if (delta > 0) return el("span", { class: "delta delta--up" }, [`▲ ${delta.toFixed(1)}`]);
  if (delta < 0) return el("span", { class: "delta delta--down" }, [`▼ ${Math.abs(delta).toFixed(1)}`]);
  return el("span", { class: "delta delta--flat" }, ["— 0.0"]);
}

function rankBadge(rank) {
  if (rank === null) return el("span", { class: "rank-badge" }, ["—"]);
  const cls = rank <= 3 ? ` rank-badge--${rank}` : "";
  return el("span", { class: `rank-badge${cls}` }, [String(rank)]);
}

function currentFilterOpts() {
  return {
    divisionId: els.divisionFilter.value,
    stateGroupId: els.stateFilter.value === "all" ? "all" : Number(els.stateFilter.value),
    finalsOnly: els.finalsFilter.checked,
    favoritesOnly: els.favoritesFilter.checked,
    search: els.searchFilter.value.trim().toLowerCase(),
  };
}

function render() {
  const opts = currentFilterOpts();
  const showTagsColumn = opts.stateGroupId === "all" || !opts.finalsOnly;
  const divisionsToShow =
    opts.divisionId === "all" ? model.divisions : model.divisions.filter((d) => String(d.id) === opts.divisionId);

  els.results.innerHTML = "";
  let anyRows = false;

  for (const division of divisionsToShow) {
    const rows = computeRows(division, opts);
    if (rows.length === 0) continue;
    anyRows = true;

    const section = el("section", { class: "division-section" }, [
      el("div", { class: "division-section__head" }, [
        el("h2", {}, [division.label]),
        el("span", { class: "division-section__count" }, [`${rows.length} band${rows.length === 1 ? "" : "s"}`]),
      ]),
    ]);

    const table = el("table", { class: "leaderboard" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { class: "star-col" }, ["★"]),
          el("th", {}, [rankColumnLabel(opts)]),
          el("th", {}, ["Band"]),
          el("th", { class: "num" }, ["Latest"]),
          el("th", { class: "num" }, ["Prior"]),
          el("th", { class: "num" }, ["Δ"]),
          el("th", {}, ["History"]),
          opts.stateGroupId === "all" || !opts.finalsOnly ? el("th", {}, ["Tags"]) : null,
        ]),
      ]),
    ]);

    const tbody = el("tbody", {}, []);
    for (const row of rows) {
      const tagsChildren = [];
      if (opts.stateGroupId === "all") {
        for (const gid of row.stateGroups) {
          tagsChildren.push(el("span", { class: "badge" }, [model.stateGroupNameById.get(gid) || ""]));
        }
      }
      if (row.isFinals) tagsChildren.push(el("span", { class: "badge badge--finals" }, ["Finals"]));

      const tr = el("tr", { tabindex: "0", class: isFavorite(row.unitId) ? "is-favorite" : "" }, [
        el("td", { class: "star-col" }, [starButton(row.unitId, row.name)]),
        el("td", {}, [rankBadge(row.rank)]),
        el("td", {}, [el("span", { class: "band-name" }, [row.name])]),
        el("td", { class: "num" }, [fmtScore(row.latest && row.latest.score)]),
        el("td", { class: "num" }, [fmtScore(row.prior && row.prior.score)]),
        el("td", { class: "num" }, [deltaCell(row.delta)]),
        el("td", { html: sparklineSVG(row.history) }, []),
        showTagsColumn ? el("td", {}, tagsChildren) : null,
      ]);
      tr.addEventListener("click", () => openDetail(row, division));
      tr.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openDetail(row, division);
        }
      });
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    section.appendChild(el("div", { class: "table-scroll" }, [table]));
    els.results.appendChild(section);
  }

  if (!anyRows) {
    els.results.appendChild(el("div", { class: "empty-note" }, ["No bands match the current filters."]));
  }
}

/* ---------------- My Bands (pinned favorites summary) ---------------- */

function renderMyBands() {
  els.mybands.innerHTML = "";
  if (model.favorites.size === 0) return;

  const unfiltered = { stateGroupId: "all", finalsOnly: false, favoritesOnly: false, search: "" };
  const found = [];

  // Always rank against the FULL division roster, independent of whatever
  // the main leaderboard's filters are currently set to.
  for (const division of model.divisions) {
    const roster = model.bandsByDivision.get(division.id);
    if (!roster || ![...model.favorites].some((uid) => roster.has(uid))) continue;
    for (const row of computeRows(division, unfiltered)) {
      if (isFavorite(row.unitId)) found.push({ row, division });
    }
  }

  if (found.length === 0) return;
  found.sort((a, b) => a.row.name.localeCompare(b.row.name));

  const section = el("section", { class: "division-section mybands-section" }, [
    el("div", { class: "division-section__head" }, [
      el("h2", {}, ["★ My Bands"]),
      el("span", { class: "division-section__count" }, [`${found.length} favorited`]),
    ]),
  ]);

  const table = el("table", { class: "leaderboard" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { class: "star-col" }, ["★"]),
        el("th", {}, ["Rank"]),
        el("th", {}, ["Band"]),
        el("th", {}, ["Group"]),
        el("th", { class: "num" }, ["Latest"]),
        el("th", { class: "num" }, ["Prior"]),
        el("th", { class: "num" }, ["Δ"]),
        el("th", {}, ["History"]),
      ]),
    ]),
  ]);

  const tbody = el("tbody", {}, []);
  for (const { row, division } of found) {
    const tr = el("tr", { tabindex: "0", class: "is-favorite" }, [
      el("td", { class: "star-col" }, [starButton(row.unitId, row.name)]),
      el("td", {}, [rankBadge(row.rank)]),
      el("td", {}, [el("span", { class: "band-name" }, [row.name])]),
      el("td", {}, [division.label]),
      el("td", { class: "num" }, [fmtScore(row.latest && row.latest.score)]),
      el("td", { class: "num" }, [fmtScore(row.prior && row.prior.score)]),
      el("td", { class: "num" }, [deltaCell(row.delta)]),
      el("td", { html: sparklineSVG(row.history) }, []),
    ]);
    tr.addEventListener("click", () => openDetail(row, division));
    tr.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        openDetail(row, division);
      }
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  section.appendChild(el("div", { class: "table-scroll" }, [table]));
  els.mybands.appendChild(section);
}

function renderAll() {
  renderMyBands();
  render();
}

/* ---------------- Detail chart ---------------- */

let activeTooltip = null;

function buildChart(history) {
  const width = 640, height = 220;
  const padL = 34, padR = 16, padT = 16, padB = 26;
  const innerW = width - padL - padR, innerH = height - padT - padB;

  const scores = history.map((p) => p.score);
  const min = Math.min(...scores), max = Math.max(...scores);
  const lo = Math.floor((min - 1) * 2) / 2;
  const hi = Math.ceil((max + 1) * 2) / 2;
  const range = hi - lo || 1;

  const stepX = history.length > 1 ? innerW / (history.length - 1) : 0;
  const xy = history.map((p, i) => ({
    x: padL + i * stepX,
    y: padT + innerH - ((p.score - lo) / range) * innerH,
    point: p,
  }));

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Score history line chart");

  // gridlines + y ticks (min/mid/max)
  [lo, (lo + hi) / 2, hi].forEach((val) => {
    const y = padT + innerH - ((val - lo) / range) * innerH;
    const line = document.createElementNS(ns, "line");
    line.setAttribute("x1", padL);
    line.setAttribute("x2", width - padR);
    line.setAttribute("y1", y);
    line.setAttribute("y2", y);
    line.setAttribute("class", "chart-gridline");
    svg.appendChild(line);

    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", padL - 6);
    label.setAttribute("y", y + 3);
    label.setAttribute("text-anchor", "end");
    label.setAttribute("class", "chart-axis-label");
    label.textContent = val.toFixed(1);
    svg.appendChild(label);
  });

  // x labels (sparse: first, last, and a few in between)
  const labelEvery = Math.max(1, Math.ceil(history.length / 6));
  xy.forEach((p, i) => {
    if (i % labelEvery !== 0 && i !== xy.length - 1) return;
    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", p.x);
    label.setAttribute("y", height - 6);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "chart-axis-label");
    label.textContent = fmtDate(p.point.date);
    svg.appendChild(label);
  });

  // line
  const d = xy.map((p, i) => (i === 0 ? `M${p.x},${p.y}` : `L${p.x},${p.y}`)).join(" ");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  path.setAttribute("class", "chart-line");
  svg.appendChild(path);

  const container = el("div", { style: "position:relative" }, []);

  // crosshair (hidden until hover)
  const crosshair = document.createElementNS(ns, "line");
  crosshair.setAttribute("y1", padT);
  crosshair.setAttribute("y2", height - padB);
  crosshair.setAttribute("class", "chart-crosshair");
  crosshair.style.opacity = "0";
  svg.appendChild(crosshair);

  const tooltip = el("div", { class: "chart-tooltip" }, []);

  // dots + hit targets
  xy.forEach((p) => {
    const dot = document.createElementNS(ns, "circle");
    dot.setAttribute("cx", p.x);
    dot.setAttribute("cy", p.y);
    dot.setAttribute("r", 4);
    dot.setAttribute("class", "chart-dot");
    svg.appendChild(dot);

    const hit = document.createElementNS(ns, "circle");
    hit.setAttribute("cx", p.x);
    hit.setAttribute("cy", p.y);
    hit.setAttribute("r", 14);
    hit.setAttribute("fill", "transparent");
    hit.style.cursor = "pointer";
    hit.tabIndex = 0;
    const show = () => {
      crosshair.setAttribute("x1", p.x);
      crosshair.setAttribute("x2", p.x);
      crosshair.style.opacity = "1";
      dot.classList.add("is-active");
      tooltip.textContent = "";
      const strong = el("strong", {}, [`${p.point.score.toFixed(1)}`]);
      tooltip.appendChild(strong);
      tooltip.appendChild(document.createTextNode(` — ${p.point.name} (${p.point.date})`));
      tooltip.style.left = `${(p.x / width) * 100}%`;
      tooltip.style.top = `${(p.y / height) * 100}%`;
      tooltip.classList.add("is-visible");
    };
    const hide = () => {
      crosshair.style.opacity = "0";
      dot.classList.remove("is-active");
      tooltip.classList.remove("is-visible");
    };
    hit.addEventListener("mouseenter", show);
    hit.addEventListener("mouseleave", hide);
    hit.addEventListener("focus", show);
    hit.addEventListener("blur", hide);
    svg.appendChild(hit);
  });

  container.appendChild(svg);
  container.appendChild(tooltip);
  return container;
}

function openDetail(row, division) {
  currentDetailUnitId = row.unitId;
  els.detailTitle.textContent = row.name;
  const existingStar = els.detailTitleRow.querySelector(".star-toggle");
  if (existingStar) existingStar.remove();
  els.detailTitleRow.appendChild(starButton(row.unitId, row.name));
  els.detailSub.textContent = `${division.label} — score history`;

  els.detailChart.innerHTML = "";
  if (row.history.length >= 2) {
    els.detailChart.appendChild(buildChart(row.history));
  } else {
    els.detailChart.appendChild(el("p", { class: "empty-note" }, ["Not enough data yet for a chart."]));
  }

  els.detailTableBody.innerHTML = "";
  for (const p of [...row.history].reverse()) {
    els.detailTableBody.appendChild(
      el("tr", {}, [
        el("td", {}, [p.date || ""]),
        el("td", {}, [p.name]),
        el("td", { class: "num" }, [fmtScore(p.score)]),
        el("td", { class: "num" }, [p.rank !== null && p.rank !== undefined ? String(p.rank) : "—"]),
      ])
    );
  }

  els.overlay.hidden = false;
}

function closeDetail() {
  els.overlay.hidden = true;
}

/* ---------------- Filters setup ---------------- */

function populateFilters() {
  els.divisionFilter.innerHTML = "";
  els.divisionFilter.appendChild(el("option", { value: "all" }, ["All groups"]));
  for (const d of model.divisions) {
    els.divisionFilter.appendChild(el("option", { value: String(d.id) }, [d.label]));
  }

  els.stateFilter.innerHTML = "";
  els.stateFilter.appendChild(el("option", { value: "all" }, ["All states"]));
  for (const g of model.stateGroups) {
    els.stateFilter.appendChild(el("option", { value: String(g.id) }, [g.name]));
  }
}

/** Division/state IDs are season-scoped, so a selection from the previous
 * season would silently point at the wrong (or no) group after switching --
 * reset to defaults whenever the season changes. */
function resetFilterControls() {
  els.divisionFilter.value = "all";
  els.stateFilter.value = "all";
  els.finalsFilter.checked = false;
  els.favoritesFilter.checked = false;
  els.searchFilter.value = "";
}

function populateSeasonSelect() {
  els.seasonSelect.innerHTML = "";
  for (const year of model.allSeasons) {
    els.seasonSelect.appendChild(el("option", { value: String(year) }, [`Season ${year}`]));
  }
  els.seasonSelect.value = String(model.seasonYear);
}

/* ---------------- Theme toggle ---------------- */

function initTheme() {
  const stored = safeLocalStorageGet("usbands-theme");
  if (stored === "light" || stored === "dark") applyTheme(stored);
  updateThemeIcon();
}

function applyTheme(theme) {
  if (theme) document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");
  safeLocalStorageSet("usbands-theme", theme || "");
  updateThemeIcon();
}

function updateThemeIcon() {
  const current = document.documentElement.getAttribute("data-theme");
  const isDark = current === "dark" || (!current && matchMedia("(prefers-color-scheme: dark)").matches);
  els.themeToggleIcon.textContent = isDark ? "☀" : "☽";
}

function safeLocalStorageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function safeLocalStorageSet(key, val) {
  try { localStorage.setItem(key, val); } catch { /* ignore */ }
}

/* ---------------- Init ---------------- */

let dbHandle = null;

async function main() {
  initTheme();
  els.themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const isDark = current === "dark" || (!current && matchMedia("(prefers-color-scheme: dark)").matches);
    applyTheme(isDark ? "light" : "dark");
  });

  els.overlayClose.addEventListener("click", closeDetail);
  els.overlay.addEventListener("click", (e) => {
    if (e.target === els.overlay) closeDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetail();
  });

  for (const control of [els.divisionFilter, els.stateFilter, els.finalsFilter, els.favoritesFilter]) {
    control.addEventListener("change", render);
  }
  els.searchFilter.addEventListener("input", render);

  els.seasonSelect.addEventListener("change", () => {
    const year = Number(els.seasonSelect.value);
    buildModelForSeason(dbHandle, year);
    resetFilterControls();
    populateFilters();
    renderAll();
  });

  loadFavorites();

  try {
    dbHandle = await openDatabase();
  } catch (err) {
    els.status.textContent = `Couldn't load the database: ${err.message}`;
    els.status.classList.add("error");
    return;
  }

  model.allSeasons = queryAll(dbHandle, "SELECT year FROM seasons ORDER BY year DESC").map((r) => r.year);
  const defaultYear = model.allSeasons[0];
  buildModelForSeason(dbHandle, defaultYear);
  populateSeasonSelect();
  populateFilters();
  els.status.hidden = true;
  renderAll();
}

main();
