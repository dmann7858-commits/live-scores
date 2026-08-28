// scores.js
// Live football scores app - Scores and Fixtures screens.

const http = require("http");

const API_KEY = process.env.API_FOOTBALL_KEY || "PASTE_YOUR_KEY_HERE";
const PORT = process.env.PORT || 3000;

// Each league has an id, a short name for the menus, and whether
// it has a league table. Cups do not, so they are left out of the
// Tables screen.
const MY_LEAGUES = [
  { id: 39,  name: "Premier League",  table: true },
  { id: 40,  name: "Championship",    table: true },
  { id: 41,  name: "League One",      table: true },
  { id: 42,  name: "League Two",      table: true },
  { id: 43,  name: "National League", table: true },
  { id: 2,   name: "Champions League", table: false },
  { id: 3,   name: "Europa League",   table: false },
  { id: 140, name: "La Liga",         table: true },
  { id: 135, name: "Serie A",         table: true },
  { id: 78,  name: "Bundesliga",      table: true },
  { id: 61,  name: "Ligue 1",         table: true },
];

const MY_LEAGUE_IDS = MY_LEAGUES.map(function (league) { return league.id; });

// ===============================================================
// SEASON TEST SWITCH
//
// The free API plan only allows old seasons. Set this to 2021 to
// check whether the code works, then set it back to null once you
// are on a paid plan.
//
//   2021  =  test mode, shows the 2021-22 season
//   null  =  normal, works out the real current season
// ===============================================================
const TEST_SEASON = 2021;


// Which season to ask for. European seasons are named after the
// year they start in, so August 2026 is season 2026 but March 2027
// is still season 2026.
function currentSeason() {
  if (TEST_SEASON !== null) return TEST_SEASON;
  const now = new Date();
  return now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
}


// ---------------------------------------------------------------
// ASKING THE API
// One place that does all the talking, so the caching rules live
// in one spot instead of being scattered about.
// ---------------------------------------------------------------
async function askApi(path) {
  if (!API_KEY || API_KEY === "PASTE_YOUR_KEY_HERE") {
    console.log("!! NO API KEY SET. Check the API_FOOTBALL_KEY setting.");
    return null;
  }

  let response;
  try {
    response = await fetch("https://v3.football.api-sports.io/" + path, {
      headers: { "x-apisports-key": API_KEY },
    });
  } catch (error) {
    console.log("!! could not reach the API: " + error.message);
    return null;
  }

  console.log("   http status: " + response.status);

  const data = await response.json();

  // The API reports trouble inside a normal 200 response. It sends
  // an empty array when all is well, and an object full of
  // complaints when it is not - so check both shapes.
  const errors = data.errors;
  const hasErrors = errors &&
    (Array.isArray(errors) ? errors.length > 0 : Object.keys(errors).length > 0);

  if (hasErrors) {
    console.log("   !! API SAYS: " + JSON.stringify(errors));
  }

  if (!Array.isArray(data.response)) {
    console.log("   !! unexpected answer: " + JSON.stringify(data).slice(0, 300));
    return null;
  }

  console.log("   results: " + data.results);
  return data.response;
}


// ---------------------------------------------------------------
// THE CACHE
// Every answer we get is stored under a name, with the time we
// got it. Different kinds of data go stale at different speeds:
// live scores in a minute, a day's fixture list in ten.
// ---------------------------------------------------------------
const cache = {};

// Caches the FULL answer. Filtering happens afterwards, so two
// people following different leagues still share one API call.
async function getCached(name, maxAgeSeconds, path) {
  const saved = cache[name];

  if (saved) {
    const age = (Date.now() - saved.time) / 1000;
    if (age < maxAgeSeconds) {
      console.log("cache hit: " + name + " (" + Math.round(age) + "s old)");
      return saved.data;
    }
  }

  console.log("fetching: " + path);
  const fresh = await askApi(path);

  if (fresh === null) {
    // API failed. Better to serve something old than nothing.
    return saved ? saved.data : [];
  }

  cache[name] = { data: fresh, time: Date.now() };
  console.log(fresh.length + " matches back");
  return fresh;
}

// Keeps only the matches in the leagues this person follows.
function onlyTheirLeagues(matches, leagueIds) {
  return matches.filter(function (match) {
    return leagueIds.includes(match.league.id);
  });
}

function getLiveScores() {
  return getCached("live", 60, "fixtures?live=all");
}

function getFixturesFor(date) {
  // Fixture lists barely change, so ten minutes is plenty.
  return getCached("fixtures-" + date, 600, "fixtures?date=" + date);
}

// The full list of competitions the API covers. Changes about
// twice a year, so once a day is generous.
async function getAllLeagues() {
  const saved = cache["allLeagues"];

  if (saved) {
    const age = (Date.now() - saved.time) / 1000;
    if (age < 86400) return saved.data;
  }

  console.log("fetching the league list");
  const result = await askApi("leagues");

  if (result === null) {
    return saved ? saved.data : [];
  }

  // The raw answer carries every season ever played, which is huge.
  // Keep only what the screen actually needs.
  const trimmed = result.map(function (item) {
    return {
      id: item.league.id,
      name: item.league.name,
      type: item.league.type,
      logo: item.league.logo,
      country: item.country.name,
    };
  });

  cache["allLeagues"] = { data: trimmed, time: Date.now() };
  console.log(trimmed.length + " leagues available");
  return trimmed;
}

// Reads a "39,40,140" style list off a web address safely.
function leagueIdsFrom(address) {
  const raw = address.searchParams.get("leagues");
  if (!raw) return MY_LEAGUE_IDS;

  const ids = raw.split(",")
    .map(Number)
    .filter(function (n) { return Number.isInteger(n) && n > 0; })
    .slice(0, 200);

  return ids.length > 0 ? ids : MY_LEAGUE_IDS;
}

// Standings come back in a different shape, so they need their own
// function rather than going through getCached.
async function getTableFor(leagueId) {
  const name = "table-" + leagueId;
  const saved = cache[name];

  if (saved) {
    const age = (Date.now() - saved.time) / 1000;
    // A table only changes when games finish, so half an hour is fine.
    if (age < 1800) {
      console.log("cache hit: " + name);
      return saved.data;
    }
  }

  const path = "standings?league=" + leagueId + "&season=" + currentSeason();
  console.log("fetching: " + path);
  const result = await askApi(path);

  if (result === null) {
    console.log("   standings call failed for league " + leagueId);
    return saved ? saved.data : [];
  }

  if (result.length === 0) {
    console.log("   standings came back empty for league " + leagueId);
    return saved ? saved.data : [];
  }

  // The answer is buried: response[0].league.standings[0] is the
  // actual list of teams. The extra layer exists because some
  // competitions have several groups.
  const groups = result[0].league.standings;
  const rows = groups && groups[0] ? groups[0] : [];

  cache[name] = { data: rows, time: Date.now() };
  console.log("table has " + rows.length + " teams");
  return rows;
}


// One request brings back the goals, the stats and the team sheets
// all together, so a match page costs a single call.
async function getMatch(fixtureId) {
  const name = "match-" + fixtureId;
  const saved = cache[name];

  if (saved) {
    const age = (Date.now() - saved.time) / 1000;
    // Short, because a live game changes constantly.
    if (age < 60) {
      console.log("cache hit: " + name);
      return saved.data;
    }
  }

  console.log("fetching match " + fixtureId);
  const result = await askApi("fixtures?id=" + fixtureId);

  if (result === null || result.length === 0) {
    return saved ? saved.data : null;
  }

  cache[name] = { data: result[0], time: Date.now() };
  return result[0];
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

  /* Date strip, only shown on the Fixtures screen */
  .dates { display: flex; }
  .dateBtn {
    flex: 1; text-align: center; padding: 6px 0 8px;
    color: #85B7EB; cursor: pointer; border-bottom: 2px solid transparent;
  }
  .dateBtn.on { color: #EF9F27; border-bottom-color: #EF9F27; }
  .dateDay { font-size: 11px; }
  .dateNum { font-size: 15px; margin-top: 2px; }

  .updated { padding: 8px 16px; font-size: 12px; color: #777; }
  .leagueRow {
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

  .empty { padding: 50px 24px; text-align: center; color: #777; line-height: 1.6; }

  /* League picker on the Tables screen */
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

  .tableHead {
    display: flex; padding: 8px 16px; background: #E8E8E4;
    font-size: 11px; color: #555;
  }
  .tableRow {
    display: flex; align-items: center; padding: 10px 16px;
    background: #fff; border-bottom: 1px solid #E8E8E4;
    border-left: 3px solid transparent;
  }
  .tableRow.up { border-left-color: #639922; }
  .tableRow.mid { border-left-color: #EF9F27; }
  .tableRow.down { border-left-color: #E24B4A; }
  .colPos { width: 22px; font-size: 13px; color: #777; }
  .colTeam { flex: 1; display: flex; align-items: center; gap: 8px; min-width: 0; }
  .colTeam span { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .colTeam img { width: 20px; height: 20px; object-fit: contain; flex-shrink: 0; }
  .colNum { width: 30px; text-align: center; font-size: 13px; color: #777; }
  .colPts { width: 32px; text-align: right; font-size: 14px; font-weight: 600; }

  .key {
    display: flex; gap: 16px; padding: 12px 16px;
    background: #E8E8E4; font-size: 11px; color: #555;
  }
  .keyItem { display: flex; align-items: center; gap: 6px; }
  .keyDash { width: 10px; height: 3px; }

  /* Single match screen */
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

  /* Leagues screen */
  .searchBox {
    display: flex; align-items: center; gap: 8px;
    background: #fff; border-radius: 6px; padding: 9px 12px;
    margin-bottom: 12px;
  }
  .searchBox input {
    border: none; outline: none; font-size: 14px;
    width: 100%; background: transparent;
  }
  .countryRow {
    padding: 8px 16px; background: #E8E8E4;
    font-size: 12px; color: #555;
  }
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
// The league list, handed over from the server so the menus
// do not need it typed out twice.
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

// Which leagues this person follows. Starts with the built-in set,
// then it is theirs to change on the Leagues screen.
let myLeagues = JSON.parse(localStorage.getItem("myLeagues") || "null");
if (myLeagues === null) {
  myLeagues = LEAGUES.map(function (league) { return league.id; });
  localStorage.setItem("myLeagues", JSON.stringify(myLeagues));
}

// Names of followed leagues, so the Tables menu has labels even
// for ones added later.
let leagueNames = JSON.parse(localStorage.getItem("leagueNames") || "null");
if (leagueNames === null) {
  leagueNames = {};
  for (const league of LEAGUES) leagueNames[league.id] = league.name;
  localStorage.setItem("leagueNames", JSON.stringify(leagueNames));
}

function saveLeagues() {
  localStorage.setItem("myLeagues", JSON.stringify(myLeagues));
  localStorage.setItem("leagueNames", JSON.stringify(leagueNames));
}

function leagueParam() {
  return "leagues=" + myLeagues.join(",");
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
// WHICH SCREEN ARE WE ON
// ---------------------------------------------------------------
let screen = "scores";
let chosenDate = isoDate(new Date());

// Turns a date into the 2026-08-29 shape the API wants.
function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

function goTo(name) {
  screen = name;

  document.getElementById("navScores").classList.toggle("on", name === "scores");
  document.getElementById("navFixtures").classList.toggle("on", name === "fixtures");
  document.getElementById("navLeagues").classList.toggle("on", name === "leagues");
  document.getElementById("navTables").classList.toggle("on", name === "tables");
  document.getElementById("navTeams").classList.toggle("on", name === "teams");

  document.getElementById("dates").style.display =
    name === "fixtures" ? "flex" : "none";
  document.getElementById("pickerBox").style.display =
    name === "tables" ? "block" : "none";
  document.getElementById("searchArea").style.display =
    name === "leagues" ? "block" : "none";

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
// THE DATE STRIP
// Yesterday, today, and the next three days.
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
// DRAWING A LIST OF MATCHES
// Used by both screens. The only difference is what goes in the
// left hand column - a minute, or a kick-off time.
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
        '<img class="leagueLogo" src="' + match.league.logo + '" alt="">' +
        match.league.country + ' - ' + match.league.name;
      list.appendChild(heading);
      lastLeague = match.league.name;
    }

    let when;
    let whenClass = "when";

    if (showKickoffTimes) {
      // The API sends the kick-off in world time. The browser
      // converts it to whatever the phone is set to.
      const kickoff = new Date(match.fixture.date);
      when = kickoff.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      whenClass = "when grey";
    } else {
      when = match.fixture.status.elapsed + "'";
      if (match.fixture.status.elapsed === null || match.fixture.status.short === "HT") {
        when = match.fixture.status.short;
        whenClass = "when grey";
      }
    }

    // Finished and unstarted games have no goals yet.
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
      // Stop the tap also opening the match page underneath.
      event.stopPropagation();
      toggleAlert(match.fixture.id, bell);
    };

    row.style.cursor = "pointer";
    row.onclick = function () { openMatch(match.fixture.id); };

    list.appendChild(row);
  }
}


// ---------------------------------------------------------------
// THE TABLES SCREEN
// ---------------------------------------------------------------
let chosenLeague = 39; // Premier League to start with

function drawPicker() {
  const box = document.getElementById("pickerBox");

  // Cups have no table, so leave out the ones we know about.
  const noTable = {};
  for (const league of LEAGUES) {
    if (!league.table) noTable[league.id] = true;
  }
  const withTables = myLeagues.filter(function (id) { return !noTable[id]; });

  if (withTables.length === 0) {
    box.innerHTML = '<div class="picker">No leagues followed</div>';
    return;
  }

  if (!withTables.includes(chosenLeague)) chosenLeague = withTables[0];

  let options = "";
  for (const id of withTables) {
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

// The API describes what each position means in plain words, so we
// read that rather than hard-coding the rules for every league.
function bandFor(description) {
  if (!description) return "";
  const text = description.toLowerCase();
  if (text.includes("relegation")) return "down";
  if (text.includes("play-off") || text.includes("playoff")) return "mid";
  if (text.includes("promotion") || text.includes("champions league")) return "up";
  if (text.includes("europa") || text.includes("conference")) return "mid";
  return "";
}

function drawTable(rows) {
  const list = document.getElementById("list");
  list.innerHTML = "";

  if (rows.length === 0) {
    list.innerHTML =
      '<div class="empty">No table available for this league yet.<br><br>' +
      'Lower leagues and new seasons are often missing.</div>';
    return;
  }

  const head = document.createElement("div");
  head.className = "tableHead";
  head.innerHTML =
    '<span class="colPos">#</span>' +
    '<span class="colTeam">Team</span>' +
    '<span class="colNum">P</span>' +
    '<span class="colNum">GD</span>' +
    '<span class="colPts">Pts</span>';
  list.appendChild(head);

  let usedBands = false;

  for (const entry of rows) {
    const band = bandFor(entry.description);
    if (band) usedBands = true;

    const row = document.createElement("div");
    row.className = "tableRow " + band;
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

  if (usedBands) {
    const key = document.createElement("div");
    key.className = "key";
    key.innerHTML =
      '<div class="keyItem"><div class="keyDash" style="background:#639922"></div>Promotion</div>' +
      '<div class="keyItem"><div class="keyDash" style="background:#EF9F27"></div>Play-offs</div>' +
      '<div class="keyItem"><div class="keyDash" style="background:#E24B4A"></div>Relegation</div>';
    list.appendChild(key);
  }
}


// ---------------------------------------------------------------
// THE SINGLE MATCH SCREEN
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

// Picks a symbol for each thing that happened.
function eventIcon(event) {
  if (event.type === "Goal") return "&#9917;";
  if (event.type === "Card") {
    return event.detail === "Red Card" ? "&#128308;" : "&#129000;";
  }
  if (event.type === "subst") return "&#8646;";
  return "&#8226;";
}

function drawMatch(match) {
  const head = document.getElementById("matchHead");
  const list = document.getElementById("list");

  const homeGoals = match.goals.home === null ? "-" : match.goals.home;
  const awayGoals = match.goals.away === null ? "-" : match.goals.away;

  let clock = match.fixture.status.elapsed + "'";
  if (match.fixture.status.elapsed === null) {
    clock = match.fixture.status.long;
  }

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
  document.getElementById("tabSummary").onclick = function () {
    matchTab = "summary"; drawMatch(match);
  };
  document.getElementById("tabStats").onclick = function () {
    matchTab = "stats"; drawMatch(match);
  };

  list.innerHTML = "";

  if (matchTab === "summary") {
    const events = match.events || [];
    // Cards and substitutions are noise on a first look.
    const goals = events.filter(function (e) { return e.type === "Goal"; });

    if (goals.length === 0) {
      list.innerHTML = '<div class="empty">No goals yet.</div>';
      return;
    }

    for (const event of goals) {
      const row = document.createElement("div");
      row.className = "event";
      row.innerHTML =
        '<span class="evMin">' + event.time.elapsed + "'" + '</span>' +
        '<span class="evIcon">' + eventIcon(event) + '</span>' +
        '<span class="evName">' + (event.player.name || "Unknown") + '</span>' +
        '<span class="evTeam">' + event.team.name + '</span>';
      list.appendChild(row);
    }
    return;
  }

  // Stats tab
  const stats = match.statistics || [];

  if (stats.length < 2) {
    list.innerHTML =
      '<div class="empty">No stats for this match.<br><br>' +
      'Lower leagues usually only have goals.</div>';
    return;
  }

  const homeStats = stats[0].statistics;
  const awayStats = stats[1].statistics;

  const box = document.createElement("div");
  box.className = "statBox";

  // Only the ones worth showing, in a sensible order.
  const wanted = [
    "Ball Possession", "Total Shots", "Shots on Goal",
    "Corner Kicks", "Fouls", "Yellow Cards"
  ];

  for (const name of wanted) {
    const home = homeStats.find(function (s) { return s.type === name; });
    const away = awayStats.find(function (s) { return s.type === name; });
    if (!home || !away) continue;

    const homeValue = home.value === null ? 0 : home.value;
    const awayValue = away.value === null ? 0 : away.value;

    // Possession arrives as "46%", so strip the sign to do the maths.
    const homeNum = Number(String(homeValue).replace("%", "")) || 0;
    const awayNum = Number(String(awayValue).replace("%", "")) || 0;
    const total = homeNum + awayNum;

    const homeWidth = total === 0 ? 50 : (homeNum / total) * 100;

    const stat = document.createElement("div");
    stat.className = "stat";
    stat.innerHTML =
      '<div class="statTop">' +
        '<span class="statVal">' + homeValue + '</span>' +
        '<span class="statName">' + name + '</span>' +
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
// THE LEAGUES SCREEN
// ---------------------------------------------------------------
let allLeagues = null;   // fetched once, then kept
let liveCounts = {};     // how many matches each league has on
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
    // Nothing typed: show what they follow, so the screen is
    // useful straight away rather than a wall of 1200 names.
    shown = allLeagues.filter(function (league) {
      return myLeagues.includes(league.id);
    });
  } else {
    shown = allLeagues.filter(function (league) {
      return league.name.toLowerCase().includes(searchText) ||
             league.country.toLowerCase().includes(searchText);
    }).slice(0, 60);
  }

  if (shown.length === 0) {
    list.innerHTML = '<div class="empty">Nothing found.<br><br>Try a country name.</div>';
    return;
  }

  // Country first, then league name.
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
// LOADING WHATEVER THE CURRENT SCREEN NEEDS
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

  // Screens we have not built yet.
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
    // Remember how many are live per league, for the Leagues screen.
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
      // Earliest kick-off first.
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

// Only the live screen needs to keep refreshing itself.
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
  if (request.url.startsWith("/api/scores")) {
    const address = new URL(request.url, "http://localhost");
    const all = await getLiveScores();
    const matches = onlyTheirLeagues(all, leagueIdsFrom(address));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(matches));
    return;
  }

  if (request.url.startsWith("/api/leagues")) {
    const leagues = await getAllLeagues();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(leagues));
    return;
  }

  if (request.url.startsWith("/api/fixtures")) {
    // Pull the date out of the web address.
    const address = new URL(request.url, "http://localhost");
    const date = address.searchParams.get("date");

    // Only allow the 2026-08-29 shape, so nobody can send us junk.
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify([]));
      return;
    }

    const all = await getFixturesFor(date);
    const matches = onlyTheirLeagues(all, leagueIdsFrom(address));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(matches));
    return;
  }

  if (request.url.startsWith("/api/match")) {
    const address = new URL(request.url, "http://localhost");
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

  if (request.url.startsWith("/api/table")) {
    const address = new URL(request.url, "http://localhost");
    const leagueId = Number(address.searchParams.get("league"));

    if (!leagueId) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify([]));
      return;
    }

    const rows = await getTableFor(leagueId);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(rows));
    return;
  }

  // Drop the league list into the page before sending it.
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(PAGE.replace("__LEAGUES__", JSON.stringify(MY_LEAGUES)));
});

server.listen(PORT, function () {
  console.log("");
  console.log("  App running on port " + PORT);
  console.log("  On your own PC:  http://localhost:" + PORT);
  console.log("");
});
