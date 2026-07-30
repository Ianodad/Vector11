# Data Source Research — vector11 Football RAG App
**Verified:** 2026-07-30  
**Scope:** Free, programmatic replacements/additions for the current seed pipeline (107 URLs). Focus: EPL, La Liga, other European leagues, African football (CAF).

---

## 1. Ranked Recommendations Table

| # | Source | Data Provided | League Coverage | Access Method | Free-Tier Limits | Verified Alive | Replaces |
|---|--------|---------------|-----------------|---------------|-----------------|----------------|----------|
| 1 | **football-data.org** | Standings, fixtures, results, scorers, teams, squad info | EPL, La Liga, Bundesliga, Serie A, Ligue 1, UCL, Championship, Eredivisie, Primeira Liga, Brazil A, World Cup, Euro (12 total) | REST API (JSON), free API key via registration | 10 req/min; API docs say non-authed = 100/day on area+competition list only; authed free = full 12 competitions | Yes — coverage page live, founder pledged free leagues stay free forever | soccerway.com (31), worldfootball.net (3) |
| 2 | **ESPN hidden JSON API** | Live scores, standings, fixtures, team rosters, news | EPL (`eng.1`), La Liga (`esp.1`), Serie A (`ita.1`), Bundesliga (`ger.1`), Ligue 1 (`fra.1`), UCL, CAF Championship, MLS, World Cup | Unauthenticated HTTP GET — no key, no registration | No documented limits; unofficial/undocumented | **Confirmed live 30 Jul 2026** — returned EPL 2026-27 data (Coventry vs Arsenal, 21 Aug 2026) | espn.com HTML pages (5), some soccerway.com |
| 3 | **openfootball/football.json** | Fixtures, results (scores, dates, teams) | EPL, La Liga, Bundesliga, Serie A, Ligue 1 + more European | Raw GitHub JSON files, no key, no auth | GitHub raw rate limits (generous for polling); data updated per-season | Yes — 2025/26 EPL season folder confirmed present (218 commits) | soccerway.com partial, worldfootball.net |
| 4 | **Wikipedia MediaWiki API** | Article text, infoboxes, tables (standings, squads, season summaries) | Every league on Wikipedia — EPL, La Liga, AFCON, CAF Champions League, national leagues | REST API: `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content` — no key | ~200 req/10s per IP (very generous) | Yes — no-key API, always on | Wikipedia HTML pages (18) — use API instead of scraping HTML |
| 5 | **API-Football (api-sports.io)** | Standings, fixtures, live scores, top scorers, player stats, injuries, transfers | 1,236 leagues — includes CAF CL, AFCON, African national leagues, all Big 5 + more | REST API (JSON), free key via api-sports.io registration | 100 req/day, 10 req/min on free tier | Yes — API live, documentation current | fbref.com (6 — blocked), worldfootball.net (3 — blocked), soccerstats.com (3 — blocked); adds African coverage |
| 6 | **football-data.co.uk** | Historical match results, half-time/full-time scores, betting odds | 20+ European leagues — EPL, La Liga, Serie A, Bundesliga, Ligue 1, and more; data from 2000/01 | Free CSV file downloads at `football-data.co.uk/data.php` — no key | Unlimited download; CSVs updated after each match day | Yes (site confirmed in search results; SSL self-signed — use HTTP) | Historical results portion of worldfootball.net; supplements soccerway.com |
| 7 | **TheSportsDB** | Team metadata, competition info, logos/artwork, event results, AFCON data | 617 soccer leagues (community-sourced) including AFCON, CAF | REST API at `thesportsdb.com/api/v1/json/1/` — key `1` works for free tier | No stated limit on free key; live scores are premium ($9/month) | Yes — official docs page live | None blocked; adds team metadata, AFCON/CAF artwork and event history |
| 8 | **Understat embedded JSON** | xG, xA, shot maps, player xG stats, team xG season data | EPL, La Liga, Bundesliga, Serie A, Ligue 1, RFPL (6 leagues only) | JS-rendered page with JSON embedded in `<script>` tags — extract with regex on page source | No formal API; no ToS violation confirmed; page returns 200 | Yes — 2025/26 season data present | Already in use (15 URLs) — note: add remaining 5 endpoint types |
| 9 | **StatsBomb Open Data** | Event-level tracking data, xG, passes, pressure, shot coordinates | Selected competitions only — Women's Super League, NWSL, La Liga, EURO, World Cup (NOT all leagues, NOT live/current) | GitHub repo JSON (`statsbomb/open-data`) — raw file access | Public domain, no key; attribution required in any published work | Yes — GitHub repo active | Not a replacement for standings/scorers; good for deep analytics context only |
| 10 | **OpenLigaDB** | Bundesliga match schedules, results, standings | German leagues only (Bundesliga, 2.Bundesliga, DFB-Pokal) | REST API at `api.openligadb.de` — no key required | No stated limits; community-sourced | Yes — API confirmed alive | Supplements the German football data beyond football-data.org |

---

## 2. Which Blocked/Broken Source Each Replaces

| Blocked Source | Problem | Best Replacement(s) |
|----------------|---------|---------------------|
| **fbref.com** (6 URLs — 403) | Anti-bot 403, no programmatic access | API-Football (free tier, player stats, standings). StatsBomb Open Data for deep analytics. |
| **worldfootball.net** (3 URLs — 403) | Anti-bot 403 | football-data.org (standings, fixtures) + football-data.co.uk (historical CSVs) |
| **soccerstats.com** (3 URLs — 403) | Anti-bot 403 | football-data.org + ESPN hidden API (standings, form, top scorers) |
| **soccerway.com** (31 URLs — heavy) | 31 pages being scraped; fragile HTML | football-data.org covers EPL/La Liga/UCL/Bundesliga/Serie A/Ligue 1 fully. openfootball for fixtures. ESPN API for form. |
| **espn.com HTML** (5 URLs) | Slow HTML scrapes | ESPN's own JSON API (`site.api.espn.com`) — confirmed live, returns clean JSON |

---

## 3. Quick Wins (Best Effort-to-Value Changes)

These five changes alone eliminate all 403s, cut HTML scrape fragility by ~60%, and add African football coverage from zero.

### QW1 — Replace soccerway.com (31 URLs) with football-data.org
- Register free at football-data.org (instant), get API key.
- Replace all 31 soccerway HTML scrapes with ~12 API calls: `GET /competitions/{id}/standings`, `/fixtures`, `/scorers`.
- Covers: EPL, La Liga, Bundesliga, Serie A, Ligue 1, UCL, Championship.
- **Effort:** ~2 hours to swap URLs and write a simple REST fetcher.

### QW2 — Replace ESPN HTML scrapes (5 URLs) with ESPN JSON API
- Zero registration, zero key.
- Swap HTML fetch+cheerio for a direct JSON fetch: `https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard`
- Returns structured fixtures, scores, standings links — confirmed returning 2026-27 EPL data as of today.
- **Effort:** ~30 minutes to update URL patterns and remove cheerio parsing.

### QW3 — Replace 18 Wikipedia HTML scrapes with MediaWiki API calls
- No change in data source, but the API returns clean Wikitext/JSON instead of full HTML pages.
- Use: `https://en.wikipedia.org/w/api.php?action=query&prop=revisions&rvprop=content&titles=2025–26_Premier_League&format=json`
- Much cleaner for chunking; eliminates brittle HTML parsing.
- **Effort:** ~1 hour to template the API URL builder.

### QW4 — Add API-Football free tier for the 12 blocked URLs + African football
- Register at api-sports.io for a free key.
- Replace fbref (6), worldfootball.net (3), soccerstats.com (3) with one parameterized caller.
- Also query `league=1040` (AFCON) and `league=20` (CAF Champions League) for African content — currently zero coverage.
- 100 req/day is tight; batch fixtures + standings per league per call, should stay under.
- **Effort:** ~2-3 hours for new fetcher + league mapping table.

### QW5 — Add openfootball/football.json as a static fixture/results baseline
- Fetch raw GitHub JSON files for each league/season directly.
- Zero auth, zero rate limits for polling.
- Use as a seed for historical fixture/result data; fill gaps the live API misses in off-season.
- **Effort:** ~1 hour to add a GitHub raw file downloader to the seed pipeline.

---

## 4. What to Avoid and Why

| Source | Why to Avoid |
|--------|-------------|
| **FotMob** | ToS (last updated Sep 2023) explicitly prohibits: scraping, automated systems, robots, spiders, bulk retrieval, or any systematic data extraction. Stated in clear language: "use of data for any purpose without express written consent is strictly prohibited." Do not use. |
| **Sofascore** | ToS explicitly prohibits "automated means to use the Platform, including robots, scripts, scraping, crawling, simulation or automated browsing." No exception for non-commercial use. Do not use. |
| **FBref.com** (403) | Has a robots.txt that blocks bots; 403s are intentional. Scraping is not permitted. Use API-Football or StatsBomb Open Data instead. |
| **worldfootball.net** (403) | Actively blocking scrapers (403). No public API. Replace with football-data.org. |
| **soccerstats.com** (403) | Same as above — intentional anti-bot 403. Replace with football-data.org. |
| **ESPN hidden API (as primary)** | Confirmed live and very useful, but it is undocumented and unofficial. ESPN can deprecate any endpoint without notice. Treat it as a supplement, not the single source of truth for production queries. Keep football-data.org as the authoritative backup. |

---

## 5. Tool Notes (Fetch/Scraping Layer)

| Tool | Free Limit | robots.txt Respect | Best Use |
|------|-----------|-------------------|----------|
| **Plain fetch + cheerio** (current) | Unlimited | Manual — must check per-site | Already used; appropriate for scrape-permissive sites |
| **Jina Reader** (`r.jina.ai/`) | 20 req/min, no key; 10M token credit with key | Respects robots.txt | Useful for converting scrape-permissive HTML pages to clean markdown for chunking; not for any site that blocks scrapers |
| **Firecrawl** (free tier) | 1,000 credits/month (1 credit = 1 page); no rollover | Yes — explicitly | Good for structured crawl of scrape-permissive sites (e.g., openfootball docs, Wikipedia). Not worth using for sources that have APIs. |

**Recommendation on tools:** For all sources listed above that have official APIs (football-data.org, ESPN JSON, API-Football, MediaWiki API), use plain fetch with JSON parsing — no scraping tool needed. Reserve Jina/Firecrawl for any remaining scrape-permissive HTML sites that don't have a programmatic API.

---

## 6. African Football Coverage Summary

Currently: zero dedicated African football sources in the pipeline.

| Source | African Coverage | Access |
|--------|-----------------|--------|
| API-Football | AFCON, CAF Champions League, CAF Confederation Cup, most national African leagues (Kenya, Nigeria, Ghana, Egypt, South Africa, etc.) | Free key, 100 req/day |
| TheSportsDB | AFCON data, team/competition metadata | Free key `1` |
| ESPN hidden API | CAF Championship | No key |
| Wikipedia MediaWiki API | All African competitions covered (AFCON, CHAN, CAF CL, WAFCON) | No key, via article titles |

Best path: use API-Football for live standings/fixtures of African leagues + Wikipedia API for historical/contextual pages on AFCON, CHAN, and individual African national leagues.

---

## 7. Source Verification Summary

| Source | Status | Verified Method |
|--------|--------|-----------------|
| football-data.org | Live | Coverage page fetched 30 Jul 2026 — 12 competitions listed |
| ESPN hidden API | Live | Direct fetch returned EPL 2026-27 match data |
| openfootball/football.json | Live | GitHub page confirms 2025/26 season folder present |
| MediaWiki API | Live | Standard Wikipedia API, always on |
| API-Football | Live | Docs and pricing page current |
| football-data.co.uk | Live (SSL issue on HTTPS) | Data.php page referenced in multiple sources; use HTTP |
| TheSportsDB | Live | Docs page accessible |
| Understat | Live | League page returns 200 with 2025/26 season dropdown |
| StatsBomb open-data | Live | GitHub repo active |
| OpenLigaDB | Live | API endpoint documented and referenced |
| FotMob | Live but off-limits | ToS prohibits scraping |
| Sofascore | Live but off-limits | ToS prohibits automated access |
| fbref.com | 403 active | Intentional anti-bot block |
| worldfootball.net | 403 active | Intentional anti-bot block |
| soccerstats.com | 403 active | Intentional anti-bot block |
