// scores.js
// Live football scores app - Scores and Fixtures screens.

const http = require("http");

const API_KEY = process.env.API_FOOTBALL_KEY || "PASTE_YOUR_KEY_HERE";
const PORT = process.env.PORT || 3000;

const MY_LEAGUES = [
  39,   // Premier League
  40,   // Championship
  41,   // League One
  42,   // League Two
  43,   // National League
  2,    // Champions League
  3,    // Europa League
  140,  // La Liga
  135,  // Serie A
  78,   // Bundesliga
  61,   // Ligue 1
];


// ---------------------------------------------------------------
// ASKING THE API
// One place that does all the talking, so the caching rules live
// in one spot instead of being scattered about.
// ---------------------------------------------------------------
async function askApi(path) {
  const response = await fetch("https://v3.football.api-sports.io/" + path, {
    headers: { "x-apisports-key": API_KEY },
  });
  const data = await response.json();
  if (!data.response) {
    console.log("API problem:", JSON.stringify(data.errors || data));
    return null;
  }
  return data.response;
}


// ---------------------------------------------------------------
// THE CACHE
// Every answer we get is stored under a name, with the time we
// got it. Different kinds of data go stale at different speeds:
// live scores in a minute, a day's fixture list in ten.
// ---------------------------------------------------------------
const cache = {};

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

  const mine = fresh.filter(function (match) {
    return MY_LEAGUES.includes(match.league.id);
  });

  cache[name] = { data: mine, time: Date.now() };
  console.log(fresh.length + " total, " + mine.length + " in your leagues");
  return mine;
}

function getLiveScores() {
  return getCached("live", 60, "fixtures?live=all");
}

function getFixturesFor(date) {
  // Fixture lists barely change, so ten minutes is plenty.
  return getCached("fixtures-" + date, 600, "fixtures?date=" + date);
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

<div class="header">
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
</div>

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
    bell.onclick = function () { toggleAlert(match.fixture.id, bell); };

    list.appendChild(row);
  }
}


// ---------------------------------------------------------------
// LOADING WHATEVER THE CURRENT SCREEN NEEDS
// ---------------------------------------------------------------
async function refresh() {
  const list = document.getElementById("list");
  const updated = document.getElementById("updated");

  // Screens we have not built yet.
  if (screen === "leagues" || screen === "tables" || screen === "teams") {
    updated.textContent = "";
    list.innerHTML = '<div class="empty">Not built yet.<br>Coming next.</div>';
    return;
  }

  updated.textContent = "Loading...";

  let matches = [];
  try {
    const address = screen === "scores" ? "/api/scores" : "/api/fixtures?date=" + chosenDate;
    const response = await fetch(address);
    matches = await response.json();
  } catch (error) {
    updated.textContent = "Could not reach the server";
    return;
  }

  if (screen === "scores") {
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
  if (request.url === "/api/scores") {
    const matches = await getLiveScores();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(matches));
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

    const matches = await getFixturesFor(date);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(matches));
    return;
  }

  response.writeHead(200, { "Content-Type": "text/html" });
  response.end(PAGE);
});

server.listen(PORT, function () {
  console.log("");
  console.log("  App running on port " + PORT);
  console.log("  On your own PC:  http://localhost:" + PORT);
  console.log("");
});
