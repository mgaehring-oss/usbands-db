// @ts-check
const { test, expect } = require("@playwright/test");

// Behavior of the leaderboard features added on top of the PWA shell: rank
// change, the What's new card, Upcoming shows, Finals results, band links,
// and the not-started-season handling. The page's own functions are plain
// globals (classic script), so most checks drive them directly with small
// synthetic models rather than depending on whatever the live data says
// this week; a few use the real database for end-to-end wiring.

async function ready(page, url = "/index.html") {
  await page.goto(url);
  await expect(page.locator(".division-section").first()).toBeVisible();
}

/** A band that has at least `n` scores in the season the page opened on. */
async function bandWithScores(page, n = 2) {
  return page.evaluate((count) => {
    const row = queryAll(
      dbHandle,
      `SELECT s.unit_id AS id, b.name AS name, COUNT(*) AS n
       FROM scores s JOIN events e ON e.id = s.event_id JOIN bands b ON b.unit_id = s.unit_id
       WHERE e.season_year = ? GROUP BY s.unit_id HAVING n >= ? ORDER BY s.unit_id LIMIT 1`,
      [model.defaultSeason, count]
    )[0];
    return row;
  }, n);
}

test.describe("default season", () => {
  test("opens on the newest season that has scores", async ({ page }) => {
    await ready(page);
    const picked = await page.evaluate(() => [
      pickDefaultSeason([2027, 2026, 2025], new Map([[2026, 5], [2025, 9]])),
      pickDefaultSeason([2027, 2026], new Map()),
      pickDefaultSeason([], new Map()),
    ]);
    expect(picked).toEqual([2026, 2027, null]);
  });

  test("a season with no scores yet is labelled and explains itself", async ({ page }) => {
    await ready(page);
    await page.evaluate(() => {
      dbHandle.run("INSERT INTO seasons (year) VALUES (2099)");
      loadSeasonMeta();
      populateSeasonSelect();
    });
    // The newest season is empty, so it must NOT become the default...
    expect(await page.evaluate(() => model.defaultSeason)).not.toBe(2099);
    await expect(page.locator("#season-select option", { hasText: "2099" })).toHaveText("Season 2099 (not started)");

    // ...but it can still be chosen, and says why it's empty.
    await page.selectOption("#season-select", "2099");
    await expect(page.locator(".season-note")).toContainText("Season 2099 hasn't started yet");
    await page.click(".season-note button");
    await expect(page.locator(".season-note")).toHaveCount(0);
    expect(await page.evaluate(() => model.seasonYear)).toBe(await page.evaluate(() => model.defaultSeason));
  });
});

test.describe("rank change", () => {
  // Three bands. Before the cutoff (Oct 3): A 80, B 70, C absent.
  // Now: A 80, B 85, C 75 (first score) -> B up 1, A down 1, C new.
  const synthetic = () => {
    const mk = (date, score) => ({ date, name: "x", score, rank: null });
    model.rankChangeCutoff = "2026-10-03";
    model.bandNames = new Map([[1, "A"], [2, "B"], [3, "C"]]);
    model.bandsByDivision = new Map([[7, new Set([1, 2, 3])]]);
    model.historyByKey = new Map([
      ["1|7", [mk("2026-09-26", 80)]],
      ["2|7", [mk("2026-09-26", 70), mk("2026-10-10", 85)]],
      ["3|7", [mk("2026-10-10", 75)]],
    ]);
    model.stateGroupsByBand = new Map();
    model.finalsByBand = new Set();
    model.bandHomeState = new Map();
    const rows = computeRows({ id: 7 }, { stateGroupId: "all", finalsOnly: false, favoritesOnly: false, search: "" });
    return Object.fromEntries(rows.map((r) => [r.name, { rank: r.rank, change: r.rankChange }]));
  };

  test("compares each band's rank with the field a week before the newest scores", async ({ page }) => {
    await ready(page);
    expect(await page.evaluate(synthetic)).toEqual({
      A: { rank: 2, change: -1 },
      B: { rank: 1, change: 1 },
      C: { rank: 3, change: "new" },
    });
  });

  test("shows no indicators when nobody had a score before the cutoff", async ({ page }) => {
    await ready(page);
    const changes = await page.evaluate(() => {
      model.rankChangeCutoff = "2026-01-01";
      model.bandNames = new Map([[1, "A"]]);
      model.bandsByDivision = new Map([[7, new Set([1])]]);
      model.historyByKey = new Map([["1|7", [{ date: "2026-09-26", name: "x", score: 80, rank: null }]]]);
      return computeRows({ id: 7 }, { stateGroupId: "all", finalsOnly: false, favoritesOnly: false, search: "" }).map((r) => r.rankChange);
    });
    expect(changes).toEqual([null]);
  });

  test("renders ▲ / ▼ / NEW badges with accessible labels, and nothing when unchanged", async ({ page }) => {
    await ready(page);
    const html = await page.evaluate(() => {
      model.rankChangeCutoff = "2026-10-03";
      return ["up", "down", "new", "same"].map((k) => {
        const row = { rankChange: { up: 2, down: -1, new: "new", same: 0 }[k] };
        const badge = rankChangeBadge(row);
        return badge ? [badge.textContent, badge.getAttribute("aria-label")] : null;
      });
    });
    expect(html[0]).toEqual(["▲2", "Up 2 places since 10/3"]);
    expect(html[1]).toEqual(["▼1", "Down 1 place since 10/3"]);
    expect(html[2]).toEqual(["NEW", "New since 10/3"]);
    expect(html[3]).toBeNull();
  });
});

test.describe("what's new", () => {
  test("buildWhatsNew reports only unseen scores, with the change from the prior show", async ({ page }) => {
    await ready(page);
    const items = await page.evaluate(() => {
      const row = (event_id, date, score, rank) => ({
        event_id, unit_id: 1, division_id: 2, score, rank,
        event_date: date, event_name: `Show ${event_id}`, division_label: "A - Group I", band_name: "Alpha",
      });
      const rows = [row(1, "2026-09-12", 70, 3), row(2, "2026-09-19", 72.5, 2), row(3, "2026-09-26", 75, 1)];
      const seen = new Set([whatsNewKey(rows[0])]);
      return buildWhatsNew(rows, seen);
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "Alpha", score: 75, delta: 2.5, rank: 1, more: 1, date: "2026-09-26" });
  });

  test("a corrected score counts as new again", async ({ page }) => {
    await ready(page);
    const n = await page.evaluate(() => {
      const r = { event_id: 1, unit_id: 1, division_id: 2, score: 70, rank: 1, event_date: "2026-09-12", event_name: "S", division_label: "d", band_name: "A" };
      const seen = new Set([whatsNewKey(r)]);
      return buildWhatsNew([{ ...r, score: 71 }], seen).length;
    });
    expect(n).toBe(1);
  });

  test("first visit with favorites seeds silently; later scores show a card that Got it dismisses", async ({ page }) => {
    await ready(page);
    const band = await bandWithScores(page, 2);
    await page.evaluate((id) => localStorage.setItem("usbands-favorites", JSON.stringify([id])), band.id);

    // First load with a favorite and no seen-set: nothing to announce.
    await page.reload();
    await expect(page.locator(".division-section").first()).toBeVisible();
    await expect(page.locator(".whatsnew")).toHaveCount(0);

    // Pretend the band's newest score arrived since the last visit.
    await page.evaluate(({ id }) => {
      const rows = queryScoresForBands([id], model.defaultSeason);
      const seen = new Set(rows.slice(0, -1).map(whatsNewKey));
      saveSeenKeys(seen);
    }, band);
    await page.reload();
    const card = page.locator(".whatsnew");
    await expect(card).toBeVisible();
    await expect(card).toContainText(band.name);
    await expect(card).toContainText("new scores");

    // Clicking the band name opens its panel.
    await card.locator(".whatsnew__band").first().click();
    await expect(page.locator("#detail-overlay")).toBeVisible();
    await page.keyboard.press("Escape");

    await card.getByRole("button", { name: "Got it" }).click();
    await expect(page.locator(".whatsnew")).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".division-section").first()).toBeVisible();
    await expect(page.locator(".whatsnew")).toHaveCount(0);
  });

  test("starring a band does not announce its existing scores", async ({ page }) => {
    await ready(page);
    await page.evaluate(() => saveSeenKeys(new Set()));
    await page.locator(".leaderboard tbody tr .star-toggle").first().click();
    await expect(page.locator(".whatsnew")).toHaveCount(0);
  });
});

test.describe("upcoming shows", () => {
  test.beforeEach(async ({ page }) => {
    // Pin "today" so the test doesn't depend on when it runs vs. the season.
    await page.clock.setFixedTime(new Date("2026-10-12T12:00:00"));
  });

  test("lists future events grouped by day, with a badge on championships", async ({ page }) => {
    await ready(page);
    await page.click("#upcoming-open");
    await expect(page.locator("#upcoming-overlay")).toBeVisible();
    await expect(page.locator(".upcoming-day").first()).toBeVisible();
    await expect(page.locator("#upcoming-sub")).toContainText("upcoming show");
    await expect(page.locator(".upcoming-event .badge", { hasText: "USBands Championship" }).first()).toBeVisible();
    const before = await page.evaluate(() => loadUpcoming("2026-10-12").every((e) => e.event_date >= "2026-10-12"));
    expect(before).toBe(true);
    await page.keyboard.press("Escape");
    await expect(page.locator("#upcoming-overlay")).toBeHidden();
  });

  test("My bands view needs a favorite that is entered, and links to the band", async ({ page }) => {
    await ready(page);
    await page.click("#upcoming-open");
    await page.click("#upcoming-mode-mine");
    await expect(page.locator("#upcoming-list .empty-note")).toContainText("Star some bands");
    await page.keyboard.press("Escape");

    const entry = await page.evaluate(() => {
      const events = loadUpcoming("2026-10-12").filter((e) => e.entries.length);
      const e = events[0];
      return { id: e.entries[0].unit_id, name: e.entries[0].band_name, event: e.name };
    });
    await page.evaluate((id) => {
      model.favorites.add(id);
    }, entry.id);

    await page.click("#upcoming-open");
    await page.click("#upcoming-mode-mine");
    await expect(page.locator(".upcoming-event", { hasText: entry.event }).first()).toContainText(`★ ${entry.name}`);
    await page.locator(".upcoming-event__mine .whatsnew__band", { hasText: entry.name }).first().click();
    await expect(page.locator("#upcoming-overlay")).toBeHidden();
    await expect(page.locator("#detail-overlay")).toBeVisible();
    await expect(page.locator("#detail-title")).toHaveText(entry.name);
  });

  test("copes with a cached database that predates event_entries", async ({ page }) => {
    await ready(page);
    await page.evaluate(() => dbHandle.run("DROP TABLE event_entries"));
    await page.click("#upcoming-open");
    await expect(page.locator(".upcoming-event").first()).toBeVisible();
  });

  test("says so when the calendar is empty", async ({ page }) => {
    await page.clock.setFixedTime(new Date("2031-01-01T12:00:00"));
    await ready(page);
    await page.click("#upcoming-open");
    await expect(page.locator("#upcoming-list .empty-note")).toContainText("No upcoming shows");
  });
});

test.describe("finals results", () => {
  test("shows each group's podium with the full list expandable", async ({ page }) => {
    await ready(page);
    await page.evaluate(() => switchSeason(2025));
    await page.click("#finals-open");
    await expect(page.locator("#finals-overlay")).toBeVisible();
    await expect(page.locator("#finals-sub")).toContainText("Season 2025");
    const first = page.locator(".finals-division").first();
    await expect(first.locator(":scope > .table-scroll tbody tr")).toHaveCount(3);
    await expect(first.locator("summary")).toContainText("All");
    await first.locator("summary").click();
    expect(await first.locator("details tbody tr").count()).toBeGreaterThan(3);
  });

  test("recognises the finals in every season, whatever they were titled", async ({ page }) => {
    await ready(page);
    const found = await page.evaluate(() =>
      Object.fromEntries(
        [2022, 2023, 2024, 2025].map((y) => {
          const events = queryAll(
            dbHandle,
            `SELECT e.id, e.event_date, e.name, e.event_kind,
                    (SELECT COUNT(*) FROM scores s WHERE s.event_id = e.id) AS scored
             FROM events e WHERE e.season_year = ? AND e.event_kind != 'state_championship'`,
            [y]
          );
          return [y, pickFinalsEvents(events).map((e) => e.name)];
        })
      )
    );
    for (const names of Object.values(found)) {
      expect(names.length).toBeGreaterThanOrEqual(2);
      for (const n of names) expect(n).toMatch(/championship/i);
      // Another circuit's listing on finals week is not the finals.
      expect(names.join("|")).not.toMatch(/Southeastern/);
    }
  });

  test("pickFinalsEvents ignores state championships and small fields", async ({ page }) => {
    await ready(page);
    const names = await page.evaluate(() =>
      pickFinalsEvents([
        { id: 1, event_date: "2025-11-08", name: "II A & III A Championships", event_kind: "regular", scored: 21 },
        { id: 2, event_date: "2025-11-08", name: "Some Championships", event_kind: "regular", scored: 5 },
        { id: 3, event_date: "2025-11-01", name: "NJ State Championships", event_kind: "state_championship", scored: 40 },
        { id: 4, event_date: "2025-10-18", name: "Early Championships", event_kind: "regular", scored: 40 },
      ]).map((e) => e.id)
    );
    expect(names).toEqual([1]);
  });

  test("explains when finals haven't been scored", async ({ page }) => {
    await ready(page);
    await page.evaluate(() => {
      dbHandle.run("DELETE FROM scores WHERE event_id IN (SELECT id FROM events WHERE season_year = 2026 AND event_kind = 'usbands_championship')");
      buildModelForSeason(dbHandle, 2026);
    });
    await page.click("#finals-open");
    await expect(page.locator("#finals-body .empty-note")).toContainText("No finals results yet for season 2026");
  });
});

test.describe("band links and detail stats", () => {
  test("?band= opens that band, and the address bar follows open/close", async ({ page }) => {
    await ready(page);
    const band = await bandWithScores(page, 2);

    await page.goto(`/index.html?band=${band.id}`);
    await expect(page.locator("#detail-overlay")).toBeVisible();
    await expect(page.locator("#detail-title")).toHaveText(band.name);
    expect(new URL(page.url()).searchParams.get("band")).toBe(String(band.id));

    await page.keyboard.press("Escape");
    await expect(page.locator("#detail-overlay")).toBeHidden();
    expect(new URL(page.url()).searchParams.has("band")).toBe(false);

    await page.locator(".leaderboard tbody tr").first().click();
    expect(new URL(page.url()).searchParams.has("band")).toBe(true);
  });

  test("an unknown band id is ignored", async ({ page }) => {
    await ready(page, "/index.html?band=999999999");
    await expect(page.locator("#detail-overlay")).toBeHidden();
  });

  test("a band from an older season opens in that season", async ({ page }) => {
    await ready(page);
    const old = await page.evaluate(() =>
      queryAll(
        dbHandle,
        `SELECT unit_id AS id FROM band_season_division GROUP BY unit_id
         HAVING MAX(season_year) = 2022 LIMIT 1`
      )[0]
    );
    test.skip(!old, "no band that only existed in 2022");
    await page.goto(`/index.html?band=${old.id}`);
    await expect(page.locator("#detail-overlay")).toBeVisible();
    expect(await page.evaluate(() => model.seasonYear)).toBe(2022);
  });

  test("Copy link puts a shareable URL on the clipboard", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await ready(page);
    const band = await bandWithScores(page, 2);
    await page.goto(`/index.html?band=${band.id}`);
    await page.click("#detail-copy-link");
    await expect(page.locator("#detail-copy-link")).toHaveText("Link copied");
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    const url = new URL(clip);
    expect(url.searchParams.get("band")).toBe(String(band.id));
    expect([...url.searchParams.keys()].sort()).toEqual(["band"]);
  });

  test("the detail panel summarizes shows, average, peak and best finish", async ({ page }) => {
    await ready(page);
    const band = await bandWithScores(page, 2);
    await page.goto(`/index.html?band=${band.id}`);
    await expect(page.locator("#detail-stats")).toContainText(/\d+ shows · Avg \d+\.\d · Peak \d+\.\d \(\d+\/\d+\)/);
    await page.click("#detail-mode-all");
    await expect(page.locator("#detail-stats")).toContainText("Avg");
  });
});
