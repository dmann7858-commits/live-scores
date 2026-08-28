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

<div class="header" id="mainHeader">
  <div class="headerTop">
    <div class="title" id="screenTitle">Live scores</div>
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
