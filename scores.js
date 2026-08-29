// scores.js
// Live football scores app, using apifootball.com
//
// Sign up:  https://apifootball.com/register/
// Your key: on the dashboard after you log in

const http = require("http");

const API_KEY = process.env.APIFOOTBALL_KEY || "PASTE_YOUR_KEY_HERE";
const PORT = process.env.PORT || 3000;
const BASE = "https://apiv3.apifootball.com/";

// Leagues to start with. The free plan only carries two, so these
// are them. Once you upgrade, add more from the Leagues screen.
const MY_LEAGUES = [
  { id: 63,  name: "Championship", table: true },
  { id: 169, name: "Ligue 2",      table: true },
];

const MY_LEAGUE_IDS = MY_LEAGUES.map(function (l) { return l.id; });


// ---------------------------------------------------------------
// TALKING TO THE API
// Everything goes through here, so if the provider ever changes
// again this is the only part that needs rewriting.
// ---------------------------------------------------------------
async function askApi(action, extra) {
  if (!API_KEY || API_KEY === "PASTE_YOUR_KEY_HERE") {
    console.log("!! NO API KEY SET. Check the APIFOOTBALL_KEY setting.");
    return null;
  }

  const url = BASE + "?action=" + action + (extra || "") + "&APIkey=" + API_KEY;

  // Never print the key itself into the logs.
  console.log("fetching: " + action + (extra || ""));

  let response;
  try {
    response = await fetch(url);
  } catch (error) {
    console.log("   !! could not reach the API: " + error.message);
    return null;
  }

  console.log("   http status: " + response.status);

  let data;
  try {
    data = await response.json();
  } catch (error) {
    console.log("   !! answer was not readable");
    return null;
  }

  // This API reports trouble as an object with an error number,
  // rather than as a list. A list means it worked.
  if (!Array.isArray(data)) {
    console.log("   !! API SAYS: " + JSON.stringify(data).slice(0, 300));
    return null;
  }

  console.log("   " + data.length + " rows back");
  return data;
}


// ---------------------------------------------------------------
// TRANSLATION
// apifootball sends one shape, the screens expect another. These
// two functions are the bridge between them.
// ---------------------------------------------------------------
function numberOrNull(value) {
  if (value === "" || value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isNaN(n) ? null : n;
}

function readStatus(raw) {
  const status = (raw.match_status || "").trim();

  // Empty means it has not kicked off yet.
  if (status === "") {
    return { short: "NS", long: "Not started", elapsed: null };
  }
  if (status === "Finished" || status === "FT") {
    return { short: "FT", long: "Finished", elapsed: null };
  }
  if (status === "Half Time" || status === "HT") {
    return { short: "HT", long: "Half time", elapsed: null };
  }
  if (status === "Postponed" || status === "Cancelled") {
    return { short: "PST", long: status, elapsed: null };
  }

  // Anything else is the minute, sometimes with a + on it.
  const minute = parseInt(status, 10);
  if (!Number.isNaN(minute)) {
    return { short: "LIVE", long: "In play", elapsed: minute };
  }

  return { short: status, long: status, elapsed: null };
}

function translateMatch(raw) {
  const goals = raw.goalscorer || [];

  return {
    fixture: {
      id: Number(raw.match_id),
      // Their date and time arrive separately.
      date: raw.match_date + "T" + (raw.match_time || "00:00") + ":00",
      status: readStatus(raw),
    },
    league: {
      id: Number(raw.league_id),
      name: raw.league_name,
      country: raw.country_name,
      logo: raw.league_logo || raw.country_logo || "",
    },
    teams: {
      home: { name: raw.match_hometeam_name, logo: raw.team_home_badge || "" },
      away: { name: raw.match_awayteam_name, logo: raw.team_away_badge || "" },
    },
    goals: {
      home: numberOrNull(raw.match_hometeam_score),
      away: numberOrNull(raw.match_awayteam_score),
    },
    // Goals only, in the shape the match screen already reads.
    events: goals
      .filter(function (g) { return g.home_scorer || g.away_scorer; })
      .map(function (g) {
        const isHome = Boolean(g.home_scorer);
        return {
          type: "Goal",
          time: { elapsed: parseInt(g.time, 10) || 0 },
          player: { name: isHome ? g.home_scorer : g.away_scorer },
          team: { name: isHome ? raw.match_hometeam_name : raw.match_awayteam_name },
        };
      }),
    statistics: raw.statistics || [],
  };
}

function translateTableRow(raw) {
  const scored = Number(raw.overall_league_GF) || 0;
  const conceded = Number(raw.overall_league_GA) || 0;

  return {
    rank: Number(raw.overall_league_position),
    team: { name: raw.team_name, logo: raw.team_badge || "" },
    // Their spelling of "played" has a typo in it, so try both.
    all: { played: Number(raw.overall_league_payed || raw.overall_league_played) || 0 },
    goalsDiff: scored - conceded,
    points: Number(raw.overall_league_PTS) || 0,
    // This API does not say what each position means, so no
    // promotion or relegation colours for now.
    description: "",
  };
}


// ---------------------------------------------------------------
// THE CACHE
// ---------------------------------------------------------------
const cache = {};

function fromCache(name, maxAgeSeconds) {
  const saved = cache[name];
  if (!saved) return null;
  const age = (Date.now() - saved.time) / 1000;
  if (age >= maxAgeSeconds) return null;
  console.log("cache hit: " + name + " (" + Math.round(age) + "s old)");
  return saved.data;
}

function intoCache(name, data) {
  cache[name] = { data: data, time: Date.now() };
  return data;
}

async function getLiveScores() {
  const hit = fromCache("live", 60);
  if (hit) return hit;

  const raw = await askApi("get_events", "&match_live=1");
  if (raw === null) return cache["live"] ? cache["live"].data : [];

  return intoCache("live", raw.map(translateMatch));
}

async function getFixturesFor(date) {
  const name = "fixtures-" + date;
  const hit = fromCache(name, 600);
  if (hit) return hit;

  const raw = await askApi("get_events", "&from=" + date + "&to=" + date);
  if (raw === null) return cache[name] ? cache[name].data : [];

  return intoCache(name, raw.map(translateMatch));
}

async function getTableFor(leagueId) {
  const name = "table-" + leagueId;
  const hit = fromCache(name, 1800);
  if (hit) return hit;

  const raw = await askApi("get_standings", "&league_id=" + leagueId);
  if (raw === null) return cache[name] ? cache[name].data : [];

  const rows = raw
    .map(translateTableRow)
    .sort(function (a, b) { return a.rank - b.rank; });

  return intoCache(name, rows);
}

async function getMatch(fixtureId) {
  const name = "match-" + fixtureId;
  const hit = fromCache(name, 60);
  if (hit) return hit;

  const raw = await askApi("get_events", "&match_id=" + fixtureId);
  if (raw === null || raw.length === 0) {
    return cache[name] ? cache[name].data : null;
  }

  return intoCache(name, translateMatch(raw[0]));
}

// Fixtures for one league across a date range.
async function getLeagueFixtures(leagueId, from, to) {
  const name = "lf-" + leagueId + "-" + from;
  const hit = fromCache(name, 900);
  if (hit) return hit;

  const raw = await askApi("get_events",
    "&league_id=" + leagueId + "&from=" + from + "&to=" + to);
  if (raw === null) return cache[name] ? cache[name].data : [];

  return intoCache(name, raw.map(translateMatch));
}

// Every club in a league.
async function getTeams(leagueId) {
  const name = "teams-" + leagueId;
  const hit = fromCache(name, 86400);
  if (hit) return hit;

  const raw = await askApi("get_teams", "&league_id=" + leagueId);
  if (raw === null) return cache[name] ? cache[name].data : [];

  const teams = raw.map(function (t) {
    return {
      id: Number(t.team_key),
      name: t.team_name,
      logo: t.team_badge || "",
      squad: (t.players || []).length,
    };
  });

  return intoCache(name, teams);
}

// Leading scorers, used for the Statistics tab.
async function getTopScorers(leagueId) {
  const name = "scorers-" + leagueId;
  const hit = fromCache(name, 3600);
  if (hit) return hit;

  const raw = await askApi("get_topscorers", "&league_id=" + leagueId);
  if (raw === null) return cache[name] ? cache[name].data : [];

  const scorers = raw.map(function (s) {
    return {
      place: Number(s.player_place) || 0,
      name: s.player_name,
      team: s.team_name,
      goals: Number(s.goals) || 0,
      assists: Number(s.assists) || 0,
      penalties: Number(s.penalty_goals) || 0,
    };
  });

  return intoCache(name, scorers);
}

async function getAllLeagues() {
  const hit = fromCache("allLeagues", 86400);
  if (hit) return hit;

  const raw = await askApi("get_leagues", "");
  if (raw === null) return cache["allLeagues"] ? cache["allLeagues"].data : [];

  const list = raw.map(function (item) {
    return {
      id: Number(item.league_id),
      name: item.league_name,
      country: item.country_name,
      logo: item.league_logo || item.country_logo || "",
      type: "League",
    };
  });

  return intoCache("allLeagues", list);
}

function onlyTheirLeagues(matches, leagueIds) {
  return matches.filter(function (match) {
    return leagueIds.includes(match.league.id);
  });
}

function leagueIdsFrom(address) {
  const raw = address.searchParams.get("leagues");
  if (!raw) return MY_LEAGUE_IDS;

  const ids = raw.split(",")
    .map(Number)
    .filter(function (n) { return Number.isInteger(n) && n > 0; })
    .slice(0, 200);

  return ids.length > 0 ? ids : MY_LEAGUE_IDS;
}


// ---------------------------------------------------------------
// THE PAGE
// ---------------------------------------------------------------
const PAGE = `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Live Scores</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    margin: 0; background: #F4F4F2; color: #1a1a1a;
    padding-bottom: 70px;
  }
  .header { background: #185FA5; padding: 14px 16px 0; }
  .headerTop {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 10px;
  }
  .title { font-size: 18px; font-weight: 500; color: #fff; }
  .badges { display: flex; align-items: center; gap: 10px; }
  .coins {
    display: flex; align-items: center; gap: 4px;
    background: #042C53; padding: 4px 10px; border-radius: 12px;
    font-size: 13px; color: #FAC775;
  }
  .level {
    width: 34px; height: 34px; border-radius: 50%;
    background: #EF9F27; color: #412402;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 600;
  }
  .xpRow { display: flex; align-items: center; gap: 8px; padding-bottom: 12px; }
  .xpTrack { flex: 1; height: 5px; background: #042C53; border-radius: 3px; overflow: hidden; }
  .xpFill { height: 100%; background: #EF9F27; width: 0%; }
  .xpText { font-size: 11px; color: #B5D4F4; }

  .dates { display: flex; }
  .dateBtn {
    flex: 1; text-align: center; padding: 6px 0 8px;
    color: #85B7EB; cursor: pointer; border-bottom: 2px solid transparent;
  }
  .dateBtn.on { color: #EF9F27; border-bottom-color: #EF9F27; }
  .dateDay { font-size: 11px; }
  .dateNum { font-size: 15px; margin-top: 2px; }

  .picker {
    display: flex; align-items: center; justify-content: space-between;
    background: #042C53; border-radius: 6px; padding: 9px 12px;
    margin-bottom: 12px; color: #fff; font-size: 14px;
  }
  .picker select {
    background: transparent; border: none; color: #fff;
    font-size: 14px; width: 100%; outline: none;
  }
  .picker select option { background: #042C53; color: #fff; }

  .searchBox {
    display: flex; align-items: center; gap: 8px;
    background: #fff; border-radius: 6px; padding: 9px 12px;
    margin-bottom: 12px;
  }
  .searchBox input {
    border: none; outline: none; font-size: 14px;
    width: 100%; background: transparent;
  }

  .updated { padding: 8px 16px; font-size: 12px; color: #777; }
  .leagueRow, .countryRow {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 16px; background: #E8E8E4;
    font-size: 12px; color: #555;
  }
  .leagueLogo { width: 16px; height: 16px; object-fit: contain; }

  .match {
    display: flex; align-items: center; gap: 12px;
    padding: 12px 16px; background: #fff;
    border-bottom: 1px solid #E8E8E4;
  }
  .when { width: 44px; font-size: 12px; color: #BA7517; flex-shrink: 0; }
  .when.grey { color: #777; }
  .teams { flex: 1; min-width: 0; }
  .teamRow {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .teamRow:first-child { margin-bottom: 7px; }
  .teamName { display: flex; align-items: center; gap: 8px; font-size: 15px; min-width: 0; }
  .teamName span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .crest { width: 22px; height: 22px; object-fit: contain; flex-shrink: 0; }
  .goals { font-size: 15px; font-weight: 600; flex-shrink: 0; }
  .bell { font-size: 17px; color: #ccc; cursor: pointer; flex-shrink: 0; user-select: none; }
  .bell.on { color: #EF9F27; }

  .leagueItem {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px; background: #fff;
    border-bottom: 1px solid #E8E8E4; cursor: pointer;
  }
  .leagueItem img { width: 20px; height: 20px; object-fit: contain; flex-shrink: 0; }
  .leagueItem .nm { flex: 1; font-size: 15px; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .liveTag {
    font-size: 12px; padding: 3px 9px; border-radius: 10px;
    background: #FAEEDA; color: #854F0B; flex-shrink: 0;
  }
  .star { font-size: 18px; color: #ccc; flex-shrink: 0; user-select: none; }
  .star.on { color: #EF9F27; }

  .tableHead {
    display: flex; padding: 8px 16px; background: #E8E8E4;
    font-size: 11px; color: #555;
  }
  .tableRow {
    display: flex; align-items: center; padding: 10px 16px;
    background: #fff; border-bottom: 1px solid #E8E8E4;
  }
  .colPos { width: 22px; font-size: 13px; color: #777; }
  .colTeam { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; }
  .colTeam span { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .colTeam img { width: 20px; height: 20px; object-fit: contain; flex-shrink: 0; }
  .colNum { width: 30px; text-align: center; font-size: 13px; color: #777; }
  .colPts { width: 32px; text-align: right; font-size: 14px; font-weight: 600; }

  .matchHead { background: #185FA5; padding: 12px 16px 16px; }
  .matchTop {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 14px;
  }
  .back { font-size: 20px; color: #fff; cursor: pointer; user-select: none; }
  .comp { font-size: 12px; color: #B5D4F4; }
  .scoreLine { display: flex; align-items: center; }
  .side { flex: 1; text-align: center; }
  .side img { width: 44px; height: 44px; object-fit: contain; margin-bottom: 8px; }
  .side div { font-size: 13px; color: #fff; }
  .bigScore { text-align: center; padding: 0 8px; }
  .bigScore .nums { font-size: 30px; font-weight: 600; color: #fff; }
  .bigScore .clock { font-size: 12px; color: #EF9F27; margin-top: 2px; }

  .tabs { display: flex; background: #fff; border-bottom: 1px solid #E8E8E4; }
  .tab {
    flex: 1; text-align: center; padding: 11px 0;
    font-size: 14px; color: #777; cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  .tab.on { color: #185FA5; border-bottom-color: #185FA5; }

  .event {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 16px; background: #fff;
    border-bottom: 1px solid #E8E8E4;
  }
  .evMin { width: 34px; font-size: 12px; color: #777; }
  .evIcon { font-size: 15px; width: 20px; }
  .evName { font-size: 14px; flex: 1; }
  .evTeam { font-size: 12px; color: #999; }

  .statBox { padding: 16px; background: #fff; }
  .stat { margin-bottom: 16px; }
  .stat:last-child { margin-bottom: 0; }
  .statTop {
    display: flex; justify-content: space-between; align-items: center;
    margin-bottom: 6px;
  }
  .statVal { font-size: 14px; font-weight: 600; }
  .statName { font-size: 13px; color: #777; }
  .statBar { display: flex; height: 6px; border-radius: 3px; overflow: hidden; background: #E8E8E4; }
  .statHome { background: #185FA5; }
  .statAway { background: #EF9F27; }

  .empty { padding: 50px 24px; text-align: center; color: #777; line-height: 1.6; }

  /* Slide-out country drawer */
  .burger {
    font-size: 20px; color: #fff; cursor: pointer;
    user-select: none; margin-right: 12px; line-height: 1;
  }
  .shade {
    position: fixed; inset: 0; background: rgba(0,0,0,0.5);
    opacity: 0; pointer-events: none; transition: opacity 0.2s;
    z-index: 40;
  }
  .shade.open { opacity: 1; pointer-events: auto; }
  .drawer {
    position: fixed; top: 0; left: 0; bottom: 0; width: 280px;
    max-width: 82vw; background: #fff; z-index: 50;
    transform: translateX(-100%); transition: transform 0.22s;
    display: flex; flex-direction: column;
  }
  .drawer.open { transform: translateX(0); }
  .drawerTop {
    background: #185FA5; color: #fff; padding: 16px;
    display: flex; align-items: center; justify-content: space-between;
    flex-shrink: 0;
  }
  .drawerTop span:first-child { font-size: 16px; font-weight: 500; }
  .drawerClose { font-size: 20px; cursor: pointer; user-select: none; }
  .drawerBody { overflow-y: auto; flex: 1; }
  .drawerHint {
    padding: 8px 16px; background: #E8E8E4;
    font-size: 11px; color: #666; text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .countryItem {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px; cursor: pointer;
    border-bottom: 1px solid #EFEFEC;
  }
  .countryItem img { width: 18px; height: 18px; object-fit: contain; flex-shrink: 0; }
  .countryItem .cname { flex: 1; font-size: 14px; }
  .countryItem .arrow { font-size: 11px; color: #999; }
  .leagueChild {
    padding: 10px 16px 10px 44px; font-size: 13px;
    color: #444; cursor: pointer; background: #FAFAF8;
    border-bottom: 1px solid #EFEFEC;
  }
  .leagueChild:hover { background: #F0F0EC; }

  /* League screen */
  .leagueHead { background: #185FA5; padding: 12px 16px 0; }
  .leagueHeadTop {
    display: flex; align-items: center; gap: 12px; margin-bottom: 12px;
  }
  .leagueHeadTop img { width: 28px; height: 28px; object-fit: contain; }
  .leagueHeadTop .txt { flex: 1; min-width: 0; }
  .leagueHeadTop .ln {
    font-size: 16px; font-weight: 500; color: #fff;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .leagueHeadTop .cn { font-size: 12px; color: #B5D4F4; }
  .leagueTabs { display: flex; }
  .lTab {
    flex: 1; text-align: center; padding: 9px 0 8px;
    font-size: 13px; color: #85B7EB; cursor: pointer;
    border-bottom: 2px solid transparent;
  }
  .lTab.on { color: #EF9F27; border-bottom-color: #EF9F27; }

  .scorerRow {
    display: flex; align-items: center; gap: 12px;
    padding: 11px 16px; background: #fff;
    border-bottom: 1px solid #E8E8E4;
  }
  .scorerRow .pl { width: 22px; font-size: 13px; color: #777; }
  .scorerRow .who { flex: 1; min-width: 0; }
  .scorerRow .pn {
    font-size: 14px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .scorerRow .tn { font-size: 12px; color: #999; }
  .scorerRow .gl { font-size: 15px; font-weight: 600; }

  .teamRowItem {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px; background: #fff;
    border-bottom: 1px solid #E8E8E4;
  }
  .teamRowItem img { width: 24px; height: 24px; object-fit: contain; flex-shrink: 0; }
  .teamRowItem span { font-size: 14px; }

  .nav {
    position: fixed; bottom: 0; left: 0; right: 0;
    display: flex; background: #fff; border-top: 1px solid #E8E8E4; padding: 8px 0;
  }
  .navItem { flex: 1; text-align: center; font-size: 11px; color: #999; cursor: pointer; }
  .navItem.on { color: #185FA5; }
  .navIcon { font-size: 18px; display: block; margin-bottom: 2px; }
</style>
</head>
<body>

<div class="shade" id="shade"></div>
<div class="drawer" id="drawer">
  <div class="drawerTop">
    <span>Countries</span>
    <span class="drawerClose" id="drawerClose">&#10005;</span>
  </div>
  <div class="drawerBody" id="drawerBody"></div>
</div>

<div class="header" id="mainHeader">
  <div class="headerTop">
    <div style="display:flex; align-items:center; min-width:0">
      <span class="burger" id="burger">&#9776;</span>
      <div class="title" id="screenTitle">Live scores</div>
    </div>
    <div class="badges">
      <div class="coins">&#9679; <span id="coins">0</span></div>
      <div class="level" id="level">1</div>
    </div>
  </div>
  <div class="xpRow">
    <div class="xpTrack"><div class="xpFill" id="xpFill"></div></div>
    <div class="xpText"><span id="xpText">0 / 1000 xp</span></div>
  </div>
  <div class="dates" id="dates" style="display:none"></div>
  <div id="pickerBox" style="display:none"></div>
  <div id="searchArea" style="display:none">
    <div class="searchBox">
      <span style="color:#888">&#128269;</span>
      <input id="searchInput" placeholder="Search country or league" autocomplete="off">
    </div>
  </div>
</div>

<div id="matchHead"></div>
<div id="leagueHead"></div>
<div class="updated" id="updated">Loading...</div>
<div id="list"></div>

<div class="nav">
  <div class="navItem on" id="navScores"><span class="navIcon">&#9917;</span>Scores</div>
  <div class="navItem" id="navFixtures"><span class="navIcon">&#128197;</span>Fixtures</div>
  <div class="navItem" id="navLeagues"><span class="navIcon">&#127942;</span>Leagues</div>
  <div class="navItem" id="navTables"><span class="navIcon">&#9776;</span>Tables</div>
  <div class="navItem" id="navTeams"><span class="navIcon">&#9733;</span>Teams</div>
</div>

<script>
const LEAGUES = __LEAGUES__;

// ---------------------------------------------------------------
// XP AND COINS
// ---------------------------------------------------------------
function load(name, fallback) {
  const value = localStorage.getItem(name);
  return value === null ? fallback : Number(value);
}

let xp = load("xp", 0);
let coins = load("coins", 0);
let alerts = JSON.parse(localStorage.getItem("alerts") || "[]");

// The key is versioned, so switching data provider does not leave
// old league numbers behind that mean nothing any more.
let myLeagues = JSON.parse(localStorage.getItem("myLeagues_v2") || "null");
if (myLeagues === null) {
  myLeagues = LEAGUES.map(function (l) { return l.id; });
}

let leagueNames = JSON.parse(localStorage.getItem("leagueNames_v2") || "null");
if (leagueNames === null) {
  leagueNames = {};
  for (const l of LEAGUES) leagueNames[l.id] = l.name;
}

const today = new Date().toDateString();
if (localStorage.getItem("lastOpen") !== today) {
  xp = xp + 5;
  coins = coins + 2;
  localStorage.setItem("lastOpen", today);
}

function saveProgress() {
  localStorage.setItem("xp", xp);
  localStorage.setItem("coins", coins);
  localStorage.setItem("alerts", JSON.stringify(alerts));
}

function saveLeagues() {
  localStorage.setItem("myLeagues_v2", JSON.stringify(myLeagues));
  localStorage.setItem("leagueNames_v2", JSON.stringify(leagueNames));
}
saveLeagues();

function leagueParam() {
  return "leagues=" + myLeagues.join(",");
}

function drawProgress() {
  const level = Math.floor(xp / 1000) + 1;
  const intoLevel = xp % 1000;
  document.getElementById("level").textContent = level;
  document.getElementById("coins").textContent = coins;
  document.getElementById("xpFill").style.width = (intoLevel / 10) + "%";
  document.getElementById("xpText").textContent = intoLevel + " / 1000 xp";
}

function toggleAlert(fixtureId, element) {
  const position = alerts.indexOf(fixtureId);
  if (position === -1) {
    alerts.push(fixtureId);
    element.classList.add("on");
  } else {
    alerts.splice(position, 1);
    element.classList.remove("on");
  }
  saveProgress();
}


// ---------------------------------------------------------------
// WHICH SCREEN
// ---------------------------------------------------------------
let screen = "scores";

function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

let chosenDate = isoDate(new Date());

function goTo(name) {
  screen = name;

  // Coming back from a league or match page.
  document.getElementById("leagueHead").innerHTML = "";
  document.getElementById("matchHead").innerHTML = "";
  document.getElementById("mainHeader").style.display = "block";

  const items = ["Scores", "Fixtures", "Leagues", "Tables", "Teams"];
  const keys = ["scores", "fixtures", "leagues", "tables", "teams"];
  for (let i = 0; i < items.length; i++) {
    document.getElementById("nav" + items[i]).classList.toggle("on", name === keys[i]);
  }

  document.getElementById("dates").style.display = name === "fixtures" ? "flex" : "none";
  document.getElementById("pickerBox").style.display = name === "tables" ? "block" : "none";
  document.getElementById("searchArea").style.display = name === "leagues" ? "block" : "none";

  const titles = {
    scores: "Live scores", fixtures: "Fixtures",
    leagues: "Leagues", tables: "Tables", teams: "My teams"
  };
  document.getElementById("screenTitle").textContent = titles[name];

  refresh();
}

document.getElementById("navScores").onclick = function () { goTo("scores"); };
document.getElementById("navFixtures").onclick = function () { goTo("fixtures"); };
document.getElementById("navLeagues").onclick = function () { goTo("leagues"); };
document.getElementById("navTables").onclick = function () { goTo("tables"); };
document.getElementById("navTeams").onclick = function () { goTo("teams"); };


// ---------------------------------------------------------------
// DATE STRIP
// ---------------------------------------------------------------
function drawDates() {
  const strip = document.getElementById("dates");
  strip.innerHTML = "";
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  for (let offset = -1; offset <= 3; offset++) {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    const iso = isoDate(date);

    const button = document.createElement("div");
    button.className = "dateBtn" + (iso === chosenDate ? " on" : "");
    button.innerHTML =
      '<div class="dateDay">' + dayNames[date.getDay()] + '</div>' +
      '<div class="dateNum">' + date.getDate() + '</div>';
    button.onclick = function () {
      chosenDate = iso;
      drawDates();
      refresh();
    };
    strip.appendChild(button);
  }
}


// ---------------------------------------------------------------
// DRAWING MATCHES
// ---------------------------------------------------------------
function drawMatches(matches, showKickoffTimes) {
  const list = document.getElementById("list");
  list.innerHTML = "";

  if (matches.length === 0) {
    list.innerHTML = '<div class="empty">Nothing to show here.</div>';
    return;
  }

  let lastLeague = null;

  for (const match of matches) {
    if (match.league.name !== lastLeague) {
      const heading = document.createElement("div");
      heading.className = "leagueRow";
      heading.innerHTML =
        (match.league.logo ? '<img class="leagueLogo" src="' + match.league.logo + '" alt="">' : '') +
        match.league.country + ' - ' + match.league.name;
      list.appendChild(heading);
      lastLeague = match.league.name;
    }

    let when;
    let whenClass = "when";

    if (showKickoffTimes) {
      const kickoff = new Date(match.fixture.date);
      when = isNaN(kickoff) ? "--:--"
        : kickoff.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      whenClass = "when grey";
    } else if (match.fixture.status.elapsed !== null) {
      when = match.fixture.status.elapsed + "'";
    } else {
      when = match.fixture.status.short;
      whenClass = "when grey";
    }

    const homeGoals = match.goals.home === null ? "-" : match.goals.home;
    const awayGoals = match.goals.away === null ? "-" : match.goals.away;
    const isOn = alerts.includes(match.fixture.id);

    const row = document.createElement("div");
    row.className = "match";
    row.innerHTML =
      '<div class="' + whenClass + '">' + when + '</div>' +
      '<div class="teams">' +
        '<div class="teamRow">' +
          '<div class="teamName">' +
            '<img class="crest" src="' + match.teams.home.logo + '" alt="">' +
            '<span>' + match.teams.home.name + '</span>' +
          '</div>' +
          '<div class="goals">' + homeGoals + '</div>' +
        '</div>' +
        '<div class="teamRow">' +
          '<div class="teamName">' +
            '<img class="crest" src="' + match.teams.away.logo + '" alt="">' +
            '<span>' + match.teams.away.name + '</span>' +
          '</div>' +
          '<div class="goals">' + awayGoals + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="bell' + (isOn ? ' on' : '') + '">&#128276;</div>';

    const bell = row.querySelector(".bell");
    bell.onclick = function (event) {
      event.stopPropagation();
      toggleAlert(match.fixture.id, bell);
    };

    row.style.cursor = "pointer";
    row.onclick = function () { openMatch(match.fixture.id); };

    list.appendChild(row);
  }
}


// ---------------------------------------------------------------
// TABLES
// ---------------------------------------------------------------
let chosenLeague = MY_LEAGUE_ID_FALLBACK();

function MY_LEAGUE_ID_FALLBACK() {
  return LEAGUES.length > 0 ? LEAGUES[0].id : 0;
}

function drawPicker() {
  const box = document.getElementById("pickerBox");

  if (myLeagues.length === 0) {
    box.innerHTML = '<div class="picker">No leagues followed</div>';
    return;
  }

  if (!myLeagues.includes(chosenLeague)) chosenLeague = myLeagues[0];

  let options = "";
  for (const id of myLeagues) {
    const selected = id === chosenLeague ? " selected" : "";
    const name = leagueNames[id] || ("League " + id);
    options += '<option value="' + id + '"' + selected + '>' + name + '</option>';
  }

  box.innerHTML = '<div class="picker"><select id="leaguePick">' + options + '</select></div>';

  document.getElementById("leaguePick").onchange = function (event) {
    chosenLeague = Number(event.target.value);
    refresh();
  };
}

function drawTable(rows) {
  const list = document.getElementById("list");
  list.innerHTML = "";

  if (rows.length === 0) {
    list.innerHTML =
      '<div class="empty">No table for this league.<br><br>' +
      'It may not be included in your plan.</div>';
    return;
  }

  const head = document.createElement("div");
  head.className = "tableHead";
  head.innerHTML =
    '<span class="colPos">#</span><span class="colTeam">Team</span>' +
    '<span class="colNum">P</span><span class="colNum">GD</span>' +
    '<span class="colPts">Pts</span>';
  list.appendChild(head);

  for (const entry of rows) {
    const row = document.createElement("div");
    row.className = "tableRow";
    row.innerHTML =
      '<span class="colPos">' + entry.rank + '</span>' +
      '<span class="colTeam">' +
        '<img src="' + entry.team.logo + '" alt="">' +
        '<span>' + entry.team.name + '</span>' +
      '</span>' +
      '<span class="colNum">' + entry.all.played + '</span>' +
      '<span class="colNum">' + (entry.goalsDiff > 0 ? "+" : "") + entry.goalsDiff + '</span>' +
      '<span class="colPts">' + entry.points + '</span>';
    list.appendChild(row);
  }
}


// ---------------------------------------------------------------
// LEAGUES SCREEN
// ---------------------------------------------------------------
let allLeagues = null;
let liveCounts = {};
let searchText = "";

document.getElementById("searchInput").oninput = function (event) {
  searchText = event.target.value.trim().toLowerCase();
  drawLeagues();
};

function toggleFollow(league) {
  const position = myLeagues.indexOf(league.id);
  if (position === -1) {
    myLeagues.push(league.id);
    leagueNames[league.id] = league.name;
  } else {
    myLeagues.splice(position, 1);
  }
  saveLeagues();
  drawPicker();
  drawLeagues();
}

function drawLeagues() {
  const list = document.getElementById("list");
  list.innerHTML = "";

  if (allLeagues === null) {
    list.innerHTML = '<div class="empty">Loading leagues...</div>';
    return;
  }

  let shown;
  if (searchText === "") {
    shown = allLeagues.filter(function (l) { return myLeagues.includes(l.id); });
  } else {
    shown = allLeagues.filter(function (l) {
      return l.name.toLowerCase().includes(searchText) ||
             l.country.toLowerCase().includes(searchText);
    }).slice(0, 60);
  }

  if (shown.length === 0) {
    list.innerHTML = '<div class="empty">Nothing found.<br><br>Try a country name.</div>';
    return;
  }

  shown.sort(function (a, b) {
    if (a.country !== b.country) return a.country.localeCompare(b.country);
    return a.name.localeCompare(b.name);
  });

  let lastCountry = null;

  for (const league of shown) {
    if (league.country !== lastCountry) {
      const heading = document.createElement("div");
      heading.className = "countryRow";
      heading.textContent = league.country;
      list.appendChild(heading);
      lastCountry = league.country;
    }

    const following = myLeagues.includes(league.id);
    const count = liveCounts[league.id] || 0;

    const row = document.createElement("div");
    row.className = "leagueItem";
    row.innerHTML =
      '<img src="' + league.logo + '" alt="">' +
      '<span class="nm">' + league.name + '</span>' +
      (count > 0 ? '<span class="liveTag">' + count + ' live</span>' : '') +
      '<span class="star' + (following ? ' on' : '') + '">&#9733;</span>';

    row.onclick = function () { toggleFollow(league); };
    list.appendChild(row);
  }
}


// ---------------------------------------------------------------
// THE COUNTRY DRAWER
//
// These nine sit at the top in this order. Everything else falls
// in alphabetically underneath.
// ---------------------------------------------------------------
const PINNED = [
  "England", "Germany", "Scotland", "France",
  "Italy", "Spain", "Portugal", "Netherlands", "USA"
];

// The API does not always use the name people expect.
const ALSO_KNOWN_AS = {
  "Netherlands": ["Holland"],
  "USA": ["United States", "United States of America", "Usa"],
};

let openCountry = null;   // which country is expanded in the drawer


// ===============================================================
// LEAGUE RANKING
//
// The API hands over every competition it has, including youth,
// reserve and amateur ones, in no particular order. These lists
// decide what is shown and in what order.
//
// To change what appears for a country, edit its list below.
// ===============================================================

// Exact running order for the countries that matter most.
// Each line is one tier. The words inside are alternative
// spellings the API might use for that same tier.
const LEAGUE_ORDER = {
  "England": [
    ["premier league"], ["championship"], ["league one"],
    ["league two"], ["national league"],
  ],
  "Germany":     [["bundesliga"], ["2. bundesliga", "2 bundesliga"], ["3. liga", "3 liga"]],
  "Scotland":    [["premiership"], ["championship"], ["league one"], ["league two"]],
  "France":      [["ligue 1"], ["ligue 2"], ["national 1", "championnat national"]],
  "Italy":       [["serie a"], ["serie b"], ["serie c"]],
  "Spain":       [["la liga", "primera division"], ["segunda division", "la liga 2"], ["primera federacion"]],
  "Portugal":    [["primeira liga", "liga portugal"], ["liga portugal 2", "segunda liga", "liga 2"]],
  "Netherlands": [["eredivisie"], ["eerste divisie"]],
  "USA":         [["mls", "major league soccer"], ["usl championship"], ["usl league one"]],
};

// Women's leagues. Top two tiers only, shown below the men's.
const WOMEN_ORDER = {
  "England":     [["super league"], ["championship"]],
  "Germany":     [["bundesliga"], ["2. bundesliga", "2 bundesliga"]],
  "Scotland":    [["premier league"], ["championship"]],
  "France":      [["division 1", "premiere ligue", "d1"], ["division 2", "d2"]],
  "Italy":       [["serie a"], ["serie b"]],
  "Spain":       [["liga f", "primera division"], ["segunda"]],
  "Portugal":    [["campeonato nacional", "liga bpi"], ["segunda"]],
  "Netherlands": [["eredivisie"], ["eerste divisie"]],
  "USA":         [["nwsl", "national women's soccer league"], ["usl super league"]],
};

// Anything whose name contains one of these is dropped entirely.
// This is where the amateur and youth competitions go.
const NOT_WANTED = [
  "u21", "u-21", "u23", "u-23", "u19", "u-19", "u18", "u-18",
  "u17", "u-17", "u20", "u-20", "youth", "junior", "juvenil",
  "reserve", "academy", "amateur", "primavera", "development",
  "regionalliga", "oberliga", "landesliga", "kreisliga",
  "bezirksliga", "verbandsliga", "county", "sunday",
  "veteran", "futsal", "beach", "indoor", "friendly",
  "trial", "test", "esport", "virtual", "simulated",
  // Regional splits below the professional pyramid.
  "national league north", "national league south",
  "isthmian", "northern premier", "southern league",
];

const WOMENS_WORDS = [
  "women", "woman", "feminine", "femenin", "feminin",
  "frauen", "femminile", "damallsvenskan", "naisten",
  "kvinner", "kvinnor", "nwsl", "w-league", "(w)",
];

// Rough tiers for every other country, since we cannot list
// them all by hand. Earlier groups rank higher.
const GENERIC_TIERS = [
  ["premier", "primera", "serie a", "super league", "superliga",
   "superligaen", "bundesliga", "eredivisie", "ligue 1", "liga 1",
   "premiership", "first division", "division 1", "allsvenskan",
   "eliteserien", "ekstraklasa", "primeira", "pro league", "a-league",
   "veikkausliiga", "liga mx"],
  ["serie b", "segunda", "2. bundesliga", "ligue 2", "championship",
   "liga 2", "second division", "division 2", "superettan",
   "eerste divisie"],
  ["serie c", "3. liga", "league one", "liga 3", "third division",
   "division 3"],
  ["serie d", "league two", "division 4"],
];

function isWomens(name) {
  const lower = name.toLowerCase();
  return WOMENS_WORDS.some(function (word) { return lower.includes(word); });
}

function isUnwanted(name) {
  const lower = name.toLowerCase();
  return NOT_WANTED.some(function (word) { return lower.includes(word); });
}

// Where a league sits in its country. Lower number means higher up.
// Returns -1 when it should not be shown at all.
function rankOf(league) {
  const name = (league.name || "").toLowerCase();
  const country = league.country || "";

  if (isUnwanted(name)) return -1;

  const women = isWomens(name);
  const tiers = women ? WOMEN_ORDER[country] : LEAGUE_ORDER[country];

  if (tiers) {
    // Check every tier and keep the longest match, so a name like
    // "2. Bundesliga" is not mistaken for plain "Bundesliga".
    let best = -1;
    let bestLength = 0;

    for (let tier = 0; tier < tiers.length; tier++) {
      for (const word of tiers[tier]) {
        if (name.includes(word) && word.length > bestLength) {
          best = tier;
          bestLength = word.length;
        }
      }
    }

    if (best === -1) return -1;
    // Women's leagues sort after all the men's ones.
    return women ? 100 + best : best;
  }

  // Countries without a hand-written list.
  for (let tier = 0; tier < GENERIC_TIERS.length; tier++) {
    if (GENERIC_TIERS[tier].some(function (word) { return name.includes(word); })) {
      if (women) return tier > 1 ? -1 : 100 + tier;
      return tier;
    }
  }

  return -1;
}

// Filters and sorts one country's competitions.
function tidyLeagues(leagues) {
  return leagues
    .map(function (league) {
      return { league: league, rank: rankOf(league) };
    })
    .filter(function (entry) { return entry.rank >= 0; })
    .sort(function (a, b) {
      if (a.rank !== b.rank) return a.rank - b.rank;
      return a.league.name.localeCompare(b.league.name);
    })
    .map(function (entry) { return entry.league; });
}

function matchesPinned(pinnedName, apiCountry) {
  if (apiCountry === pinnedName) return true;
  const others = ALSO_KNOWN_AS[pinnedName] || [];
  return others.includes(apiCountry);
}

function openDrawer() {
  document.getElementById("drawer").classList.add("open");
  document.getElementById("shade").classList.add("open");
  buildDrawer();
}

function closeDrawer() {
  document.getElementById("drawer").classList.remove("open");
  document.getElementById("shade").classList.remove("open");
}

document.getElementById("burger").onclick = async function () {
  openDrawer();
  // Fetch the league list the first time it is opened.
  if (allLeagues === null) {
    try {
      const response = await fetch("/api/leagues");
      allLeagues = await response.json();
    } catch (error) {
      allLeagues = [];
    }
    buildDrawer();
  }
};

document.getElementById("drawerClose").onclick = closeDrawer;
document.getElementById("shade").onclick = closeDrawer;

// Groups every league under its country, pinned ones first.
function countriesInOrder() {
  const byCountry = {};

  for (const league of allLeagues || []) {
    const country = league.country || "Other";
    if (!byCountry[country]) byCountry[country] = [];
    byCountry[country].push(league);
  }

  // Drop the youth and amateur competitions, and put what is left
  // in order. Countries with nothing worth showing disappear.
  for (const country of Object.keys(byCountry)) {
    byCountry[country] = tidyLeagues(byCountry[country]);
    if (byCountry[country].length === 0) delete byCountry[country];
  }

  const names = Object.keys(byCountry);
  const top = [];
  const rest = [];

  // Take the pinned ones out first, in the order given above.
  for (const pinned of PINNED) {
    const found = names.find(function (name) {
      return matchesPinned(pinned, name);
    });
    if (found) top.push(found);
  }

  for (const name of names) {
    if (!top.includes(name)) rest.push(name);
  }

  rest.sort(function (a, b) { return a.localeCompare(b); });

  return { order: top.concat(rest), byCountry: byCountry, pinnedCount: top.length };
}

function buildDrawer() {
  const body = document.getElementById("drawerBody");
  body.innerHTML = "";

  if (allLeagues === null) {
    body.innerHTML = '<div class="empty">Loading...</div>';
    return;
  }

  if (allLeagues.length === 0) {
    body.innerHTML = '<div class="empty">No leagues available<br>on your plan.</div>';
    return;
  }

  const grouped = countriesInOrder();
  let index = 0;

  for (const country of grouped.order) {
    // Headings that separate the pinned countries from the rest.
    if (index === 0) {
      const hint = document.createElement("div");
      hint.className = "drawerHint";
      hint.textContent = "Top countries";
      body.appendChild(hint);
    }
    if (index === grouped.pinnedCount && grouped.pinnedCount > 0) {
      const hint = document.createElement("div");
      hint.className = "drawerHint";
      hint.textContent = "All countries";
      body.appendChild(hint);
    }
    index++;

    const leagues = grouped.byCountry[country];
    const isOpen = openCountry === country;

    const row = document.createElement("div");
    row.className = "countryItem";
    row.innerHTML =
      (leagues[0].logo ? '<img src="' + leagues[0].logo + '" alt="">' : '<img alt="">') +
      '<span class="cname">' + country + '</span>' +
      '<span class="arrow">' + (isOpen ? "&#9660;" : "&#9654;") + '</span>';

    row.onclick = function () {
      // Tapping the open one closes it.
      openCountry = isOpen ? null : country;
      buildDrawer();
    };
    body.appendChild(row);

    if (isOpen) {
      // Already in rank order, so leave it alone.
      for (const league of leagues) {
        const child = document.createElement("div");
        child.className = "leagueChild";
        child.textContent = league.name;
        child.onclick = function () {
          closeDrawer();
          openLeague(league);
        };
        body.appendChild(child);
      }
    }
  }
}


// ---------------------------------------------------------------
// THE LEAGUE SCREEN
// Table, fixtures, statistics and teams for one competition.
// ---------------------------------------------------------------
let openLeagueInfo = null;
let leagueTab = "table";

function openLeague(league) {
  openLeagueInfo = league;
  leagueTab = "table";
  screen = "league";
  document.getElementById("mainHeader").style.display = "none";
  document.getElementById("matchHead").innerHTML = "";
  refresh();
}

function closeLeague() {
  openLeagueInfo = null;
  document.getElementById("leagueHead").innerHTML = "";
  document.getElementById("mainHeader").style.display = "block";
  goTo("scores");
}

function drawLeagueHead() {
  const head = document.getElementById("leagueHead");
  const league = openLeagueInfo;

  const tabs = [
    ["table", "Table"],
    ["fixtures", "Fixtures"],
    ["stats", "Statistics"],
    ["teams", "Teams"],
  ];

  let tabHtml = "";
  for (const [key, label] of tabs) {
    tabHtml += '<div class="lTab' + (leagueTab === key ? " on" : "") +
               '" data-tab="' + key + '">' + label + '</div>';
  }

  head.innerHTML =
    '<div class="leagueHead">' +
      '<div class="leagueHeadTop">' +
        '<span class="back" id="leagueBack">&#8592;</span>' +
        (league.logo ? '<img src="' + league.logo + '" alt="">' : '') +
        '<div class="txt">' +
          '<div class="ln">' + league.name + '</div>' +
          '<div class="cn">' + league.country + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="leagueTabs">' + tabHtml + '</div>' +
    '</div>';

  document.getElementById("leagueBack").onclick = closeLeague;

  for (const tab of head.querySelectorAll(".lTab")) {
    tab.onclick = function () {
      leagueTab = this.getAttribute("data-tab");
      refresh();
    };
  }
}

function drawScorers(scorers) {
  const list = document.getElementById("list");
  list.innerHTML = "";

  if (scorers.length === 0) {
    list.innerHTML =
      '<div class="empty">No scorer data for this league.<br><br>' +
      'Often missing early in a season.</div>';
    return;
  }

  const head = document.createElement("div");
  head.className = "drawerHint";
  head.textContent = "Top scorers";
  list.appendChild(head);

  for (const scorer of scorers.slice(0, 30)) {
    const row = document.createElement("div");
    row.className = "scorerRow";
    row.innerHTML =
      '<span class="pl">' + (scorer.place || "-") + '</span>' +
      '<span class="who">' +
        '<div class="pn">' + scorer.name + '</div>' +
        '<div class="tn">' + scorer.team + '</div>' +
      '</span>' +
      '<span class="gl">' + scorer.goals + '</span>';
    list.appendChild(row);
  }
}

function drawTeams(teams) {
  const list = document.getElementById("list");
  list.innerHTML = "";

  if (teams.length === 0) {
    list.innerHTML = '<div class="empty">No teams listed for this league.</div>';
    return;
  }

  teams.sort(function (a, b) { return a.name.localeCompare(b.name); });

  for (const team of teams) {
    const row = document.createElement("div");
    row.className = "teamRowItem";
    row.innerHTML =
      '<img src="' + team.logo + '" alt="">' +
      '<span>' + team.name + '</span>';
    list.appendChild(row);
  }
}


// ---------------------------------------------------------------
// SINGLE MATCH
// ---------------------------------------------------------------
let openFixtureId = null;
let matchTab = "summary";
let previousScreen = "scores";

function openMatch(fixtureId) {
  previousScreen = screen;
  openFixtureId = fixtureId;
  matchTab = "summary";
  screen = "match";
  document.getElementById("mainHeader").style.display = "none";
  refresh();
}

function closeMatch() {
  openFixtureId = null;
  document.getElementById("mainHeader").style.display = "block";
  document.getElementById("matchHead").innerHTML = "";
  goTo(previousScreen);
}

function drawMatch(match) {
  const head = document.getElementById("matchHead");
  const list = document.getElementById("list");

  const homeGoals = match.goals.home === null ? "-" : match.goals.home;
  const awayGoals = match.goals.away === null ? "-" : match.goals.away;

  let clock = match.fixture.status.elapsed !== null
    ? match.fixture.status.elapsed + "'"
    : match.fixture.status.long;

  head.innerHTML =
    '<div class="matchHead">' +
      '<div class="matchTop">' +
        '<span class="back" id="backBtn">&#8592;</span>' +
        '<span class="comp">' + match.league.name + '</span>' +
        '<span style="width:20px"></span>' +
      '</div>' +
      '<div class="scoreLine">' +
        '<div class="side">' +
          '<img src="' + match.teams.home.logo + '" alt="">' +
          '<div>' + match.teams.home.name + '</div>' +
        '</div>' +
        '<div class="bigScore">' +
          '<div class="nums">' + homeGoals + ' - ' + awayGoals + '</div>' +
          '<div class="clock">' + clock + '</div>' +
        '</div>' +
        '<div class="side">' +
          '<img src="' + match.teams.away.logo + '" alt="">' +
          '<div>' + match.teams.away.name + '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="tabs">' +
      '<div class="tab' + (matchTab === "summary" ? " on" : "") + '" id="tabSummary">Summary</div>' +
      '<div class="tab' + (matchTab === "stats" ? " on" : "") + '" id="tabStats">Stats</div>' +
    '</div>';

  document.getElementById("backBtn").onclick = closeMatch;
  document.getElementById("tabSummary").onclick = function () { matchTab = "summary"; drawMatch(match); };
  document.getElementById("tabStats").onclick = function () { matchTab = "stats"; drawMatch(match); };

  list.innerHTML = "";

  if (matchTab === "summary") {
    const goals = match.events || [];
    if (goals.length === 0) {
      list.innerHTML = '<div class="empty">No goals yet.</div>';
      return;
    }
    for (const event of goals) {
      const row = document.createElement("div");
      row.className = "event";
      row.innerHTML =
        '<span class="evMin">' + event.time.elapsed + "'" + '</span>' +
        '<span class="evIcon">&#9917;</span>' +
        '<span class="evName">' + (event.player.name || "Unknown") + '</span>' +
        '<span class="evTeam">' + event.team.name + '</span>';
      list.appendChild(row);
    }
    return;
  }

  // Stats. This API sends one flat list with a home and away value
  // on each row, rather than a separate list per team.
  const stats = match.statistics || [];

  if (stats.length === 0) {
    list.innerHTML =
      '<div class="empty">No stats for this match.<br><br>' +
      'Often only available for bigger games.</div>';
    return;
  }

  const box = document.createElement("div");
  box.className = "statBox";

  for (const item of stats) {
    const homeValue = item.home === undefined ? "0" : item.home;
    const awayValue = item.away === undefined ? "0" : item.away;

    const homeNum = Number(String(homeValue).replace("%", "")) || 0;
    const awayNum = Number(String(awayValue).replace("%", "")) || 0;
    const total = homeNum + awayNum;
    const homeWidth = total === 0 ? 50 : (homeNum / total) * 100;

    const stat = document.createElement("div");
    stat.className = "stat";
    stat.innerHTML =
      '<div class="statTop">' +
        '<span class="statVal">' + homeValue + '</span>' +
        '<span class="statName">' + (item.type || "") + '</span>' +
        '<span class="statVal">' + awayValue + '</span>' +
      '</div>' +
      '<div class="statBar">' +
        '<div class="statHome" style="width:' + homeWidth + '%"></div>' +
        '<div class="statAway" style="width:' + (100 - homeWidth) + '%"></div>' +
      '</div>';
    box.appendChild(stat);
  }

  list.appendChild(box);
}


// ---------------------------------------------------------------
// LOADING
// ---------------------------------------------------------------
async function refresh() {
  const list = document.getElementById("list");
  const updated = document.getElementById("updated");

  if (screen === "league") {
    drawLeagueHead();
    const id = openLeagueInfo.id;
    updated.textContent = "Loading...";

    try {
      if (leagueTab === "table") {
        const rows = await (await fetch("/api/table?league=" + id)).json();
        drawTable(rows);
        updated.textContent = rows.length > 0 ? rows.length + " teams" : "";

      } else if (leagueTab === "fixtures") {
        // Today plus the next fortnight.
        const from = isoDate(new Date());
        const later = new Date();
        later.setDate(later.getDate() + 14);
        const to = isoDate(later);

        const matches = await (await fetch(
          "/api/league-fixtures?league=" + id + "&from=" + from + "&to=" + to)).json();

        matches.sort(function (a, b) {
          return new Date(a.fixture.date) - new Date(b.fixture.date);
        });
        drawMatches(matches, true);
        updated.textContent = matches.length + " games in the next fortnight";

      } else if (leagueTab === "stats") {
        const scorers = await (await fetch("/api/scorers?league=" + id)).json();
        drawScorers(scorers);
        updated.textContent = "";

      } else {
        const teams = await (await fetch("/api/teams?league=" + id)).json();
        drawTeams(teams);
        updated.textContent = teams.length > 0 ? teams.length + " clubs" : "";
      }
    } catch (error) {
      updated.textContent = "Could not reach the server";
    }
    return;
  }

  if (screen === "match") {
    updated.textContent = "Loading...";
    let match = null;
    try {
      const response = await fetch("/api/match?id=" + openFixtureId);
      match = await response.json();
    } catch (error) {
      updated.textContent = "Could not reach the server";
      return;
    }
    if (!match) {
      updated.textContent = "";
      list.innerHTML = '<div class="empty">Could not load that match.</div>';
      return;
    }
    updated.textContent = "";
    drawMatch(match);
    return;
  }

  if (screen === "leagues") {
    updated.textContent = "";
    if (allLeagues === null) {
      list.innerHTML = '<div class="empty">Loading leagues...</div>';
      try {
        const response = await fetch("/api/leagues");
        allLeagues = await response.json();
      } catch (error) {
        list.innerHTML = '<div class="empty">Could not load the league list.</div>';
        return;
      }
    }
    drawLeagues();
    return;
  }

  if (screen === "teams") {
    updated.textContent = "";
    list.innerHTML = '<div class="empty">Not built yet.<br>Coming next.</div>';
    return;
  }

  updated.textContent = "Loading...";

  if (screen === "tables") {
    let rows = [];
    try {
      const response = await fetch("/api/table?league=" + chosenLeague);
      rows = await response.json();
    } catch (error) {
      updated.textContent = "Could not reach the server";
      return;
    }
    drawTable(rows);
    updated.textContent = rows.length > 0 ? rows.length + " teams" : "";
    drawProgress();
    return;
  }

  let matches = [];
  try {
    const address = screen === "scores"
      ? "/api/scores?" + leagueParam()
      : "/api/fixtures?date=" + chosenDate + "&" + leagueParam();
    const response = await fetch(address);
    matches = await response.json();
  } catch (error) {
    updated.textContent = "Could not reach the server";
    return;
  }

  if (screen === "scores") {
    liveCounts = {};
    for (const match of matches) {
      liveCounts[match.league.id] = (liveCounts[match.league.id] || 0) + 1;
    }

    if (matches.length === 0) {
      list.innerHTML =
        '<div class="empty">No matches in your leagues right now.<br><br>' +
        'European games are usually on in your evening.</div>';
      updated.textContent = "0 live - updated " + new Date().toLocaleTimeString();
      drawProgress();
      return;
    }
    xp = xp + 1;
    saveProgress();
    drawMatches(matches, false);
    updated.textContent = matches.length + " live - updated " + new Date().toLocaleTimeString();
  } else {
    if (matches.length === 0) {
      list.innerHTML = '<div class="empty">No games in your leagues that day.</div>';
    } else {
      matches.sort(function (a, b) {
        return new Date(a.fixture.date) - new Date(b.fixture.date);
      });
      drawMatches(matches, true);
    }
    updated.textContent = matches.length + " games";
  }

  drawProgress();
}

drawDates();
drawPicker();
drawProgress();
refresh();

setInterval(function () {
  if (screen === "scores") refresh();
}, 30000);
</script>
</body>
</html>
`;


// ---------------------------------------------------------------
// THE SERVER
// ---------------------------------------------------------------
const server = http.createServer(async function (request, response) {
  const address = new URL(request.url, "http://localhost");

  if (address.pathname === "/api/scores") {
    const all = await getLiveScores();
    const matches = onlyTheirLeagues(all, leagueIdsFrom(address));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(matches));
    return;
  }

  if (address.pathname === "/api/fixtures") {
    const date = address.searchParams.get("date");
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end("[]");
      return;
    }
    const all = await getFixturesFor(date);
    const matches = onlyTheirLeagues(all, leagueIdsFrom(address));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(matches));
    return;
  }

  if (address.pathname === "/api/table") {
    const leagueId = Number(address.searchParams.get("league"));
    if (!leagueId) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end("[]");
      return;
    }
    const rows = await getTableFor(leagueId);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(rows));
    return;
  }

  if (address.pathname === "/api/match") {
    const fixtureId = Number(address.searchParams.get("id"));
    if (!fixtureId) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end("null");
      return;
    }
    const match = await getMatch(fixtureId);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(match));
    return;
  }

  if (address.pathname === "/api/league-fixtures") {
    const leagueId = Number(address.searchParams.get("league"));
    const from = address.searchParams.get("from");
    const to = address.searchParams.get("to");
    const dateOk = /^\d{4}-\d{2}-\d{2}$/;

    if (!leagueId || !dateOk.test(from) || !dateOk.test(to)) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end("[]");
      return;
    }

    const matches = await getLeagueFixtures(leagueId, from, to);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(matches));
    return;
  }

  if (address.pathname === "/api/teams") {
    const leagueId = Number(address.searchParams.get("league"));
    if (!leagueId) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end("[]");
      return;
    }
    const teams = await getTeams(leagueId);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(teams));
    return;
  }

  if (address.pathname === "/api/scorers") {
    const leagueId = Number(address.searchParams.get("league"));
    if (!leagueId) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end("[]");
      return;
    }
    const scorers = await getTopScorers(leagueId);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(scorers));
    return;
  }

  if (address.pathname === "/api/leagues") {
    const leagues = await getAllLeagues();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(leagues));
    return;
  }

  // Shows the raw, untranslated answer. Handy when field names
  // do not match what the code expects.
  if (address.pathname === "/api/raw") {
    const raw = await askApi("get_events", "&match_live=1");
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(raw ? raw.slice(0, 2) : null, null, 2));
    return;
  }

  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(PAGE.replace("__LEAGUES__", JSON.stringify(MY_LEAGUES)));
});

server.listen(PORT, function () {
  console.log("");
  console.log("  App running on port " + PORT);
  console.log("  On your own PC:  http://localhost:" + PORT);
  console.log("");
});
