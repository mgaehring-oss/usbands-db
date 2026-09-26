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
  themeColorToggle: document.getElementById("theme-color-toggle"),
  themeColorPanel: document.getElementById("theme-color-panel"),
  themePrimaryInput: document.getElementById("theme-primary-input"),
  themeAccentInput: document.getElementById("theme-accent-input"),
  themePresets: document.getElementById("theme-presets"),
  themeResetButton: document.getElementById("theme-reset"),
  overlay: document.getElementById("detail-overlay"),
  overlayClose: document.getElementById("detail-close"),
  detailTitle: document.getElementById("detail-title"),
  detailTitleRow: document.getElementById("detail-title-row"),
  detailSub: document.getElementById("detail-sub"),
  detailChart: document.getElementById("detail-chart"),
  detailChartCaption: document.getElementById("detail-chart-caption"),
  detailModeSeason: document.getElementById("detail-mode-season"),
  detailModeAll: document.getElementById("detail-mode-all"),
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

function buildChart(points) {
  const width = 640, height = 220;
  const padL = 34, padR = 16, padT = 28, padB = 26;
  const innerW = width - padL - padR, innerH = height - padT - padB;

  const scores = points.map((p) => p.score);
  const min = Math.min(...scores), max = Math.max(...scores);
  const lo = Math.floor((min - 1) * 2) / 2;
  const hi = Math.ceil((max + 1) * 2) / 2;
  const range = hi - lo || 1;

  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const xy = points.map((p, i) => ({
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
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));
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

  // Season labels: always label the first point (so a single-season chart
  // still says which season it is); a divider + label marks an actual
  // season transition, relevant once "All Seasons" spans multiple years.
  xy.forEach((p, i) => {
    const isFirst = i === 0;
    const changed = i > 0 && p.point.seasonYear !== xy[i - 1].point.seasonYear;
    if (!isFirst && !changed) return;
    if (changed) {
      const divider = document.createElementNS(ns, "line");
      divider.setAttribute("x1", p.x);
      divider.setAttribute("x2", p.x);
      divider.setAttribute("y1", padT - 6);
      divider.setAttribute("y2", height - padB);
      divider.setAttribute("class", "chart-season-divider");
      svg.appendChild(divider);
    }
    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", p.x);
    label.setAttribute("y", padT - 12);
    label.setAttribute("text-anchor", isFirst ? "start" : "middle");
    label.setAttribute("class", "chart-season-label");
    label.textContent = String(p.point.seasonYear);
    svg.appendChild(label);
  });

  // Line, drawn as one path per segment so a division change (a band moving
  // groups, sometimes mid-season) can be flagged with a dashed segment right
  // at the transition -- more precise than a generic divider, and it's the
  // specific edge where two scores stop being directly comparable.
  let hasDivisionChange = false;
  for (let i = 1; i < xy.length; i++) {
    const a = xy[i - 1], b = xy[i];
    const changed = a.point.divisionId !== b.point.divisionId;
    if (changed) hasDivisionChange = true;
    const seg = document.createElementNS(ns, "path");
    seg.setAttribute("d", `M${a.x},${a.y} L${b.x},${b.y}`);
    seg.setAttribute("class", changed ? "chart-line is-division-change" : "chart-line");
    svg.appendChild(seg);
  }

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
      tooltip.appendChild(
        document.createTextNode(` — ${p.point.name} (${p.point.date}), ${p.point.divisionLabel}`)
      );
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
  return { chart: container, hasDivisionChange };
}

let currentDetailMode = "season"; // "season" | "all"
let currentDetailDivisionLabel = null;
let currentDetailSeasonPoints = null;
let currentDetailAllPoints = null; // lazily fetched on first switch to "all", cached per open band

function openDetail(row, division) {
  currentDetailUnitId = row.unitId;
  currentDetailMode = "season";
  currentDetailDivisionLabel = division.label;
  currentDetailAllPoints = null;
  currentDetailSeasonPoints = row.history.map((p) => ({
    ...p,
    seasonYear: model.seasonYear,
    divisionId: division.id,
    divisionLabel: division.label,
  }));

  els.detailTitle.textContent = row.name;
  const existingStar = els.detailTitleRow.querySelector(".star-toggle");
  if (existingStar) existingStar.remove();
  els.detailTitleRow.appendChild(starButton(row.unitId, row.name));

  updateDetailModeButtons();
  renderDetailBody();
  els.overlay.hidden = false;
}

function updateDetailModeButtons() {
  els.detailModeSeason.classList.toggle("is-active", currentDetailMode === "season");
  els.detailModeAll.classList.toggle("is-active", currentDetailMode === "all");
}

function setDetailMode(mode) {
  if (mode === currentDetailMode) return;
  if (mode === "all" && !currentDetailAllPoints) {
    currentDetailAllPoints = queryAll(
      dbHandle,
      `SELECT e.season_year AS seasonYear, e.event_date AS date, e.name AS name,
              d.id AS divisionId, d.label AS divisionLabel, s.score, s.rank
       FROM scores s
       JOIN events e ON e.id = s.event_id
       JOIN divisions d ON d.id = s.division_id
       WHERE s.unit_id = ?
       ORDER BY e.event_date`,
      [currentDetailUnitId]
    );
  }
  currentDetailMode = mode;
  updateDetailModeButtons();
  renderDetailBody();
}

function renderDetailBody() {
  const points = currentDetailMode === "all" ? currentDetailAllPoints : currentDetailSeasonPoints;

  els.detailSub.textContent =
    currentDetailMode === "all" ? "All seasons — score history" : `${currentDetailDivisionLabel} — score history`;

  els.detailChart.innerHTML = "";
  els.detailChartCaption.hidden = true;
  if (points.length >= 2) {
    const { chart, hasDivisionChange } = buildChart(points);
    els.detailChart.appendChild(chart);
    els.detailChartCaption.hidden = !hasDivisionChange;
  } else {
    els.detailChart.appendChild(el("p", { class: "empty-note" }, ["Not enough data yet for a chart."]));
  }

  els.detailTableBody.innerHTML = "";
  for (const p of [...points].reverse()) {
    els.detailTableBody.appendChild(
      el("tr", {}, [
        el("td", {}, [p.date || ""]),
        el("td", {}, [p.name]),
        el("td", {}, [String(p.seasonYear)]),
        el("td", {}, [p.divisionLabel]),
        el("td", { class: "num" }, [fmtScore(p.score)]),
        el("td", { class: "num" }, [p.rank !== null && p.rank !== undefined ? String(p.rank) : "—"]),
      ])
    );
  }
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

/* ---------------- Custom brand colors (Primary/Accent) ---------------- */

// Fixed lightness steps per token, measured from the hand-tuned default
// green/gold palette in style.css. Keeping these FIXED -- never derived
// from the user's input lightness -- is what keeps an arbitrary picked
// color legible: a pure black/white/neon pick still produces a usable ramp,
// because lightness is always overridden, not adjusted from. Hue and
// saturation are kept as the user picked them.
const PRIMARY_LIGHTNESS = {
  light: { 900: 12.7, 700: 23.7, 600: 27.6, 500: 37.3, 100: 92.2 },
  dark: { 900: 12.7, 700: 32.2, 600: 39.4, 500: 49.2, 100: 11.8 },
};
const ACCENT_LIGHTNESS = {
  light: { 700: 32.4, 500: 46.1, 200: 79.0 },
  dark: { 700: 60.0, 500: 46.1, 200: 16.1 },
};

const DEFAULT_THEME_COLORS = { primary: "#1b5e3b", accent: "#d4a017" };

const THEME_PRESETS = [
  { name: "Green & Gold", primary: "#1b5e3b", accent: "#d4a017" },
  { name: "Navy & Gold", primary: "#122a52", accent: "#c9a227" },
  { name: "Maroon & White", primary: "#6e1423", accent: "#e5e5e5" },
  { name: "Red & Black", primary: "#a4161a", accent: "#262626" },
  { name: "Blue & Silver", primary: "#1a4f8b", accent: "#b0b7bd" },
  { name: "Purple & Gold", primary: "#4b2e83", accent: "#d4a017" },
];

function hexToRgb(hex) {
  const full = hex.replace("#", "").trim();
  const n = parseInt(full.length === 3 ? full.split("").map((c) => c + c).join("") : full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function rgbToHueSat(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0 };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  switch (max) {
    case r: h = (g - b) / d + (g < b ? 6 : 0); break;
    case g: h = (b - r) / d + 2; break;
    default: h = (r - g) / d + 4;
  }
  return { h: h * 60, s: s * 100 };
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(100, s)) / 100;
  l = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rgb;
  if (h < 60) rgb = [c, x, 0];
  else if (h < 120) rgb = [x, c, 0];
  else if (h < 180) rgb = [0, c, x];
  else if (h < 240) rgb = [0, x, c];
  else if (h < 300) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const toHex = (v) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`;
}

function deriveRamp(hex, lightnessSteps) {
  const { r, g, b } = hexToRgb(hex);
  const { h, s } = rgbToHueSat(r, g, b);
  const out = {};
  for (const step of Object.keys(lightnessSteps)) {
    out[step] = hslToHex(h, s, lightnessSteps[step]);
  }
  return out;
}

function buildThemeCSS(primaryHex, accentHex) {
  const pLight = deriveRamp(primaryHex, PRIMARY_LIGHTNESS.light);
  const pDark = deriveRamp(primaryHex, PRIMARY_LIGHTNESS.dark);
  const aLight = deriveRamp(accentHex, ACCENT_LIGHTNESS.light);
  const aDark = deriveRamp(accentHex, ACCENT_LIGHTNESS.dark);

  const vars = (p, a) =>
    `--brand-green-900: ${p[900]}; --brand-green-700: ${p[700]}; --brand-green-600: ${p[600]}; ` +
    `--brand-green-500: ${p[500]}; --brand-green-100: ${p[100]}; ` +
    `--brand-gold-700: ${a[700]}; --brand-gold-500: ${a[500]}; --brand-gold-200: ${a[200]};`;

  return (
    `:root { ${vars(pLight, aLight)} --focus-ring: ${pLight[500]}; }\n` +
    `@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { ${vars(pDark, aDark)} } }\n` +
    `:root[data-theme="dark"] { ${vars(pDark, aDark)} }`
  );
}

function applyCustomTheme(primaryHex, accentHex, { persist = true } = {}) {
  let styleEl = document.getElementById("custom-theme");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = "custom-theme";
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = buildThemeCSS(primaryHex, accentHex);
  if (persist) safeLocalStorageSet("usbands-theme-colors", JSON.stringify({ primary: primaryHex, accent: accentHex }));
  if (els.themePrimaryInput) els.themePrimaryInput.value = primaryHex;
  if (els.themeAccentInput) els.themeAccentInput.value = accentHex;
}

function resetCustomTheme() {
  const styleEl = document.getElementById("custom-theme");
  if (styleEl) styleEl.remove();
  safeLocalStorageSet("usbands-theme-colors", "");
  if (els.themePrimaryInput) els.themePrimaryInput.value = DEFAULT_THEME_COLORS.primary;
  if (els.themeAccentInput) els.themeAccentInput.value = DEFAULT_THEME_COLORS.accent;
}

function loadSavedCustomTheme() {
  const raw = safeLocalStorageGet("usbands-theme-colors");
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    if (saved && saved.primary && saved.accent) applyCustomTheme(saved.primary, saved.accent, { persist: false });
  } catch {
    /* ignore corrupt value */
  }
}

function populateThemePresets() {
  if (!els.themePresets) return;
  els.themePresets.innerHTML = "";
  for (const preset of THEME_PRESETS) {
    const swatch = el(
      "button",
      {
        type: "button",
        class: "preset-swatch",
        title: preset.name,
        "aria-label": preset.name,
        style: `background: linear-gradient(135deg, ${preset.primary} 50%, ${preset.accent} 50%);`,
      },
      []
    );
    swatch.addEventListener("click", () => applyCustomTheme(preset.primary, preset.accent));
    els.themePresets.appendChild(swatch);
  }
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
  loadSavedCustomTheme();
  els.themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const isDark = current === "dark" || (!current && matchMedia("(prefers-color-scheme: dark)").matches);
    applyTheme(isDark ? "light" : "dark");
  });

  populateThemePresets();
  let savedColors = null;
  try {
    savedColors = JSON.parse(safeLocalStorageGet("usbands-theme-colors") || "null");
  } catch {
    /* ignore corrupt value */
  }
  els.themePrimaryInput.value = (savedColors || DEFAULT_THEME_COLORS).primary;
  els.themeAccentInput.value = (savedColors || DEFAULT_THEME_COLORS).accent;
  const applyFromInputs = () => applyCustomTheme(els.themePrimaryInput.value, els.themeAccentInput.value);
  els.themePrimaryInput.addEventListener("input", applyFromInputs);
  els.themeAccentInput.addEventListener("input", applyFromInputs);
  els.themeResetButton.addEventListener("click", resetCustomTheme);
  els.themeColorToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    els.themeColorPanel.hidden = !els.themeColorPanel.hidden;
  });
  document.addEventListener("click", (e) => {
    if (!els.themeColorPanel.hidden && !els.themeColorPanel.contains(e.target) && e.target !== els.themeColorToggle) {
      els.themeColorPanel.hidden = true;
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") els.themeColorPanel.hidden = true;
  });

  els.overlayClose.addEventListener("click", closeDetail);
  els.overlay.addEventListener("click", (e) => {
    if (e.target === els.overlay) closeDetail();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetail();
  });
  els.detailModeSeason.addEventListener("click", () => setDetailMode("season"));
  els.detailModeAll.addEventListener("click", () => setDetailMode("all"));

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
