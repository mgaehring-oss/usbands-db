"use strict";

const DB_PATH = "data/usbands.db";
const SQLJS_CDN = "https://cdn.jsdelivr.net/npm/sql.js@1.10.3/dist/";

const els = {
  status: document.getElementById("status"),
  results: document.getElementById("results"),
  resultsSummary: document.getElementById("results-summary"),
  seasonSelect: document.getElementById("season-select"),
  divisionFilter: document.getElementById("filter-division"),
  stateFilter: document.getElementById("filter-state"),
  homeStateFilter: document.getElementById("filter-home-state"),
  finalsFilter: document.getElementById("filter-finals"),
  favoritesFilter: document.getElementById("filter-favorites"),
  searchFilter: document.getElementById("filter-search"),
  mybands: document.getElementById("mybands"),
  lastUpdated: document.getElementById("last-updated"),
  installBanner: document.getElementById("install-banner"),
  installBannerText: document.getElementById("install-banner-text"),
  installBtn: document.getElementById("install-btn"),
  installDismiss: document.getElementById("install-dismiss"),
  installIconBtn: document.getElementById("install-icon-btn"),
  offlineBanner: document.getElementById("offline-banner"),
  dataUpdateBanner: document.getElementById("data-update-banner"),
  dataUpdateRefresh: document.getElementById("data-update-refresh"),
  dataUpdateDismiss: document.getElementById("data-update-dismiss"),
  appUpdateBanner: document.getElementById("app-update-banner"),
  appUpdateRefresh: document.getElementById("app-update-refresh"),
  appUpdateDismiss: document.getElementById("app-update-dismiss"),
  themeToggle: document.getElementById("theme-toggle"),
  themeToggleIcon: document.getElementById("theme-toggle-icon"),
  themeColorToggle: document.getElementById("theme-color-toggle"),
  themeColorPanel: document.getElementById("theme-color-panel"),
  themePrimaryInput: document.getElementById("theme-primary-input"),
  themeAccentInput: document.getElementById("theme-accent-input"),
  themePresets: document.getElementById("theme-presets"),
  themeResetButton: document.getElementById("theme-reset"),
  themeColorMeta: document.querySelector('meta[name="theme-color"]'),
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
  compareOverlay: document.getElementById("compare-overlay"),
  compareClose: document.getElementById("compare-close"),
  compareSub: document.getElementById("compare-sub"),
  compareLegend: document.getElementById("compare-legend"),
  compareChart: document.getElementById("compare-chart"),
  compareTableBody: document.getElementById("compare-table-body"),
  trendsOpen: document.getElementById("trends-open"),
  trendsOverlay: document.getElementById("trends-overlay"),
  trendsClose: document.getElementById("trends-close"),
  trendsModeAverages: document.getElementById("trends-mode-averages"),
  trendsModeImproved: document.getElementById("trends-mode-improved"),
  trendsAveragesView: document.getElementById("trends-averages-view"),
  trendsImprovedView: document.getElementById("trends-improved-view"),
  trendsDivisionSelect: document.getElementById("trends-division-select"),
  trendsAveragesChart: document.getElementById("trends-averages-chart"),
  trendsAveragesTableBody: document.getElementById("trends-averages-table-body"),
  trendsImprovedSelect: document.getElementById("trends-improved-select"),
  trendsImprovedSub: document.getElementById("trends-improved-sub"),
  trendsImprovedTableBody: document.getElementById("trends-improved-table-body"),
  exportCsvBtn: document.getElementById("export-csv"),
  exportFullCsvBtn: document.getElementById("export-full-csv"),
  exportFullJsonBtn: document.getElementById("export-full-json"),
  exportPrintBtn: document.getElementById("export-print"),
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
  bandHomeState: new Map(),        // unit_id -> home state (2-letter), global (not season-scoped)
  homeStates: [],                  // distinct home states among this season's bands, sorted
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
  model.bandHomeState = new Map();
  for (const row of queryAll(db, "SELECT unit_id, name, home_state FROM bands")) {
    model.bandNames.set(row.unit_id, row.name);
    if (row.home_state) model.bandHomeState.set(row.unit_id, row.home_state);
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

  // Only offer home states actually present among this season's bands, same
  // spirit as the state-championship dropdown only listing relevant groups.
  const homeStateSet = new Set();
  for (const roster of model.bandsByDivision.values()) {
    for (const uid of roster) {
      const st = model.bandHomeState.get(uid);
      if (st) homeStateSet.add(st);
    }
  }
  model.homeStates = [...homeStateSet].sort();

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
    if (opts.homeState && opts.homeState !== "all" && model.bandHomeState.get(unitId) !== opts.homeState) continue;
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
    homeState: els.homeStateFilter.value,
    finalsOnly: els.finalsFilter.checked,
    favoritesOnly: els.favoritesFilter.checked,
    search: els.searchFilter.value.trim().toLowerCase(),
  };
}

/* ---------------- Shareable URL (query params <-> filter controls) ---------------- */

function readFiltersFromURL() {
  const p = new URLSearchParams(location.search);
  return {
    season: p.has("season") ? Number(p.get("season")) : null,
    division: p.get("group"),
    state: p.get("state"),
    home: p.get("home"),
    finals: p.get("finals") === "1",
    favorites: p.get("favorites") === "1",
    q: p.get("q") || "",
  };
}

// Applied once, right after the season/filter dropdowns are first populated
// -- a shared link should reproduce a view, not fight the user's own later
// changes, so URL -> controls only happens on initial load.
function applyFiltersFromURL(params) {
  if (params.division && [...els.divisionFilter.options].some((o) => o.value === params.division)) {
    els.divisionFilter.value = params.division;
  }
  if (params.state && [...els.stateFilter.options].some((o) => o.value === params.state)) {
    els.stateFilter.value = params.state;
  }
  if (params.home && [...els.homeStateFilter.options].some((o) => o.value === params.home)) {
    els.homeStateFilter.value = params.home;
  }
  if (params.finals) els.finalsFilter.checked = true;
  if (params.favorites) els.favoritesFilter.checked = true;
  if (params.q) els.searchFilter.value = params.q;
}

// The reverse direction runs on every render() (every filter change, season
// switch, and favorite toggle), so the address bar always matches what's on
// screen. Uses replaceState, not pushState -- nobody wants a back-button
// entry per keystroke in the search box.
function updateURLFromFilters() {
  const p = new URLSearchParams();
  if (model.seasonYear && model.allSeasons.length && model.seasonYear !== model.allSeasons[0]) {
    p.set("season", String(model.seasonYear));
  }
  if (els.divisionFilter.value !== "all") p.set("group", els.divisionFilter.value);
  if (els.stateFilter.value !== "all") p.set("state", els.stateFilter.value);
  if (els.homeStateFilter.value !== "all") p.set("home", els.homeStateFilter.value);
  if (els.finalsFilter.checked) p.set("finals", "1");
  if (els.favoritesFilter.checked) p.set("favorites", "1");
  if (els.searchFilter.value.trim()) p.set("q", els.searchFilter.value.trim());

  const qs = p.toString();
  const newUrl = qs ? `${location.pathname}?${qs}` : location.pathname;
  history.replaceState(null, "", newUrl);
}

function render() {
  const opts = currentFilterOpts();
  const showTagsColumn = opts.stateGroupId === "all" || !opts.finalsOnly;
  const divisionsToShow =
    opts.divisionId === "all" ? model.divisions : model.divisions.filter((d) => String(d.id) === opts.divisionId);

  els.results.innerHTML = "";
  let anyRows = false;
  let totalBands = 0;
  let shownDivisions = 0;

  for (const division of divisionsToShow) {
    const rows = computeRows(division, opts);
    if (rows.length === 0) continue;
    anyRows = true;
    totalBands += rows.length;
    shownDivisions += 1;

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

  if (els.resultsSummary) {
    els.resultsSummary.textContent = anyRows
      ? `Showing ${totalBands} band${totalBands === 1 ? "" : "s"} across ${shownDivisions} group${shownDivisions === 1 ? "" : "s"}.`
      : "No bands match the current filters.";
  }

  updateURLFromFilters();
}

/* ---------------- My Bands (pinned favorites summary) ---------------- */

// Always rank against the FULL division roster, independent of whatever the
// main leaderboard's filters are currently set to. Shared by renderMyBands()
// and the compare view so both agree on each favorited band's true rank.
// My Bands column sorting. Defaults: text/rank columns ascending, score
// columns descending (highest first) -- matches how each column is read.
const MYBANDS_SORT_DEFAULT_DIR = { rank: 1, name: 1, group: 1, latest: -1, prior: -1, delta: -1 };
const MYBANDS_SORT_ACCESSORS = {
  rank: ({ row }) => row.rank,
  name: ({ row }) => row.name.toLowerCase(),
  group: ({ division }) => division.label,
  latest: ({ row }) => (row.latest ? row.latest.score : null),
  prior: ({ row }) => (row.prior ? row.prior.score : null),
  delta: ({ row }) => row.delta,
};

let myBandsSort = { key: "name", dir: 1 };

function loadMyBandsSort() {
  try {
    const parsed = JSON.parse(safeLocalStorageGet("usbands-mybands-sort") || "null");
    if (parsed && MYBANDS_SORT_ACCESSORS[parsed.key] && (parsed.dir === 1 || parsed.dir === -1)) {
      myBandsSort = parsed;
    }
  } catch {
    /* ignore corrupt value */
  }
}

function setMyBandsSort(key) {
  myBandsSort =
    myBandsSort.key === key
      ? { key, dir: -myBandsSort.dir }
      : { key, dir: MYBANDS_SORT_DEFAULT_DIR[key] ?? 1 };
  safeLocalStorageSet("usbands-mybands-sort", JSON.stringify(myBandsSort));
  renderMyBands();
}

// Nulls (no score yet, unranked) always sort to the bottom regardless of
// direction -- reversing direction should never bury ranked bands under
// unscored ones.
function sortFoundRows(found) {
  const accessor = MYBANDS_SORT_ACCESSORS[myBandsSort.key];
  if (!accessor) return found;
  const dir = myBandsSort.dir;
  return [...found].sort((a, b) => {
    const va = accessor(a);
    const vb = accessor(b);
    const aNull = va === null || va === undefined;
    const bNull = vb === null || vb === undefined;
    if (aNull && bNull) return 0;
    if (aNull) return 1;
    if (bNull) return -1;
    return typeof va === "string" ? va.localeCompare(vb) * dir : (va - vb) * dir;
  });
}

function sortableHeader(label, key, extraClass) {
  const isActive = myBandsSort.key === key;
  const dirWord = isActive ? (myBandsSort.dir === 1 ? "ascending" : "descending") : "none";
  const arrow = isActive ? (myBandsSort.dir === 1 ? "▲" : "▼") : "";
  const btn = el("button", { type: "button", class: "sort-btn" }, [
    label,
    arrow ? el("span", { class: "sort-btn__arrow", "aria-hidden": "true" }, [` ${arrow}`]) : null,
  ]);
  btn.addEventListener("click", () => setMyBandsSort(key));
  return el("th", { class: extraClass || "", "aria-sort": dirWord }, [btn]);
}

function getFavoritedRows() {
  const unfiltered = { stateGroupId: "all", finalsOnly: false, favoritesOnly: false, search: "" };
  const found = [];
  for (const division of model.divisions) {
    const roster = model.bandsByDivision.get(division.id);
    if (!roster || ![...model.favorites].some((uid) => roster.has(uid))) continue;
    for (const row of computeRows(division, unfiltered)) {
      if (isFavorite(row.unitId)) found.push({ row, division });
    }
  }
  found.sort((a, b) => a.row.name.localeCompare(b.row.name));
  return found;
}

function renderMyBands() {
  els.mybands.innerHTML = "";
  if (model.favorites.size === 0) return;

  let found = getFavoritedRows();
  if (found.length === 0) return;
  found = sortFoundRows(found);

  const rightChildren = [el("span", { class: "division-section__count" }, [`${found.length} favorited`])];
  if (found.length >= 2) {
    const compareBtn = el("button", { type: "button", class: "compare-btn" }, ["Compare"]);
    compareBtn.addEventListener("click", () => openCompare());
    rightChildren.unshift(compareBtn);
  }

  const section = el("section", { class: "division-section mybands-section" }, [
    el("div", { class: "division-section__head" }, [
      el("h2", {}, ["★ My Bands"]),
      el("div", { class: "division-section__head-right" }, rightChildren),
    ]),
  ]);

  const table = el("table", { class: "leaderboard" }, [
    el("thead", {}, [
      el("tr", {}, [
        el("th", { class: "star-col" }, ["★"]),
        sortableHeader("Rank", "rank"),
        sortableHeader("Band", "name"),
        sortableHeader("Group", "group"),
        sortableHeader("Latest", "latest", "num"),
        sortableHeader("Prior", "prior", "num"),
        sortableHeader("Δ", "delta", "num"),
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

/* ---------------- Accessibility: focus trapping for modal overlays ---------------- */

// Keyboard users tabbing through an open overlay must not be able to tab
// into the page behind it -- aria-modal alone signals this to screen
// readers but doesn't enforce it for sighted keyboard navigation, so this
// wraps Tab/Shift+Tab at the overlay's own first/last focusable element.
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container) {
  return [...container.querySelectorAll(FOCUSABLE_SELECTOR)].filter((node) => node.getClientRects().length > 0);
}

function trapTabKey(container, e) {
  if (e.key !== "Tab") return;
  const focusable = getFocusable(container);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

let detailReturnFocusEl = null;

function openDetail(row, division) {
  detailReturnFocusEl = document.activeElement;
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
  els.overlayClose.focus();
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
  if (els.overlay.hidden) return;
  els.overlay.hidden = true;
  if (detailReturnFocusEl && document.body.contains(detailReturnFocusEl)) detailReturnFocusEl.focus();
  detailReturnFocusEl = null;
}

/* ---------------- Compare (multiple favorited bands) ---------------- */

// A fixed, brand-independent categorical order -- deliberately NOT derived
// from the site's own (possibly user-customized) Primary/Accent theme.
// Comparing 2+ bands needs several mutually distinguishable hues at once,
// which a 2-color brand theme was never designed to guarantee; this order
// is validated to stay distinguishable slot over slot in both modes.
const COMPARE_PALETTE_LIGHT = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"];
const COMPARE_PALETTE_DARK = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];

function currentComparePalette() {
  const theme = document.documentElement.getAttribute("data-theme");
  const isDark = theme === "dark" || (!theme && matchMedia("(prefers-color-scheme: dark)").matches);
  return isDark ? COMPARE_PALETTE_DARK : COMPARE_PALETTE_LIGHT;
}

let compareReturnFocusEl = null;

function openCompare() {
  const found = getFavoritedRows();
  if (found.length < 2) return;
  compareReturnFocusEl = document.activeElement;

  const palette = currentComparePalette();
  const series = found.map((f, i) => ({
    name: f.row.name,
    divisionLabel: f.division.label,
    color: palette[i % palette.length],
    points: f.row.history,
  }));

  els.compareSub.textContent = `${model.seasonYear} season — ${series.length} bands`;

  els.compareLegend.innerHTML = "";
  for (const s of series) {
    els.compareLegend.appendChild(
      el("span", { class: "compare-legend__item" }, [
        el("span", { class: "compare-legend__swatch", style: `background:${s.color}` }, []),
        `${s.name} (${s.divisionLabel})`,
      ])
    );
  }

  els.compareChart.innerHTML = "";
  els.compareChart.appendChild(buildCompareChart(series));

  els.compareTableBody.innerHTML = "";
  for (const { row, division } of found) {
    els.compareTableBody.appendChild(
      el("tr", {}, [
        el("td", {}, [el("span", { class: "band-name" }, [row.name])]),
        el("td", {}, [division.label]),
        el("td", { class: "num" }, [fmtScore(row.latest && row.latest.score)]),
        el("td", { class: "num" }, [fmtScore(row.prior && row.prior.score)]),
        el("td", { class: "num" }, [deltaCell(row.delta)]),
      ])
    );
  }

  els.compareOverlay.hidden = false;
  els.compareClose.focus();
}

function closeCompare() {
  if (els.compareOverlay.hidden) return;
  els.compareOverlay.hidden = true;
  if (compareReturnFocusEl && document.body.contains(compareReturnFocusEl)) compareReturnFocusEl.focus();
  compareReturnFocusEl = null;
}

function buildCompareChart(series) {
  // Shared x-axis: the union of every distinct date across all compared
  // bands, chronological -- each band's line is drawn only through the
  // dates where it actually has a score, leaving a gap otherwise (never
  // interpolated), since not every favorited band attends every show.
  const dateSet = new Set();
  for (const s of series) for (const p of s.points) dateSet.add(p.date);
  const dates = [...dateSet].sort();

  if (dates.length === 0) {
    return el("p", { class: "empty-note" }, ["Not enough data yet to compare."]);
  }

  const width = 640, height = 240;
  const padL = 34, padR = 16, padT = 16, padB = 26;
  const innerW = width - padL - padR, innerH = height - padT - padB;

  const allScores = series.flatMap((s) => s.points.map((p) => p.score));
  const min = Math.min(...allScores), max = Math.max(...allScores);
  const lo = Math.floor((min - 1) * 2) / 2;
  const hi = Math.ceil((max + 1) * 2) / 2;
  const range = hi - lo || 1;
  const stepX = dates.length > 1 ? innerW / (dates.length - 1) : 0;
  const yForScore = (v) => padT + innerH - ((v - lo) / range) * innerH;

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Score comparison line chart");

  [lo, (lo + hi) / 2, hi].forEach((val) => {
    const y = yForScore(val);
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

  const labelEvery = Math.max(1, Math.ceil(dates.length / 6));
  dates.forEach((date, i) => {
    if (i % labelEvery !== 0 && i !== dates.length - 1) return;
    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", padL + i * stepX);
    label.setAttribute("y", height - 6);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "chart-axis-label");
    label.textContent = fmtDate(date);
    svg.appendChild(label);
  });

  for (const s of series) {
    const byDate = new Map(s.points.map((p) => [p.date, p]));
    let d = "";
    let drawing = false;
    dates.forEach((date, i) => {
      const p = byDate.get(date);
      if (!p) {
        drawing = false;
        return;
      }
      const x = padL + i * stepX, y = yForScore(p.score);
      d += drawing ? ` L${x},${y}` : `M${x},${y}`;
      drawing = true;
    });
    const path = document.createElementNS(ns, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", s.color);
    path.setAttribute("stroke-width", "2");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);

    dates.forEach((date) => {
      const p = byDate.get(date);
      if (!p) return;
      const i = dates.indexOf(date);
      const dot = document.createElementNS(ns, "circle");
      dot.setAttribute("cx", padL + i * stepX);
      dot.setAttribute("cy", yForScore(p.score));
      dot.setAttribute("r", 3.5);
      dot.setAttribute("fill", s.color);
      dot.setAttribute("stroke", "var(--surface)");
      dot.setAttribute("stroke-width", "1.5");
      svg.appendChild(dot);
    });
  }

  const container = el("div", { style: "position:relative" }, []);

  // One shared crosshair + one tooltip listing every series at that date
  // (per the "one tooltip, every series" convention already used for the
  // single-band chart's hover, extended to multiple lines here).
  const crosshair = document.createElementNS(ns, "line");
  crosshair.setAttribute("y1", padT);
  crosshair.setAttribute("y2", height - padB);
  crosshair.setAttribute("class", "chart-crosshair");
  crosshair.style.opacity = "0";
  svg.appendChild(crosshair);

  const tooltip = el("div", { class: "chart-tooltip chart-tooltip--wide" }, []);

  dates.forEach((date, i) => {
    const x = padL + i * stepX;
    const hitWidth = Math.max(stepX, 24);
    const hit = document.createElementNS(ns, "rect");
    hit.setAttribute("x", x - hitWidth / 2);
    hit.setAttribute("y", padT);
    hit.setAttribute("width", hitWidth);
    hit.setAttribute("height", innerH);
    hit.setAttribute("fill", "transparent");
    hit.style.cursor = "pointer";
    hit.tabIndex = 0;

    const show = () => {
      crosshair.setAttribute("x1", x);
      crosshair.setAttribute("x2", x);
      crosshair.style.opacity = "1";
      tooltip.innerHTML = "";
      tooltip.appendChild(el("div", {}, [fmtDate(date)]));
      for (const s of series) {
        const p = s.points.find((pt) => pt.date === date);
        tooltip.appendChild(
          el("div", {}, [
            el("span", {
              style: `display:inline-block;width:8px;height:8px;border-radius:999px;background:${s.color};margin-right:6px;`,
            }, []),
            p ? el("strong", {}, [p.score.toFixed(1)]) : "—",
            ` ${s.name}`,
          ])
        );
      }
      tooltip.style.left = `${(x / width) * 100}%`;
      tooltip.style.top = `${(padT / height) * 100}%`;
      tooltip.classList.add("is-visible");
    };
    const hide = () => {
      crosshair.style.opacity = "0";
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

/* ---------------- Circuit Trends (division averages / most improved) ---------------- */

let trendsMode = "averages"; // "averages" | "improved"
let trendsReturnFocusEl = null;

function openTrends() {
  trendsReturnFocusEl = document.activeElement;
  populateTrendsDivisionSelect();
  populateTrendsImprovedSelect();
  renderTrendsAverages();
  renderTrendsImproved();
  setTrendsMode(trendsMode);
  els.trendsOverlay.hidden = false;
  els.trendsClose.focus();
}

function closeTrends() {
  if (els.trendsOverlay.hidden) return;
  els.trendsOverlay.hidden = true;
  if (trendsReturnFocusEl && document.body.contains(trendsReturnFocusEl)) trendsReturnFocusEl.focus();
  trendsReturnFocusEl = null;
}

function setTrendsMode(mode) {
  trendsMode = mode;
  els.trendsModeAverages.classList.toggle("is-active", mode === "averages");
  els.trendsModeImproved.classList.toggle("is-active", mode === "improved");
  els.trendsAveragesView.hidden = mode !== "averages";
  els.trendsImprovedView.hidden = mode !== "improved";
}

// Defaults to whatever division the main leaderboard is currently filtered
// to, if any -- a nice touch for "I was just looking at A - Group III,
// show me its history" -- otherwise the first division in the fixed
// vocabulary. Divisions are a reference table (not season-scoped), so this
// never needs to change based on the selected season.
function populateTrendsDivisionSelect() {
  const current = els.trendsDivisionSelect.value;
  els.trendsDivisionSelect.innerHTML = "";
  for (const d of model.divisions) {
    els.trendsDivisionSelect.appendChild(el("option", { value: String(d.id) }, [d.label]));
  }
  const mainFilter = els.divisionFilter.value;
  els.trendsDivisionSelect.value =
    current || (mainFilter !== "all" ? mainFilter : String(model.divisions[0].id));
}

// Consecutive-year pairs across every backfilled season, most recent first.
function populateTrendsImprovedSelect() {
  const current = els.trendsImprovedSelect.value;
  els.trendsImprovedSelect.innerHTML = "";
  const years = [...model.allSeasons].sort((a, b) => b - a); // descending
  for (let i = 0; i < years.length - 1; i++) {
    const toYear = years[i], fromYear = years[i + 1];
    els.trendsImprovedSelect.appendChild(
      el("option", { value: `${fromYear}-${toYear}` }, [`${fromYear} → ${toYear}`])
    );
  }
  if (current) els.trendsImprovedSelect.value = current;
}

// A band's "final" score for a season within some scope (a single division,
// or -- for Most Improved -- every division at once) is the chronologically
// LAST one, same definition used everywhere else in the app (see
// historyFor()'s "latest"), not the best one. Rows must already be sorted
// by event_date for "last wins" to be correct.
function latestPerBandPerYear(rows) {
  const byYearThenBand = new Map(); // year -> unitId -> row (last one wins)
  for (const r of rows) {
    if (!byYearThenBand.has(r.year)) byYearThenBand.set(r.year, new Map());
    byYearThenBand.get(r.year).set(r.unitId, r);
  }
  return byYearThenBand;
}

function renderTrendsAverages() {
  const divisionId = Number(els.trendsDivisionSelect.value);
  const rows = queryAll(
    dbHandle,
    `SELECT e.season_year AS year, s.unit_id AS unitId, s.score AS score
     FROM scores s
     JOIN events e ON e.id = s.event_id
     WHERE s.division_id = ?
     ORDER BY e.season_year, e.event_date`,
    [divisionId]
  );

  const byYear = latestPerBandPerYear(rows);
  const points = [...byYear.keys()]
    .sort((a, b) => a - b)
    .map((year) => {
      const bandRows = [...byYear.get(year).values()];
      const avg = bandRows.reduce((sum, r) => sum + r.score, 0) / bandRows.length;
      return { year, avgScore: avg, bandCount: bandRows.length };
    });

  els.trendsAveragesChart.innerHTML = "";
  if (points.length === 0) {
    els.trendsAveragesChart.appendChild(el("p", { class: "empty-note" }, ["Not enough data yet for this group."]));
  } else {
    els.trendsAveragesChart.appendChild(buildYearlyTrendChart(points));
  }

  els.trendsAveragesTableBody.innerHTML = "";
  for (const p of [...points].reverse()) {
    els.trendsAveragesTableBody.appendChild(
      el("tr", {}, [
        el("td", {}, [String(p.year)]),
        el("td", { class: "num" }, [String(p.bandCount)]),
        el("td", { class: "num" }, [p.avgScore.toFixed(1)]),
      ])
    );
  }
}

function renderTrendsImproved() {
  const [fromYear, toYear] = (els.trendsImprovedSelect.value || "").split("-").map(Number);
  els.trendsImprovedTableBody.innerHTML = "";
  if (!fromYear || !toYear) {
    els.trendsImprovedSub.textContent = "";
    return;
  }
  els.trendsImprovedSub.textContent = `Comparing each band's final score of the season, ${fromYear} vs ${toYear}`;

  const rows = queryAll(
    dbHandle,
    `SELECT e.season_year AS year, s.unit_id AS unitId, s.score AS score, d.label AS divisionLabel
     FROM scores s
     JOIN events e ON e.id = s.event_id
     JOIN divisions d ON d.id = s.division_id
     WHERE e.season_year IN (?, ?)
     ORDER BY e.event_date`,
    [fromYear, toYear]
  );

  const byYear = latestPerBandPerYear(rows);
  const fromRows = byYear.get(fromYear) || new Map();
  const toRows = byYear.get(toYear) || new Map();

  const improved = [];
  for (const [unitId, toRow] of toRows) {
    const fromRow = fromRows.get(unitId);
    if (!fromRow) continue; // needs a score in both seasons to compute a delta
    improved.push({
      unitId,
      name: model.bandNames.get(unitId) || `Unit ${unitId}`,
      divisionLabel: toRow.divisionLabel,
      fromScore: fromRow.score,
      toScore: toRow.score,
      delta: round1(toRow.score - fromRow.score),
    });
  }
  improved.sort((a, b) => b.delta - a.delta);

  if (improved.length === 0) {
    els.trendsImprovedTableBody.appendChild(
      el("tr", {}, [el("td", { colspan: "6", class: "empty-note" }, ["No bands scored in both seasons."])])
    );
    return;
  }

  improved.slice(0, 25).forEach((b, i) => {
    els.trendsImprovedTableBody.appendChild(
      el("tr", {}, [
        el("td", {}, [rankBadge(i + 1)]),
        el("td", {}, [el("span", { class: "band-name" }, [b.name])]),
        el("td", {}, [b.divisionLabel]),
        el("td", { class: "num" }, [b.fromScore.toFixed(1)]),
        el("td", { class: "num" }, [b.toScore.toFixed(1)]),
        el("td", { class: "num" }, [deltaCell(b.delta)]),
      ])
    );
  });
}

// A simpler cousin of buildChart()/buildCompareChart(): one point per
// season year (never per individual event), so there's no per-event x-axis
// density or division-change dashing to handle -- just a short, sparse
// trend line across however many seasons have been backfilled.
function buildYearlyTrendChart(points) {
  const width = 640, height = 220;
  const padL = 34, padR = 16, padT = 16, padB = 26;
  const innerW = width - padL - padR, innerH = height - padT - padB;

  const scores = points.map((p) => p.avgScore);
  const min = Math.min(...scores), max = Math.max(...scores);
  const lo = Math.floor((min - 1) * 2) / 2;
  const hi = Math.ceil((max + 1) * 2) / 2;
  const range = hi - lo || 1;

  const stepX = points.length > 1 ? innerW / (points.length - 1) : 0;
  const xy = points.map((p, i) => ({
    x: padL + i * stepX,
    y: padT + innerH - ((p.avgScore - lo) / range) * innerH,
    point: p,
  }));

  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Average score by season line chart");

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

  xy.forEach((p) => {
    const label = document.createElementNS(ns, "text");
    label.setAttribute("x", p.x);
    label.setAttribute("y", height - 6);
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("class", "chart-axis-label");
    label.textContent = String(p.point.year);
    svg.appendChild(label);
  });

  let d = "";
  xy.forEach((p, i) => {
    d += i === 0 ? `M${p.x},${p.y}` : ` L${p.x},${p.y}`;
  });
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d);
  path.setAttribute("class", "chart-line");
  svg.appendChild(path);

  const container = el("div", { style: "position:relative" }, []);

  const crosshair = document.createElementNS(ns, "line");
  crosshair.setAttribute("y1", padT);
  crosshair.setAttribute("y2", height - padB);
  crosshair.setAttribute("class", "chart-crosshair");
  crosshair.style.opacity = "0";
  svg.appendChild(crosshair);

  const tooltip = el("div", { class: "chart-tooltip" }, []);

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
      const strong = el("strong", {}, [p.point.avgScore.toFixed(1)]);
      tooltip.appendChild(strong);
      tooltip.appendChild(
        document.createTextNode(` avg — ${p.point.bandCount} band${p.point.bandCount === 1 ? "" : "s"} (${p.point.year})`)
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
  return container;
}

/* ---------------- Export (CSV / print) ---------------- */

function csvEscape(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-+|-+$)/g, "");
}

function exportFilename(opts) {
  const parts = ["usbands", String(model.seasonYear)];
  if (opts.divisionId !== "all") {
    const d = model.divisions.find((x) => String(x.id) === opts.divisionId);
    if (d) parts.push(slugify(d.label));
  }
  if (opts.stateGroupId !== "all") {
    const name = model.stateGroupNameById.get(opts.stateGroupId);
    if (name) parts.push(slugify(name));
  }
  if (opts.finalsOnly) parts.push("finals");
  if (opts.favoritesOnly) parts.push("favorites");
  return `${parts.join("-")}.csv`;
}

// Exports exactly what's currently on screen -- recomputed from the same
// currentFilterOpts()/computeRows() the leaderboard itself renders from,
// rather than scraping the DOM, so it can never drift from what's visible.
function exportCSV() {
  const opts = currentFilterOpts();
  const divisionsToShow =
    opts.divisionId === "all" ? model.divisions : model.divisions.filter((d) => String(d.id) === opts.divisionId);

  const header = [
    "Season", "Group", "Rank", "Band", "Home State", "Latest", "Prior", "Delta",
    "State Championship", "Finals Qualifier",
  ];
  const lines = [header];

  for (const division of divisionsToShow) {
    for (const row of computeRows(division, opts)) {
      lines.push([
        model.seasonYear,
        division.label,
        row.rank ?? "",
        row.name,
        model.bandHomeState.get(row.unitId) || "",
        row.latest ? row.latest.score.toFixed(1) : "",
        row.prior ? row.prior.score.toFixed(1) : "",
        row.delta !== null && row.delta !== undefined ? row.delta.toFixed(1) : "",
        [...row.stateGroups].map((gid) => model.stateGroupNameById.get(gid) || "").join("; "),
        row.isFinals ? "Yes" : "No",
      ]);
    }
  }

  const csv = lines.map((row) => row.map(csvEscape).join(",")).join("\r\n");
  triggerDownload(exportFilename(opts), csv, "text/csv;charset=utf-8;");
}

function triggerDownload(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

const EVENT_KIND_LABELS = {
  regular: "Regular",
  state_championship: "State Championship",
  usbands_championship: "USBands Championship",
};

// Every individual score for the season, straight from the database and
// completely independent of the leaderboard's current filters -- the
// filtered CSV above is a latest/prior snapshot, useful for "how do things
// stand right now," but can't show a band's full trajectory across every
// show. This is the raw material for that: one row per (event, division,
// band) score, suitable for pivoting in a spreadsheet.
function fetchFullSeasonRows() {
  return queryAll(
    dbHandle,
    `SELECT e.event_date AS date, e.name AS event, e.event_kind AS eventKind,
            d.label AS division, b.name AS band, b.home_state AS homeState,
            s.score AS score, s.rank AS rank
     FROM scores s
     JOIN events e ON e.id = s.event_id
     JOIN divisions d ON d.id = s.division_id
     JOIN bands b ON b.unit_id = s.unit_id
     WHERE e.season_year = ?
     ORDER BY e.event_date, d.id, s.rank`,
    [model.seasonYear]
  );
}

function exportFullSeasonCSV() {
  const rows = fetchFullSeasonRows();
  const header = ["Date", "Event", "Event Type", "Group", "Band", "Home State", "Score", "Rank"];
  const lines = [header];
  for (const r of rows) {
    lines.push([
      r.date, r.event, EVENT_KIND_LABELS[r.eventKind] || r.eventKind, r.division, r.band,
      r.homeState || "", r.score.toFixed(1), r.rank ?? "",
    ]);
  }
  const csv = lines.map((row) => row.map(csvEscape).join(",")).join("\r\n");
  triggerDownload(`usbands-${model.seasonYear}-full-season.csv`, csv, "text/csv;charset=utf-8;");
}

function exportFullSeasonJSON() {
  const rows = fetchFullSeasonRows().map((r) => ({
    date: r.date,
    event: r.event,
    eventType: EVENT_KIND_LABELS[r.eventKind] || r.eventKind,
    division: r.division,
    band: r.band,
    homeState: r.homeState || null,
    score: r.score,
    rank: r.rank ?? null,
  }));
  const json = JSON.stringify({ season: model.seasonYear, scores: rows }, null, 2);
  triggerDownload(`usbands-${model.seasonYear}-full-season.json`, json, "application/json;charset=utf-8;");
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

  els.homeStateFilter.innerHTML = "";
  els.homeStateFilter.appendChild(el("option", { value: "all" }, ["Any home state"]));
  for (const st of model.homeStates) {
    els.homeStateFilter.appendChild(el("option", { value: st }, [st]));
  }
}

/** Division/state IDs are season-scoped, so a selection from the previous
 * season would silently point at the wrong (or no) group after switching --
 * reset to defaults whenever the season changes. */
function resetFilterControls() {
  els.divisionFilter.value = "all";
  els.stateFilter.value = "all";
  els.homeStateFilter.value = "all";
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
  updateThemeColorMeta();
}

function applyTheme(theme) {
  if (theme) document.documentElement.setAttribute("data-theme", theme);
  else document.documentElement.removeAttribute("data-theme");
  safeLocalStorageSet("usbands-theme", theme || "");
  updateThemeIcon();
  updateThemeColorMeta();
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

// Reads --brand-green-700 back off the live DOM (rather than re-deriving it
// from the picked primary) so the meta tag always matches exactly what's
// rendered, whether that's a custom-derived ramp or the hand-tuned default.
function updateThemeColorMeta() {
  if (!els.themeColorMeta) return;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--brand-green-700").trim();
  if (value) els.themeColorMeta.setAttribute("content", value);
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
  updateThemeColorMeta();
}

function resetCustomTheme() {
  const styleEl = document.getElementById("custom-theme");
  if (styleEl) styleEl.remove();
  safeLocalStorageSet("usbands-theme-colors", "");
  if (els.themePrimaryInput) els.themePrimaryInput.value = DEFAULT_THEME_COLORS.primary;
  if (els.themeAccentInput) els.themeAccentInput.value = DEFAULT_THEME_COLORS.accent;
  updateThemeColorMeta();
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

/* ---------------- Last-updated indicator ---------------- */

// data/last_updated.txt is written by the weekly workflow only in the same
// commit as an actual data change (see update.yml) -- so this reflects when
// the data last changed, not merely when the job last ran, and its absence
// (e.g. very first deploy, before that file exists) is silently ignored
// rather than shown as an error.
async function loadLastUpdated() {
  if (!els.lastUpdated) return;
  try {
    const resp = await fetch("data/last_updated.txt", { cache: "no-store" });
    if (!resp.ok) return;
    const text = (await resp.text()).trim();
    const date = new Date(text);
    if (isNaN(date)) return;
    const formatted = date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
    els.lastUpdated.textContent = ` (last updated ${formatted})`;
  } catch {
    /* offline or file missing -- leave the generic footer text as-is */
  }
}

/* ---------------- Install prompt ---------------- */

// Most mobile browsers bury "Add to Home Screen" in a menu (or, on iOS,
// inside the Share sheet with no programmatic prompt at all), so the PWA
// manifest added earlier could easily go unnoticed. This surfaces it
// directly: a dismissible banner using Chrome/Edge's beforeinstallprompt
// where available, or brief instructions on iOS where it isn't.
let deferredInstallPrompt = null;

function isStandaloneDisplay() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function isIOSDevice() {
  return /iphone|ipad|ipod/i.test(navigator.userAgent);
}

function showInstallBanner(mode) {
  if (!els.installBanner) return;
  els.installBanner.hidden = false;
  if (els.installBtn) els.installBtn.hidden = mode !== "prompt";
  if (els.installBannerText) {
    els.installBannerText.textContent = mode === "ios"
      ? 'Install this app: tap Share, then "Add to Home Screen."'
      : "Install this app for quick access at competitions.";
  }
}

function hideInstallBanner() {
  if (els.installBanner) els.installBanner.hidden = true;
}

// The banner only offers to install once (respecting a dismissal), but the
// icon is the permanent way back in -- it renders only when installing is
// actually possible right now (a captured beforeinstallprompt, or iOS) and
// disappears once already installed, so there's never a dead button.
function updateInstallIconVisibility() {
  if (!els.installIconBtn) return;
  els.installIconBtn.hidden = isStandaloneDisplay() || !(deferredInstallPrompt || isIOSDevice());
}

function initInstallPrompt() {
  if (isStandaloneDisplay()) return;
  const dismissed = safeLocalStorageGet("usbands-install-dismissed") === "1";

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (!dismissed) showInstallBanner("prompt");
    updateInstallIconVisibility();
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    hideInstallBanner();
    updateInstallIconVisibility();
  });

  if (isIOSDevice()) {
    if (!dismissed) showInstallBanner("ios");
    updateInstallIconVisibility();
  }

  if (els.installBtn) {
    els.installBtn.addEventListener("click", async () => {
      if (!deferredInstallPrompt) return;
      hideInstallBanner();
      deferredInstallPrompt.prompt();
      try {
        await deferredInstallPrompt.userChoice;
      } finally {
        deferredInstallPrompt = null;
        updateInstallIconVisibility();
      }
    });
  }
  if (els.installDismiss) {
    els.installDismiss.addEventListener("click", () => {
      hideInstallBanner();
      safeLocalStorageSet("usbands-install-dismissed", "1");
    });
  }
  if (els.installIconBtn) {
    els.installIconBtn.addEventListener("click", async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        try {
          await deferredInstallPrompt.userChoice;
        } finally {
          deferredInstallPrompt = null;
          updateInstallIconVisibility();
        }
      } else if (isIOSDevice()) {
        showInstallBanner("ios");
      }
    });
  }
}

/* ---------------- Offline banner ---------------- */

function updateOfflineBanner() {
  if (els.offlineBanner) els.offlineBanner.hidden = navigator.onLine;
}

function initOfflineBanner() {
  updateOfflineBanner();
  window.addEventListener("online", updateOfflineBanner);
  window.addEventListener("offline", updateOfflineBanner);
}

/* ---------------- Service worker (offline caching + update notices) ---------------- */

// The service worker caches the app shell, the sql.js WASM bundle, and the
// database offline (see sw.js). It also diffs last_updated.txt on every
// background refresh -- a few bytes, cheap to check on every load -- as the
// signal that the (much larger) database actually changed, and messages
// this page immediately rather than waiting for the next manual reload.
//
// The app shell itself (app.js/index.html/style.css) is cached the same
// stale-while-revalidate way: a load always gets the cached version first,
// even when a newer one exists, and only the *next* load benefits from the
// background refresh. Combined with the service worker's own
// skipWaiting()/clients.claim() installing a new version silently, an
// already-open tab or an installed app that's reopened without a full
// relaunch can sit on old code indefinitely with zero indication -- this
// surfaces that explicitly instead of leaving it to chance.
function showAppUpdateBanner() {
  if (els.appUpdateBanner) els.appUpdateBanner.hidden = false;
}

function initServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  navigator.serviceWorker
    .register("sw.js")
    .then((registration) => {
      // A worker already found waiting (e.g. installed by a background
      // check while this page wasn't focused) is exactly the same "there's
      // a newer version than what's currently running" case.
      if (registration.waiting && navigator.serviceWorker.controller) showAppUpdateBanner();

      registration.addEventListener("updatefound", () => {
        const installing = registration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          // A controller already existing means this is a genuine update,
          // not the very first-ever install (nothing to update *from* yet).
          if (installing.state === "installed" && navigator.serviceWorker.controller) {
            showAppUpdateBanner();
          }
        });
      });
    })
    .catch(() => {
      /* offline on first visit, or an unsupported context -- just skip it */
    });

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data && event.data.type === "usbands-data-updated" && els.dataUpdateBanner) {
      els.dataUpdateBanner.hidden = false;
    }
  });
  if (els.dataUpdateRefresh) els.dataUpdateRefresh.addEventListener("click", () => location.reload());
  if (els.dataUpdateDismiss) {
    els.dataUpdateDismiss.addEventListener("click", () => {
      els.dataUpdateBanner.hidden = true;
    });
  }
  if (els.appUpdateRefresh) els.appUpdateRefresh.addEventListener("click", () => location.reload());
  if (els.appUpdateDismiss) {
    els.appUpdateDismiss.addEventListener("click", () => {
      els.appUpdateBanner.hidden = true;
    });
  }
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
  function openThemePanel() {
    els.themeColorPanel.hidden = false;
    els.themeColorToggle.setAttribute("aria-expanded", "true");
    const firstControl = els.themeColorPanel.querySelector("input, button");
    if (firstControl) firstControl.focus();
  }
  function closeThemePanel({ returnFocus = false } = {}) {
    if (els.themeColorPanel.hidden) return;
    els.themeColorPanel.hidden = true;
    els.themeColorToggle.setAttribute("aria-expanded", "false");
    if (returnFocus) els.themeColorToggle.focus();
  }
  els.themeColorToggle.setAttribute("aria-expanded", "false");
  els.themeColorToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if (els.themeColorPanel.hidden) openThemePanel();
    else closeThemePanel();
  });
  document.addEventListener("click", (e) => {
    if (!els.themeColorPanel.hidden && !els.themeColorPanel.contains(e.target) && e.target !== els.themeColorToggle) {
      closeThemePanel();
    }
  });
  // Closes the panel when Tab moves focus out of it, not just on a mouse
  // click outside -- otherwise a keyboard user tabbing past it leaves it
  // visually open while focus has already moved elsewhere on the page.
  document.addEventListener("focusin", (e) => {
    if (!els.themeColorPanel.hidden && !els.themeColorPanel.contains(e.target) && e.target !== els.themeColorToggle) {
      closeThemePanel();
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.themeColorPanel.hidden) closeThemePanel({ returnFocus: true });
  });

  els.overlayClose.addEventListener("click", closeDetail);
  els.overlay.addEventListener("click", (e) => {
    if (e.target === els.overlay) closeDetail();
  });
  els.overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDetail();
    else trapTabKey(els.overlay, e);
  });
  els.detailModeSeason.addEventListener("click", () => setDetailMode("season"));
  els.detailModeAll.addEventListener("click", () => setDetailMode("all"));

  els.compareClose.addEventListener("click", closeCompare);
  els.compareOverlay.addEventListener("click", (e) => {
    if (e.target === els.compareOverlay) closeCompare();
  });
  els.compareOverlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeCompare();
    else trapTabKey(els.compareOverlay, e);
  });

  els.trendsOpen.addEventListener("click", openTrends);
  els.trendsClose.addEventListener("click", closeTrends);
  els.trendsOverlay.addEventListener("click", (e) => {
    if (e.target === els.trendsOverlay) closeTrends();
  });
  els.trendsOverlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeTrends();
    else trapTabKey(els.trendsOverlay, e);
  });
  els.trendsModeAverages.addEventListener("click", () => setTrendsMode("averages"));
  els.trendsModeImproved.addEventListener("click", () => setTrendsMode("improved"));
  els.trendsDivisionSelect.addEventListener("change", renderTrendsAverages);
  els.trendsImprovedSelect.addEventListener("change", renderTrendsImproved);

  els.exportCsvBtn.addEventListener("click", exportCSV);
  els.exportFullCsvBtn.addEventListener("click", exportFullSeasonCSV);
  els.exportFullJsonBtn.addEventListener("click", exportFullSeasonJSON);
  els.exportPrintBtn.addEventListener("click", () => window.print());

  for (const control of [els.divisionFilter, els.stateFilter, els.homeStateFilter, els.finalsFilter, els.favoritesFilter]) {
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
  loadMyBandsSort();
  loadLastUpdated();
  initInstallPrompt();
  initOfflineBanner();
  initServiceWorker();

  try {
    dbHandle = await openDatabase();
  } catch (err) {
    els.status.textContent = `Couldn't load the database: ${err.message}`;
    els.status.classList.add("error");
    return;
  }

  model.allSeasons = queryAll(dbHandle, "SELECT year FROM seasons ORDER BY year DESC").map((r) => r.year);
  const urlParams = readFiltersFromURL();
  const initialYear = urlParams.season && model.allSeasons.includes(urlParams.season) ? urlParams.season : model.allSeasons[0];
  buildModelForSeason(dbHandle, initialYear);
  populateSeasonSelect();
  populateFilters();
  applyFiltersFromURL(urlParams);
  els.status.hidden = true;
  renderAll();
}

main();
