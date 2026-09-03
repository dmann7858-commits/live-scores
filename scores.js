// scores.js
// Live football scores app, using apifootball.com
//
// Sign up:  https://apifootball.com/register/
// Your key: on the dashboard after you log in

const http = require("http");
const fs = require("fs");
const pathlib = require("path");

const API_KEY = process.env.APIFOOTBALL_KEY || "PASTE_YOUR_KEY_HERE";

// Where accounts and saved progress live. Both come from settings
// on the server, never from the code.
const DB_URL = process.env.SUPABASE_URL || "";
const DB_KEY = process.env.SUPABASE_SERVICE_KEY || "";
const DB_ON = Boolean(DB_URL && DB_KEY);
const PORT = process.env.PORT || 3000;
const BASE = "https://apiv3.apifootball.com/";

// apifootball hands kickoff times back in Europe/Berlin unless it is
// told otherwise. We ask for UTC so there is one fixed reference
// point, and the phone turns that into whatever time the person is
// actually in. Never render these times without converting first.
const API_TZ = "UTC";

// Leagues to start with. The free plan only carries two, so these
// are them. Once you upgrade, add more from the Leagues screen.
const MY_LEAGUES = [
  { id: 63,  name: "Championship", table: true },
  { id: 169, name: "Ligue 2",      table: true },
];

const MY_LEAGUE_IDS = MY_LEAGUES.map(function (l) { return l.id; });


// ---------------------------------------------------------------
// ACCOUNTS AND SAVED PROGRESS
//
// The browser never talks to the database directly. It sends an
// email and password here, gets a token back, and hands that token
// over on every save.
// ---------------------------------------------------------------
async function dbCall(path, options) {
  const settings = options || {};
  const headers = Object.assign({
    "apikey": DB_KEY,
    "Content-Type": "application/json",
  }, settings.headers || {});

  if (!headers.Authorization) {
    headers.Authorization = "Bearer " + DB_KEY;
  }

  const response = await fetch(DB_URL + path, {
    method: settings.method || "GET",
    headers: headers,
    body: settings.body ? JSON.stringify(settings.body) : undefined,
  });

  let data = null;
  try { data = await response.json(); } catch (error) { data = null; }

  return { ok: response.ok, status: response.status, data: data };
}

// Creates an account and returns a token straight away.
async function signUp(email, password) {
  const result = await dbCall("/auth/v1/signup", {
    method: "POST",
    body: { email: email, password: password },
  });

  if (!result.ok) {
    const message = (result.data && (result.data.msg || result.data.message ||
      result.data.error_description)) || "Could not create that account";
    return { error: message };
  }

  // Some projects need the email confirming before a token appears.
  if (!result.data.access_token) {
    return { needsConfirming: true };
  }

  return {
    token: result.data.access_token,
    userId: result.data.user && result.data.user.id,
    email: email,
  };
}

async function signIn(email, password) {
  const result = await dbCall("/auth/v1/token?grant_type=password", {
    method: "POST",
    body: { email: email, password: password },
  });

  if (!result.ok || !result.data.access_token) {
    return { error: "Wrong email or password" };
  }

  return {
    token: result.data.access_token,
    userId: result.data.user && result.data.user.id,
    email: email,
  };
}

// Checks a token is real and tells us whose it is.
async function whoIs(token) {
  const result = await dbCall("/auth/v1/user", {
    headers: { Authorization: "Bearer " + token },
  });

  if (!result.ok || !result.data || !result.data.id) return null;
  return { id: result.data.id, email: result.data.email };
}

async function loadProgress(userId) {
  const result = await dbCall(
    "/rest/v1/profiles?id=eq." + userId + "&select=data");

  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) {
    return null;
  }
  return result.data[0].data || null;
}

async function saveProgressFor(userId, email, data) {
  // xp is kept in its own column as well, because the league has
  // to sort by it and you cannot sort inside a lump of JSON.
  const result = await dbCall("/rest/v1/profiles", {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates" },
    body: [{
      id: userId,
      email: email,
      data: data,
      xp: Number(data && data.xp) || 0,
      updated_at: new Date().toISOString(),
    }],
  });

  return result.ok;
}


// ---------------------------------------------------------------
// THE WEEKLY LEAGUE
//
// Everyone sits in a small group inside a division. XP earned
// during the week decides who goes up and who goes down. There is
// no scheduled job - the week is settled the first time somebody
// looks, which keeps it simple and costs nothing.
// ---------------------------------------------------------------
const GROUP_SIZE = 20;
const PROMOTE = 5;      // top five go up
const RELEGATE = 5;     // bottom five go down
const TOP_DIVISION = 10;

// Monday of the week a date falls in, as a plain key.
function weekKeyServer(date) {
  const d = new Date(date);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}

// Reads one profile row.
async function getProfile(userId) {
  const result = await dbCall(
    "/rest/v1/profiles?id=eq." + userId +
    "&select=id,email,name,division,group_key,week_key,week_start_xp,xp,last_result");

  if (!result.ok || !Array.isArray(result.data) || result.data.length === 0) {
    return null;
  }
  return result.data[0];
}

async function updateProfile(userId, fields) {
  const result = await dbCall("/rest/v1/profiles?id=eq." + userId, {
    method: "PATCH",
    body: fields,
  });
  return result.ok;
}

// Finds a group in this division with room in it, or starts a new
// one. Groups are named like "2026-08-31|4|2".
async function findGroup(division, week) {
  for (let number = 1; number <= 200; number++) {
    const key = week + "|" + division + "|" + number;
    const result = await dbCall(
      "/rest/v1/profiles?group_key=eq." + encodeURIComponent(key) + "&select=id");

    const count = result.ok && Array.isArray(result.data) ? result.data.length : 0;
    if (count < GROUP_SIZE) return key;
  }
  return week + "|" + division + "|overflow";
}

// Works out last week's finishing order and moves people up or down.
async function settleWeek(profile) {
  const finishedKey = profile.group_key;
  if (!finishedKey) return { moved: null };

  const result = await dbCall(
    "/rest/v1/profiles?group_key=eq." + encodeURIComponent(finishedKey) +
    "&select=id,xp,week_start_xp");

  if (!result.ok || !Array.isArray(result.data)) return { moved: null };

  const table = result.data.map(function (row) {
    return {
      id: row.id,
      earned: Math.max(0, (Number(row.xp) || 0) - (Number(row.week_start_xp) || 0)),
    };
  }).sort(function (a, b) { return b.earned - a.earned; });

  const place = table.findIndex(function (row) { return row.id === profile.id; });
  if (place === -1) return { moved: null };

  const position = place + 1;
  let division = Number(profile.division) || 1;
  let moved = "stayed";

  // Too few people to run promotion fairly.
  if (table.length >= 8) {
    if (position <= PROMOTE && division < TOP_DIVISION) {
      division = division + 1;
      moved = "promoted";
    } else if (position > table.length - RELEGATE && division > 1) {
      division = division - 1;
      moved = "relegated";
    }
  }

  return {
    moved: moved,
    position: position,
    outOf: table.length,
    earned: table[place].earned,
    division: division,
  };
}

// Makes sure a profile is in the right week, settling the old one
// on the way through. Returns the profile as it now stands.
async function rollWeek(userId) {
  const profile = await getProfile(userId);
  if (!profile) return null;

  const week = weekKeyServer(new Date());

  // Already up to date.
  if (profile.week_key === week && profile.group_key) return profile;

  let division = Number(profile.division) || 1;
  let lastResult = null;

  if (profile.week_key && profile.group_key) {
    const outcome = await settleWeek(profile);
    if (outcome.moved) {
      division = outcome.division;
      lastResult = {
        week: profile.week_key,
        moved: outcome.moved,
        position: outcome.position,
        outOf: outcome.outOf,
        earned: outcome.earned,
      };
    }
  }

  const group = await findGroup(division, week);

  await updateProfile(userId, {
    division: division,
    group_key: group,
    week_key: week,
    week_start_xp: Number(profile.xp) || 0,
    last_result: lastResult,
  });

  return await getProfile(userId);
}

// The table everybody in that group sees.
async function groupTable(groupKey) {
  const result = await dbCall(
    "/rest/v1/profiles?group_key=eq." + encodeURIComponent(groupKey) +
    "&select=id,name,xp,week_start_xp");

  if (!result.ok || !Array.isArray(result.data)) return [];

  return result.data.map(function (row) {
    return {
      id: row.id,
      name: row.name || "Player",
      earned: Math.max(0, (Number(row.xp) || 0) - (Number(row.week_start_xp) || 0)),
    };
  }).sort(function (a, b) { return b.earned - a.earned; });
}


// ---------------------------------------------------------------
// TALKING TO THE API
// Everything goes through here, so if the provider ever changes
// again this is the only part that needs rewriting.
// ---------------------------------------------------------------
// Only the fixture endpoints understand a timezone, so it is added
// where it belongs rather than to every request.
function buildUrl(action, extra) {
  const wantsTz = action.indexOf("events") !== -1 || action.indexOf("comm") !== -1;
  return BASE + "?action=" + action + (extra || "") +
    (wantsTz ? "&timezone=" + encodeURIComponent(API_TZ) : "") +
    "&APIkey=" + API_KEY;
}

async function askApi(action, extra) {
  if (!API_KEY || API_KEY === "PASTE_YOUR_KEY_HERE") {
    console.log("!! NO API KEY SET. Check the APIFOOTBALL_KEY setting.");
    return null;
  }

  const url = buildUrl(action, extra);

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


// Same as askApi, but accepts an object rather than a list.
// The live comments endpoint answers with match ids as keys.
async function askApiObject(action, extra) {
  if (!API_KEY || API_KEY === "PASTE_YOUR_KEY_HERE") return null;

  const url = buildUrl(action, extra);
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
    return null;
  }

  // An error comes back as an object with an error number in it.
  if (data && data.error) {
    console.log("   !! API SAYS: " + JSON.stringify(data));
    return null;
  }

  return data;
}

// Minute-by-minute commentary, if the plan includes it. Returns an
// empty list rather than failing when it does not.
async function getLiveComments(matchId) {
  const name = "comments-" + matchId;
  const hit = fromCache(name, 30);
  if (hit) return hit;

  const data = await askApiObject("get_live_odds_commnets", "&match_id=" + matchId);

  if (!data || typeof data !== "object") {
    console.log("   no live comments available");
    return intoCache(name, []);
  }

  // The answer is keyed by match id, so dig the one match out.
  const entry = data[String(matchId)] || Object.values(data)[0];
  const comments = (entry && entry.live_comments) || [];

  console.log("   " + comments.length + " live comments");

  const homeName = String(entry && entry.match_hometeam_name || "").toLowerCase();
  const awayName = String(entry && entry.match_awayteam_name || "").toLowerCase();

  const sideOf = function (text) {
    const lower = text.toLowerCase();
    if (homeName && lower.startsWith(homeName)) return "home";
    if (awayName && lower.startsWith(awayName)) return "away";
    if (homeName && lower.includes(homeName)) return "home";
    if (awayName && lower.includes(awayName)) return "away";
    return null;
  };

  const feed = comments.map(function (comment) {
    // Times arrive as "44:58", so take the minutes off the front.
    const clock = String(comment.time || "");
    const minute = parseInt(clock.split(":")[0], 10);
    return {
      minute: Number.isNaN(minute) ? 0 : minute,
      clock: clock,
      kind: kindOfComment(comment.text || ""),
      text: String(comment.text || "").trim(),
      side: sideOf(String(comment.text || "")),
      live: true,
    };
  }).filter(function (moment) { return moment.text !== ""; });

  return intoCache(name, feed);
}

// Works out what sort of moment a line of commentary describes,
// so it can get the right icon and colour.
function kindOfComment(text) {
  const lower = text.toLowerCase();

  // Order matters. "dangerous attack" must be caught before
  // "attack", and "goal kick" must not be read as a goal.
  if (lower.includes("goal") && !lower.includes("goal kick")) return "goal";
  if (lower.includes("red card")) return "red";
  if (lower.includes("yellow")) return "yellow";
  if (lower.includes("penalty")) return "penalty";
  if (lower.includes("substitut")) return "sub";
  if (lower.includes("dangerous")) return "danger";
  if (lower.includes("corner")) return "corner";
  if (lower.includes("possession")) return "possession";
  if (lower.includes("attack")) return "attack";
  if (lower.includes("free kick")) return "freekick";
  if (lower.includes("goal kick")) return "goalkick";
  if (lower.includes("throw")) return "throw";
  if (lower.includes("offside")) return "offside";
  if (lower.includes("shot") || lower.includes("save")) return "shot";
  if (lower.includes("half time") || lower.includes("kick off")) return "start";
  return "note";
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
  const status = String(raw.match_status || "").trim();
  const lower = status.toLowerCase();

  // Some rows carry a separate live flag, so trust that first.
  const liveFlag = String(raw.match_live || "").trim() === "1";

  // A bare number is the minute. So is something like "45+2".
  const minute = parseInt(status, 10);
  if (!Number.isNaN(minute) && /^\d/.test(status)) {
    return { short: "LIVE", long: "In play", elapsed: minute };
  }

  if (lower === "" ) {
    // Empty usually means not started, but if the live flag is set
    // the game is on and the API just has no minute for it.
    return liveFlag
      ? { short: "LIVE", long: "In play", elapsed: null }
      : { short: "NS", long: "Not started", elapsed: null };
  }

  if (lower.includes("half") || lower === "ht" || lower === "break") {
    return { short: "HT", long: "Half time", elapsed: null };
  }
  if (lower.includes("finish") || lower === "ft" || lower === "ended" ||
      lower.includes("after et") || lower === "aet" || lower === "pen" ||
      lower.includes("full")) {
    return { short: "FT", long: "Finished", elapsed: null };
  }
  if (lower.includes("postpon") || lower.includes("cancel") ||
      lower.includes("abandon") || lower.includes("suspend")) {
    return { short: "PST", long: status, elapsed: null };
  }

  // Something we have not seen before. If the live flag is on,
  // treat it as being played.
  return liveFlag
    ? { short: "LIVE", long: status || "In play", elapsed: null }
    : { short: status, long: status, elapsed: null };
}

// Turns the goals, cards and substitutions into one list of
// moments in time order, each with a line of text. The API does
// not send written commentary on this plan, so we write it from
// what actually happened.
function buildCommentary(raw) {
  const home = raw.match_hometeam_name;
  const away = raw.match_awayteam_name;
  const feed = [];

  const minuteOf = function (value) {
    const n = parseInt(String(value || "").replace("'", ""), 10);
    return Number.isNaN(n) ? 0 : n;
  };

  for (const goal of (raw.goalscorer || [])) {
    const isHome = Boolean(goal.home_scorer);
    const scorer = isHome ? goal.home_scorer : goal.away_scorer;
    if (!scorer) continue;

    const own = String(goal.info || "").toLowerCase().includes("own goal");
    const pen = String(goal.info || "").toLowerCase().includes("penalty");

    let text = "GOAL! " + scorer.trim();
    if (own) text = "OWN GOAL. " + scorer.trim();
    else if (pen) text = "PENALTY SCORED. " + scorer.trim();

    text += " for " + (isHome ? home : away) + ".";
    if (goal.score) text += " It is " + goal.score.replace(/\s+/g, " ").trim() + ".";

    feed.push({ minute: minuteOf(goal.time), kind: "goal", text: text });
  }

  for (const card of (raw.cards || [])) {
    const isHome = Boolean(card.home_fault);
    const player = (isHome ? card.home_fault : card.away_fault) || "";
    if (!player) continue;

    const red = String(card.card || "").toLowerCase().includes("red");
    const text = (red ? "RED CARD. " : "Yellow card. ") + player.trim() +
                 " of " + (isHome ? home : away) + ".";

    feed.push({ minute: minuteOf(card.time), kind: red ? "red" : "yellow", text: text });
  }

  const subs = raw.substitutions || {};
  for (const side of ["home", "away"]) {
    for (const sub of (subs[side] || [])) {
      const who = String(sub.substitution || "").trim();
      if (!who) continue;
      feed.push({
        minute: minuteOf(sub.time),
        kind: "sub",
        text: "Substitution for " + (side === "home" ? home : away) + ": " + who + ".",
      });
    }
  }

  feed.sort(function (a, b) { return a.minute - b.minute; });

  // Bookend it so the feed reads like a match rather than a list.
  const status = readStatus(raw);
  feed.unshift({ minute: 0, kind: "start", text: "Kick off. " + home + " against " + away + "." });

  if (status.short === "FT") {
    const score = (raw.match_hometeam_score || "0") + "-" + (raw.match_awayteam_score || "0");
    feed.push({ minute: 91, kind: "end", text: "Full time. " + home + " " + score + " " + away + "." });
  } else if (status.short === "HT") {
    feed.push({ minute: 46, kind: "end", text: "Half time." });
  }

  return feed;
}

// Splits "4-2-3-1" into rows of players in front of the keeper.
function readFormation(text, howMany) {
  const rows = String(text || "").split("-")
    .map(function (n) { return parseInt(n, 10); })
    .filter(function (n) { return !Number.isNaN(n) && n > 0; });

  const total = rows.reduce(function (a, b) { return a + b; }, 0);

  // Fall back to a sensible shape if the formation is missing or
  // does not add up to the number of outfield players.
  if (rows.length === 0 || total !== howMany) {
    if (howMany === 10) return [4, 4, 2];
    return [howMany];
  }
  return rows;
}

// Turns one side's line-up into players with a place on the pitch.
function layOutSide(side, formation, squad) {
  const starters = (side.starting_lineups || []).slice();

  // lineup_position is 1 for the keeper, then up the pitch.
  starters.sort(function (a, b) {
    return Number(a.lineup_position) - Number(b.lineup_position);
  });

  const withInfo = starters.map(function (player) {
    const extra = squad[String(player.player_key)] || {};
    return {
      name: player.lineup_player,
      number: player.lineup_number || extra.number || "",
      key: String(player.player_key),
      image: extra.image || "",
    };
  });

  if (withInfo.length === 0) {
    return { keeper: null, rows: [], bench: [], coach: "", missing: [] };
  }

  const keeper = withInfo[0];
  const outfield = withInfo.slice(1);
  const shape = readFormation(formation, outfield.length);

  const rows = [];
  let at = 0;
  for (const count of shape) {
    rows.push(outfield.slice(at, at + count));
    at += count;
  }

  // The bench and whoever is in charge.
  const bench = (side.substitutes || []).map(function (player) {
    const extra = squad[String(player.player_key)] || {};
    return {
      name: player.lineup_player,
      number: player.lineup_number || extra.number || "",
      image: extra.image || "",
    };
  });

  const coachEntry = (side.coach || [])[0];
  const coach = coachEntry ? coachEntry.lineup_player : "";

  const missing = (side.missing_players || []).map(function (player) {
    return player.lineup_player;
  });

  return {
    keeper: keeper, rows: rows,
    bench: bench, coach: coach, missing: missing,
  };
}

function translateMatch(raw) {
  const goals = raw.goalscorer || [];

  return {
    fixture: {
      id: Number(raw.match_id),
      // Their date and time arrive separately.
      // The Z matters. Without it the phone reads this as a local
      // time and everyone outside the API's timezone sees it wrong.
      date: raw.match_date + "T" + (raw.match_time || "00:00") + ":00Z",
      status: readStatus(raw),
    },
    league: {
      id: Number(raw.league_id),
      name: raw.league_name,
      country: raw.country_name,
      logo: raw.league_logo || raw.country_logo || "",
    },
    teams: {
      home: {
        id: Number(raw.match_hometeam_id) || null,
        name: raw.match_hometeam_name,
        logo: raw.team_home_badge || "",
      },
      away: {
        id: Number(raw.match_awayteam_id) || null,
        name: raw.match_awayteam_name,
        logo: raw.team_away_badge || "",
      },
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
    commentary: buildCommentary(raw),
    formations: {
      home: raw.match_hometeam_system || "",
      away: raw.match_awayteam_system || "",
    },
    // Filled in later, once the squads have been looked up.
    pitch: null,
    extras: {
      stadium: raw.match_stadium || "",
      referee: raw.match_referee || "",
      round: raw.match_round || "",
    },
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

// A span of days in one request. The fixtures screen asks for the
// day either side of the one being shown, because a match at half
// past midnight in Perth is still the night before in UTC.
async function getFixturesRange(from, to) {
  const name = "fixtures-" + from + "-" + to;
  const hit = fromCache(name, 600);
  if (hit) return hit;

  const raw = await askApi("get_events", "&from=" + from + "&to=" + to);
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

// Just the score and the teams. No line-ups, no squad lookups, so
// it costs one API call rather than three.
async function getMatchLight(fixtureId) {
  const name = "light-" + fixtureId;
  const hit = fromCache(name, 60);
  if (hit) return hit;

  // If the full version is already cached, reuse it for free.
  const full = cache["match-" + fixtureId];
  if (full && (Date.now() - full.time) / 1000 < 60) return full.data;

  const result = await askApi("get_events", "&match_id=" + fixtureId);
  if (result === null || result.length === 0) {
    return cache[name] ? cache[name].data : null;
  }

  return intoCache(name, translateMatch(result[0]));
}

async function getMatch(fixtureId) {
  const name = "match-" + fixtureId;
  const hit = fromCache(name, 60);
  if (hit) return hit;

  const result = await askApi("get_events", "&match_id=" + fixtureId);
  if (result === null || result.length === 0) {
    return cache[name] ? cache[name].data : null;
  }

  const raw = result[0];
  const match = translateMatch(raw);

  // Look up both squads so the pitch can show faces. Cached for a
  // day, so it is one extra call per club per day.
  const lineup = raw.lineup || {};
  const hasLineup =
    (lineup.home && (lineup.home.starting_lineups || []).length > 0) ||
    (lineup.away && (lineup.away.starting_lineups || []).length > 0);

  // Minute-by-minute commentary, live matches only.
  if (String(raw.match_live || "").trim() === "1") {
    const live = await getLiveComments(fixtureId);
    if (live.length > 0) {
      // Keep our own goal and card lines, drop the plain kick off
      // marker since the real feed has its own.
      const ours = (match.commentary || []).filter(function (m) {
        return m.kind === "goal" || m.kind === "red" || m.kind === "yellow";
      });
      match.commentary = ours.concat(live).sort(function (a, b) {
        return a.minute - b.minute;
      });
      match.hasLiveCommentary = true;
    }
  }

  if (hasLineup) {
    console.log("   line-up found, looking up squads");
    const homeSquad = raw.match_hometeam_id ? await getSquad(raw.match_hometeam_id) : {};
    const awaySquad = raw.match_awayteam_id ? await getSquad(raw.match_awayteam_id) : {};

    match.pitch = {
      home: layOutSide(lineup.home || {}, raw.match_hometeam_system, homeSquad),
      away: layOutSide(lineup.away || {}, raw.match_awayteam_system, awaySquad),
    };
  } else {
    console.log("   no line-up in this response");
  }

  return intoCache(name, match);
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

// A club's squad, kept for a day. Used to find player photos,
// because the line-up data only carries names and keys.
async function getSquad(teamId) {
  const name = "squad-" + teamId;
  const hit = fromCache(name, 86400);
  if (hit) return hit;

  const raw = await askApi("get_teams", "&team_id=" + teamId);
  if (raw === null || raw.length === 0) {
    return cache[name] ? cache[name].data : {};
  }

  // Key the players by their id so the line-up can look them up.
  const byId = {};
  for (const player of (raw[0].players || [])) {
    byId[String(player.player_id)] = {
      name: player.player_name || "",
      image: player.player_image || "",
      number: player.player_number || "",
      position: player.player_type || "",
      goals: Number(player.player_goals) || 0,
      assists: Number(player.player_assists) || 0,
      yellow: Number(player.player_yellow_cards) || 0,
      red: Number(player.player_red_cards) || 0,
      played: Number(player.player_match_played) || 0,
      rating: player.player_rating || "",
    };
  }

  return intoCache(name, byId);
}

// Fixtures for one club across a date range.
async function getTeamFixtures(teamId, from, to) {
  const name = "tf-" + teamId + "-" + from;
  const hit = fromCache(name, 900);
  if (hit) return hit;

  const raw = await askApi("get_events",
    "&team_id=" + teamId + "&from=" + from + "&to=" + to);
  if (raw === null) return cache[name] ? cache[name].data : [];

  return intoCache(name, raw.map(translateMatch));
}

// A club's whole season, kept for an hour.
async function getSeason(teamId) {
  const name = "season-" + teamId;
  const hit = fromCache(name, 3600);
  if (hit) return hit;

  const span = seasonRange();
  const raw = await askApi("get_events",
    "&team_id=" + teamId + "&from=" + span.from + "&to=" + span.to);

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

// ---------------------------------------------------------------
// NEWS
//
// There is no news endpoint on apifootball, so headlines come from
// public RSS feeds. Only the headline, the source and a link out are
// kept - the article itself stays with whoever wrote it.
// ---------------------------------------------------------------
const NEWS_FEEDS = [
  { name: "BBC Sport", url: "https://feeds.bbci.co.uk/sport/football/rss.xml" },
  { name: "Sky Sports", url: "https://www.skysports.com/rss/12040" },
];

function tidyXml(text) {
  return String(text || "")
    .replace(/<!\[CDATA\[/g, "")
    .replace(/\]\]>/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function readFeed(xml, sourceName) {
  const items = [];
  const blocks = String(xml).split(/<item[\s>]/).slice(1);

  for (const block of blocks) {
    const title = tidyXml((block.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]);
    const link = tidyXml((block.match(/<link[^>]*>([\s\S]*?)<\/link>/) || [])[1]);
    const when = tidyXml((block.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/) || [])[1]);
    const image = (block.match(/<media:thumbnail[^>]*url="([^"]+)"/) || [])[1] || "";

    if (!title || !link) continue;

    const stamp = when ? new Date(when) : null;
    items.push({
      title: title,
      link: link,
      source: sourceName,
      image: image,
      at: stamp && !isNaN(stamp) ? stamp.toISOString() : null,
    });
  }
  return items;
}

async function getNews() {
  const hit = fromCache("news", 900);
  if (hit) return hit;

  const gathered = [];

  for (const feed of NEWS_FEEDS) {
    try {
      const response = await fetch(feed.url, {
        headers: { "User-Agent": "GoalFlash/1.0" },
      });
      if (!response.ok) continue;
      const xml = await response.text();
      for (const item of readFeed(xml, feed.name).slice(0, 25)) {
        gathered.push(item);
      }
    } catch (error) {
      console.log("   !! news feed failed: " + feed.name);
    }
  }

  // Newest first, whichever paper it came from.
  gathered.sort(function (a, b) {
    return new Date(b.at || 0) - new Date(a.at || 0);
  });

  if (gathered.length === 0) {
    return cache["news"] ? cache["news"].data : [];
  }

  return intoCache("news", gathered.slice(0, 40));
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

// Seasons run roughly July to June, so work out which one we are in.
function seasonRange() {
  const now = new Date();
  const startYear = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return {
    from: startYear + "-07-01",
    to: (startYear + 1) + "-06-30",
  };
}

function isoToday() {
  const now = new Date();
  return now.getFullYear() + "-" +
    String(now.getMonth() + 1).padStart(2, "0") + "-" +
    String(now.getDate()).padStart(2, "0");
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
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0B1E3D">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<link rel="icon" href="/logo.png">
<link rel="apple-touch-icon" href="/logo.png">
<title>GoalFlash</title>
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
    cursor: pointer;
    width: 34px; height: 34px; border-radius: 50%;
    background: #EF9F27; color: #412402;
    display: flex; align-items: center; justify-content: center;
    font-size: 14px; font-weight: 600;
  }
  /* XP now sits small, on the right */
  .xpRow {
    display: flex; align-items: center; justify-content: flex-end;
    gap: 6px; padding-bottom: 10px;
  }
  .xpTrack {
    width: 90px; height: 4px; background: #042C53;
    border-radius: 2px; overflow: hidden; flex-shrink: 0;
  }
  .xpFill { height: 100%; background: #EF9F27; width: 0%; }
  .xpText { font-size: 10px; color: #B5D4F4; }

  /* Rolling live scores across the header */
  .ticker {
    flex: 1; min-width: 0; overflow: hidden;
    margin: 0 10px; height: 34px;
    display: flex; align-items: center;
  }
  .tickerInner {
    width: 100%; opacity: 1;
    transition: opacity 0.35s;
  }
  .tickerInner.fade { opacity: 0; }
  .tickerLine {
    display: flex; align-items: center; gap: 6px;
    font-size: 13px; color: #fff; white-space: nowrap;
  }
  .tickerLine img { width: 16px; height: 16px; object-fit: contain; flex-shrink: 0; }
  .tickerLine .nm {
    overflow: hidden; text-overflow: ellipsis;
    max-width: 90px;
  }
  .tickerLine .sc { font-weight: 600; }
  .tickerLine .mn { color: #EF9F27; font-size: 11px; margin-left: 2px; }
  .tickerQuiet { font-size: 12px; color: #85B7EB; }

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
  .when { width: 44px; font-size: 12px; color: #BA7517; flex-shrink: 0; font-weight: 600; }
  .when.grey { color: #777; font-weight: 400; }
  .when.live { color: #BA7517; }
  .teams { flex: 1; min-width: 0; }
  .teamRow {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
  }
  .teamRow:first-child { margin-bottom: 7px; }
  .teamName { display: flex; align-items: center; gap: 8px; font-size: 15px; min-width: 0; }
  .teamName span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .crest { width: 22px; height: 22px; object-fit: contain; flex-shrink: 0; }
  .goals { font-size: 15px; font-weight: 600; flex-shrink: 0; }
  .bell {
    font-size: 19px; color: #D5D5D0; cursor: pointer;
    flex-shrink: 0; user-select: none;
  }
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
  .tableRow.meRow { background: #E6F1FB; }
  .tableRow.meRow .colTeam span { font-weight: 600; }
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

  /* Commentary feed */
  .vizBox {
    background: #fff; padding: 12px 16px 10px;
    border-bottom: 1px solid #E8E8E4;
  }
  .vizInner { max-width: 520px; margin: 0 auto; }
  .vizInner svg { display: block; }
  .vizHead {
    display: flex; align-items: center; justify-content: space-between;
    font-size: 11px; color: #777; margin-bottom: 8px;
  }
  .vizKey { display: flex; align-items: center; font-size: 10px; color: #999; }
  .vizKey i {
    display: inline-block; width: 8px; height: 8px;
    border-radius: 2px; margin-right: 4px;
  }

  .commRow {
    display: flex; gap: 12px; padding: 12px 16px;
    background: #fff; border-bottom: 1px solid #E8E8E4;
  }
  .commMin {
    width: 34px; flex-shrink: 0; font-size: 12px;
    color: #777; padding-top: 2px;
  }
  .commIcon { width: 20px; flex-shrink: 0; font-size: 15px; }
  .commText { flex: 1; font-size: 14px; line-height: 1.45; }
  .commRow.goal { background: #FFF8EA; }
  .commRow.goal .commText { font-weight: 600; }
  .commRow.goal .commMin { color: #BA7517; font-weight: 600; }
  .commRow.red { background: #FDF0F0; }
  .commRow.danger { background: #FFF4E8; }
  .commRow.danger .commText { font-weight: 600; }
  .commRow.corner .commMin, .commRow.attack .commMin,
  .commRow.danger .commMin { color: #185FA5; }
  .commRow.possession .commText, .commRow.throw .commText,
  .commRow.goalkick .commText, .commRow.note .commText { color: #777; }
  .commRow.possession, .commRow.throw, .commRow.goalkick { padding: 8px 16px; }
  .liveTag2 {
    display: inline-block; font-size: 10px; padding: 2px 7px;
    border-radius: 8px; background: #FAEEDA; color: #854F0B;
    margin-left: 8px;
  }
  .commRow.start .commText, .commRow.end .commText { color: #555; font-style: italic; }

  /* Pitch view */
  .pitchWrap { background: #fff; padding: 12px 8px 16px; }
  .pitchNote {
    display: flex; justify-content: space-between;
    padding: 0 8px 10px; font-size: 12px; color: #777;
  }
  .pitchNote b { font-weight: 600; color: #333; }
  .sheets { display: flex; gap: 1px; background: #E8E8E4; }
  .sheetCol { flex: 1; min-width: 0; background: #fff; }
  .sheetHead {
    padding: 9px 10px; font-size: 12px; font-weight: 600;
    color: #fff; text-align: center;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sheetHead.home { background: #185FA5; }
  .sheetHead.away { background: #BA7517; }
  .sheetRow {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 10px; border-bottom: 1px solid #F0F0EC;
    font-size: 13px;
  }
  .sheetNum {
    width: 20px; flex-shrink: 0; text-align: right;
    color: #999; font-size: 12px;
  }
  .sheetName {
    flex: 1; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sheetGoal { font-size: 11px; }
  .sheetSub {
    padding: 8px 10px; background: #F1EFE8;
    font-size: 11px; color: #666; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.3px;
  }
  .benchRow .sheetName { color: #666; }
  .sheetNone { color: #999; font-size: 12px; }
  .subMark { font-size: 9px; flex-shrink: 0; }
  .subMark.off { color: #E24B4A; }
  .subMark.on { color: #639922; }

  .extras {
    padding: 10px 16px; background: #F4F4F2;
    font-size: 12px; color: #666; line-height: 1.6;
  }

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
    max-width: 82vw; background: #FFFFFF; z-index: 50;
    transform: translateX(-100%); transition: transform 0.22s;
    display: flex; flex-direction: column;
  }
  .drawer.open { transform: translateX(0); }
  .drawerTop {
    background: #0B1E3D; color: #fff;
    padding: calc(16px + env(safe-area-inset-top, 0px)) 16px 16px;
    display: flex; align-items: center; justify-content: space-between;
    flex-shrink: 0;
  }
  .drawerTop span:first-child { font-size: 16px; font-weight: 500; }
  .drawerClose { font-size: 20px; cursor: pointer; user-select: none; }
  .drawerBody { overflow-y: auto; flex: 1; }
  .drawerHint {
    padding: 9px 16px; background: #F0F1F4;
    font-size: 11px; color: #6B7280; text-transform: uppercase;
    letter-spacing: 0.4px; font-weight: 700;
  }
  .countryItem {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px; cursor: pointer;
    border-bottom: 1px solid #ECEEF1;
  }
  .countryItem img {
    width: 18px; height: 18px; object-fit: contain;
    flex-shrink: 0; border-radius: 2px;
  }
  .countryItem .cname {
    flex: 1; font-size: 14px; color: #111827; font-weight: 600;
  }
  .countryItem .arrow { font-size: 11px; color: #9CA3AF; }
  .countryItem:hover { background: #F5F6F8; }
  .leagueChild {
    padding: 11px 16px 11px 44px; font-size: 13px;
    color: #374151; font-weight: 500;
    cursor: pointer; background: #F8F9FB;
    border-bottom: 1px solid #ECEEF1;
  }
  .leagueChild:hover { background: #EFF6FF; }

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

  /* Club player stats */
  .statHead {
    display: flex; align-items: center; padding: 8px 16px;
    background: #E8E8E4; font-size: 11px; color: #555;
  }
  .statRow {
    display: flex; align-items: center; padding: 9px 16px;
    background: #fff; border-bottom: 1px solid #E8E8E4;
  }
  .shPlayer {
    flex: 1; min-width: 0; display: flex;
    align-items: center; gap: 9px;
  }
  .shPlayer img {
    width: 28px; height: 28px; border-radius: 50%;
    object-fit: cover; flex-shrink: 0; background: #F1EFE8;
  }
  .noFace {
    width: 28px; height: 28px; border-radius: 50%;
    background: #E8E8E4; color: #777; font-size: 11px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .pName {
    font-size: 14px; overflow: hidden;
    text-overflow: ellipsis; white-space: nowrap;
  }
  .shNum { width: 34px; text-align: center; font-size: 13px; color: #777; }
  .shNum.strong { font-weight: 600; color: #1a1a1a; }
  .shNum.yel { color: #BA7517; }
  .shNum.red { color: #E24B4A; }

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
    display: flex; align-items: flex-end;
    background: #fff; border-top: 1px solid #E8E8E4;
    padding: 8px 0 10px; z-index: 30;
  }
  .navItem {
    flex: 1; text-align: center; font-size: 10px;
    color: #999; cursor: pointer; user-select: none;
  }
  .navItem.on { color: #185FA5; }
  .navIcon { font-size: 18px; display: block; margin-bottom: 3px; }

  /* The home button sits raised in the middle. */
  .navHome {
    flex: 1; text-align: center; cursor: pointer;
    user-select: none; position: relative;
  }
  .navHomeBall {
    width: 54px; height: 54px; border-radius: 50%;
    background: #185FA5; color: #fff;
    display: flex; align-items: center; justify-content: center;
    font-size: 26px; margin: -26px auto 2px;
    border: 4px solid #fff;
    box-shadow: 0 2px 8px rgba(0,0,0,0.18);
  }
  .navHome.on .navHomeBall { background: #EF9F27; }
  .navHomeLabel { font-size: 10px; color: #999; }
  .navHome.on .navHomeLabel { color: #185FA5; }

  /* Two-column home screen */
  /* Home board of favourite badges */
  .board { background: #fff; border-bottom: 1px solid #E8E8E4; }
  .boardHead {
    padding: 12px 16px 8px; font-size: 11px;
    color: #888; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.4px;
  }
  .slotRow {
    display: grid; grid-template-columns: repeat(5, 1fr);
    gap: 10px; padding: 0 14px 14px;
  }
  .slot {
    width: 100%; aspect-ratio: 1; border-radius: 50%;
    background: #F4F4F2;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; overflow: hidden;
    border: 1px solid #E4E4E0;
  }
  .slot img { width: 62%; height: 62%; object-fit: contain; }
  .slot:active { background: #E8E8E4; }
  .slotEmpty {
    border: 1.5px dashed #D5D5D0; background: transparent;
    color: #C4C4BE; font-size: 17px;
  }

  /* Next games for followed clubs */
  .upRow {
    display: flex; align-items: center; gap: 10px;
    padding: 10px 16px; background: #fff;
    border-bottom: 1px solid #E8E8E4; cursor: pointer;
  }
  .upCrest { width: 20px; height: 20px; object-fit: contain; flex-shrink: 0; }
  .upTeams {
    flex: 1; min-width: 0; font-size: 13px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .upWhen { font-size: 11px; color: #888; flex-shrink: 0; }

  /* Profile screen */
.profHead {
  background: #0B1E3D; color: #fff; margin: 12px;
  border-radius: 14px; padding: 18px;
  display: flex; align-items: center; gap: 16px;
}
.profCrest {
  width: 66px; height: 66px; border-radius: 50%;
  background: #16305A; flex-shrink: 0; position: relative;
  display: flex; align-items: center; justify-content: center;
}
.profCrest img { width: 44px; height: 44px; object-fit: contain; }
.profLevelBig { font-size: 26px; font-weight: 700; color: #F5A623; }
.profLevelTag {
  position: absolute; right: -3px; bottom: -3px;
  min-width: 24px; height: 24px; padding: 0 5px;
  border-radius: 12px; background: #F5A623; color: #3A2400;
  font-size: 12px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  border: 2px solid #0B1E3D;
}
.profNameBox { min-width: 0; }
.profNick { font-size: 19px; font-weight: 600; }
.profUnder { font-size: 12px; color: #8FA6C4; margin-top: 3px; }
.profClub { font-size: 12px; color: #F5A623; margin-top: 4px; }

.profGrid {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: 8px; padding: 0 12px 12px;
}
.profGrid.two { grid-template-columns: repeat(2, 1fr); }
.profCell {
  background: #fff; border: 1px solid #ECEEF1; border-radius: 12px;
  padding: 12px 8px; text-align: center;
}
.profCell b { display: block; font-size: 17px; color: #111827; }
.profCell span { font-size: 10px; color: #6B7280; }

.trophyWrap {
  display: flex; flex-wrap: wrap; gap: 8px; padding: 0 12px 12px;
}
.trophy, .chipItem {
  display: flex; align-items: center; gap: 7px;
  background: #fff; border: 1px solid #ECEEF1;
  border-radius: 18px; padding: 7px 13px; font-size: 12px;
}
.trophy span { font-size: 14px; }
.chipItem img { width: 16px; height: 16px; object-fit: contain; }

.badgePick {
  display: flex; gap: 10px; padding: 0 16px 14px;
}
.pickOne {
  width: 46px; height: 46px; border-radius: 50%;
  background: #fff; border: 2px solid #ECEEF1;
  display: flex; align-items: center; justify-content: center;
  cursor: pointer; flex-shrink: 0;
}
.pickOne.on { border-color: #F5A623; }
.pickOne img { width: 28px; height: 28px; object-fit: contain; }
.pickLevel { font-size: 15px; font-weight: 700; color: #6B7280; }
.pickOne.on .pickLevel { color: #F5A623; }

.recentRow {
  display: flex; align-items: center; gap: 8px;
  background: #fff; margin: 0 12px 8px;
  border: 1px solid #ECEEF1; border-radius: 12px;
  padding: 11px 13px; font-size: 13px;
}
.recentStar { color: #F5A623; font-size: 13px; flex-shrink: 0; }
.recentRow img { width: 18px; height: 18px; object-fit: contain; flex-shrink: 0; }
.recentName {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.recentName.right { text-align: right; }
.recentScore { font-weight: 700; flex-shrink: 0; }

.level.hasCrest { background: #F5A623; padding: 3px; }
.level.hasCrest img { width: 100%; height: 100%; object-fit: contain; }

/* Settings */
  .setRow {
    display: flex; align-items: center; justify-content: space-between;
    gap: 14px; padding: 13px 16px; background: #fff;
    border-bottom: 1px solid #E8E8E4;
  }
  .setTap { cursor: pointer; }
  .setTap:active { background: #F4F4F2; }
  .setLabel { font-size: 14px; }
  .setRight {
    font-size: 13px; color: #888; text-align: right;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    max-width: 60%;
  }
  .setNote {
    padding: 10px 16px 14px; font-size: 12px;
    color: #888; line-height: 1.5; background: #F4F4F2;
  }
  .setDanger .setLabel { color: #C0392B; font-weight: 600; }

  /* Weekly league table */
  .leagueTime { float: right; color: #999; font-weight: 400; text-transform: none; }
  .movedBox {
    padding: 10px 16px; font-size: 13px; font-weight: 600;
  }
  .movedBox.up { background: #EAF3DE; color: #27500A; }
  .movedBox.down { background: #FCEBEB; color: #791F1F; }
  .lgRow {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid #F0F0EC;
    border-left: 3px solid transparent;
  }
  .lgRow.up { border-left-color: #639922; }
  .lgRow.down { border-left-color: #E24B4A; }
  .lgYou { background: #E6F1FB; }
  .lgYou .lgName { font-weight: 700; }
  .lgPos { width: 22px; font-size: 13px; color: #888; }
  .lgName {
    flex: 1; min-width: 0; font-size: 14px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .lgXp { font-size: 14px; font-weight: 600; }
  .lgKey {
    display: flex; gap: 16px; padding: 9px 16px;
    background: #F4F4F2; font-size: 11px; color: #777;
  }
  .lgKey i {
    display: inline-block; width: 9px; height: 3px;
    margin-right: 5px; vertical-align: middle;
  }
  .upDot { background: #639922; }
  .downDot { background: #E24B4A; }
  .nameRow {
    display: flex; gap: 8px; padding: 12px 16px;
    border-top: 1px solid #E8E8E4;
  }
  .nameField {
    flex: 1; min-width: 0; padding: 9px 11px;
    border: 1px solid #DDD; border-radius: 8px;
    font-size: 14px; outline: none;
  }
  .nameBtn {
    background: #185FA5; color: #fff; border: none;
    padding: 9px 18px; border-radius: 8px;
    font-size: 13px; font-weight: 600; cursor: pointer;
  }

  /* Account panel */
  .acctBox {
    background: #fff; padding: 16px;
    border-bottom: 1px solid #E8E8E4;
  }
  .acctHead { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
  .acctNote { font-size: 12px; color: #777; line-height: 1.5; margin-bottom: 12px; }
  .acctField {
    width: 100%; padding: 11px 12px; margin-bottom: 8px;
    border: 1px solid #DDD; border-radius: 8px;
    font-size: 15px; outline: none; background: #FAFAF8;
  }
  .acctField:focus { border-color: #185FA5; background: #fff; }
  .acctButtons { display: flex; gap: 8px; margin-top: 4px; }
  .acctBtn {
    flex: 1; padding: 11px; border-radius: 8px; border: none;
    background: #185FA5; color: #fff;
    font-size: 14px; font-weight: 600; cursor: pointer;
  }
  .acctBtn.ghost {
    background: #fff; color: #185FA5; border: 1px solid #185FA5;
  }
  .acctMsg { font-size: 12px; color: #777; margin-top: 10px; min-height: 16px; }
  .acctMsg.bad { color: #C0392B; }
  .acctIn { display: flex; align-items: center; gap: 10px; }
  .acctTick {
    width: 22px; height: 22px; border-radius: 50%;
    background: #639922; color: #fff; font-size: 12px;
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
  }
  .acctWho {
    flex: 1; min-width: 0; font-size: 14px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .acctOut {
    background: none; border: none; color: #185FA5;
    font-size: 13px; cursor: pointer; flex-shrink: 0;
  }

  /* XP League screen */
  .profCard { background: #185FA5; padding: 16px; color: #fff; }
  .profTop { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; }
  .profRing {
    width: 58px; height: 58px; border-radius: 50%;
    background: #EF9F27; color: #412402; flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px; font-weight: 700;
  }
  .profWho { min-width: 0; }
  .profDiv { font-size: 19px; font-weight: 600; }
  .profSub { font-size: 12px; color: #B5D4F4; margin-top: 2px; }
  .profBar {
    height: 6px; background: #042C53; border-radius: 3px;
    overflow: hidden; margin-bottom: 6px;
  }
  .profFill { height: 100%; background: #EF9F27; }
  .profBarText { font-size: 11px; color: #B5D4F4; margin-bottom: 14px; }
  .profStats { display: flex; gap: 8px; }
  .profStats > div {
    flex: 1; background: #042C53; border-radius: 8px;
    padding: 9px 6px; text-align: center;
  }
  .profStats b { display: block; font-size: 17px; }
  .profStats span { font-size: 10px; color: #85B7EB; }
  .boostFlag {
    margin-top: 10px; padding: 7px; border-radius: 8px;
    background: #EF9F27; color: #412402;
    font-size: 12px; font-weight: 600; text-align: center;
  }

  .spinBox {
    background: #fff; padding: 16px; text-align: center;
    border-bottom: 1px solid #E8E8E4;
  }
  .spinHead { font-size: 13px; font-weight: 600; margin-bottom: 4px; }
  .spinSub { font-size: 12px; color: #777; margin-bottom: 12px; }
  .spinDone { font-size: 12px; color: #999; }
  .spinWon {
    font-size: 18px; font-weight: 700; color: #BA7517;
    margin: 8px 0 10px;
  }
  .spinBtn {
    background: #EF9F27; color: #412402; border: none;
    padding: 11px 34px; border-radius: 22px;
    font-size: 15px; font-weight: 600; cursor: pointer;
    min-width: 150px;
  }
  .spinBtn:disabled { background: #F1DDBE; cursor: default; }

  .listBox { background: #fff; border-bottom: 1px solid #E8E8E4; }
  .boxHead {
    padding: 11px 16px 9px; font-size: 11px; color: #888;
    font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px;
    background: #F4F4F2;
  }
  .earnRow {
    display: flex; align-items: center; gap: 10px;
    padding: 11px 16px; border-bottom: 1px solid #F0F0EC;
  }
  .earnLabel { flex: 1; font-size: 14px; }
  .earnCap { font-size: 12px; color: #999; }
  .earnXp { font-size: 13px; font-weight: 600; color: #BA7517; width: 38px; text-align: right; }
  .earnDone .earnLabel, .earnDone .earnXp { color: #BBB; }
  .earnDone .earnCap { color: #639922; }

  .rung {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; border-bottom: 1px solid #F0F0EC;
  }
  .rungNum {
    width: 22px; font-size: 12px; color: #AAA; text-align: center;
  }
  .rungName { flex: 1; font-size: 14px; }
  .rungReq { font-size: 11px; color: #999; }
  .rungNow { background: #FFF8EA; }
  .rungNow .rungName { font-weight: 700; color: #BA7517; }
  .rungLocked .rungName, .rungLocked .rungNum { color: #C4C4BE; }

  /* Challenges */
  .chGroup {
    display: flex; align-items: baseline; justify-content: space-between;
    padding: 12px 16px 9px; background: #F4F4F2;
    border-top: 1px solid #E8E8E4;
  }
  .chTitle {
    font-size: 12px; font-weight: 700; color: #444;
    text-transform: uppercase; letter-spacing: 0.4px;
  }
  .chNote { font-size: 11px; color: #999; }
  .chRow {
    padding: 12px 16px; background: #fff;
    border-bottom: 1px solid #E8E8E4;
  }
  .chTop {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 12px; margin-bottom: 8px;
  }
  .chText { font-size: 14px; flex: 1; min-width: 0; }
  .chXp { font-size: 13px; font-weight: 600; color: #BA7517; flex-shrink: 0; }
  .chBar {
    height: 6px; background: #EDEDE9; border-radius: 3px;
    overflow: hidden; margin-bottom: 7px;
  }
  .chFill { height: 100%; background: #185FA5; }
  .chBottom {
    display: flex; align-items: center; justify-content: space-between;
  }
  .chCount { font-size: 11px; color: #888; }
  .chTodo { font-size: 11px; color: #AAA; }
  .chDone { font-size: 11px; color: #639922; font-weight: 600; }
  .chClaim {
    background: #EF9F27; color: #412402; border: none;
    padding: 5px 16px; border-radius: 14px;
    font-size: 12px; font-weight: 600; cursor: pointer;
  }
  .chTaken { opacity: 0.55; }
  .chTaken .chFill { background: #639922; }

  /* Games the person is following */
  .followRow {
    display: flex; align-items: center; gap: 12px;
    padding: 11px 16px; background: #fff;
    border-bottom: 1px solid #E8E8E4; cursor: pointer;
  }
  .fWhen { width: 52px; flex-shrink: 0; font-size: 11px; color: #888; }
  .fWhen.liveNow { color: #BA7517; font-weight: 600; }
  .fTeams { flex: 1; min-width: 0; }
  .fLine {
    display: flex; align-items: center; gap: 8px;
    margin-bottom: 5px;
  }
  .fLine:last-child { margin-bottom: 0; }
  .fLine img { width: 18px; height: 18px; object-fit: contain; flex-shrink: 0; }
  .fName {
    flex: 1; min-width: 0; font-size: 14px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .fScore { font-size: 14px; font-weight: 600; flex-shrink: 0; }

  /* Live matches, three across */
  .liveCount {
    display: inline-block; margin-left: 6px; padding: 1px 7px;
    border-radius: 8px; background: #FAEEDA; color: #854F0B;
    font-size: 10px;
  }
  .liveGrid {
    display: grid; grid-template-columns: repeat(3, 1fr);
    gap: 7px; padding: 0 14px 16px;
  }
  .liveCard {
    background: #fff; border: 1px solid #E4E4E0;
    border-radius: 10px; padding: 7px 7px 8px; cursor: pointer;
  }
  .liveCard:active { background: #F4F4F2; }
  .lcTop {
    font-size: 10px; color: #BA7517; font-weight: 600;
    margin-bottom: 6px;
  }
  .lcSide {
    display: flex; align-items: center; justify-content: space-between;
    gap: 6px; margin-bottom: 4px;
  }
  .lcSide:last-child { margin-bottom: 0; }
  .lcSide img { width: 16px; height: 16px; object-fit: contain; flex-shrink: 0; }
  .lcTag {
    flex: 1; min-width: 0; font-size: 11px; color: #555;
    letter-spacing: 0.3px;
  }
  .lcScore { font-size: 14px; font-weight: 600; flex-shrink: 0; }

  .homeCols { display: flex; gap: 1px; background: #E8E8E4; }
  .homeCol { flex: 1; min-width: 0; background: #F4F4F2; }
  .colHead {
    padding: 9px 12px; background: #185FA5; color: #fff;
    font-size: 12px; font-weight: 600; text-align: center;
  }
  .miniMatch {
    background: #fff; padding: 10px 12px;
    border-bottom: 1px solid #E8E8E4;
  }
  .miniTop {
    display: flex; align-items: center; justify-content: space-between;
    margin-bottom: 6px; gap: 6px;
  }
  .miniWhen { font-size: 11px; color: #777; }
  .miniWhen.liveNow { color: #BA7517; font-weight: 600; }
  .miniBell { font-size: 14px; }
  .miniTeam {
    display: flex; align-items: center; gap: 6px;
    font-size: 13px; margin-bottom: 4px;
  }
  .miniTeam:last-child { margin-bottom: 0; }
  .miniTeam img { width: 16px; height: 16px; object-fit: contain; flex-shrink: 0; }
  .miniTeam span {
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .colEmpty { padding: 24px 12px; text-align: center; font-size: 12px; color: #888; }

  /* Favourites drill-down */
  .crumbs {
    display: flex; align-items: center; gap: 6px;
    padding: 10px 16px; background: #E8E8E4;
    font-size: 12px; color: #555;
  }
  .crumb { cursor: pointer; color: #185FA5; }
  .pickRow {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px; background: #fff;
    border-bottom: 1px solid #E8E8E4; cursor: pointer;
  }
  .pickRow img { width: 22px; height: 22px; object-fit: contain; flex-shrink: 0; }
  .pickRow .pname { flex: 1; font-size: 14px; min-width: 0;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pickRow .chev { font-size: 12px; color: #bbb; }

  /* Filter strip on the fixtures screen */
  .filterBar {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 16px; background: #E8E8E4;
    font-size: 13px; flex-wrap: wrap;
  }
  .chips { display: flex; gap: 6px; width: 100%; }
  .chip {
    flex: 1; display: flex; align-items: center; justify-content: center;
    gap: 5px; padding: 7px 6px; border-radius: 16px;
    background: #fff; border: 1px solid #D5D5D0;
    font-size: 12px; color: #555; cursor: pointer;
    user-select: none; white-space: nowrap;
  }
  .chip.on { background: #185FA5; border-color: #185FA5; color: #fff; }
  .chip .cIcon { font-size: 13px; }
  .chip .cCount {
    font-size: 10px; opacity: 0.75;
  }
  .filterBtn {
    background: #185FA5; color: #fff; border: none;
    padding: 6px 12px; border-radius: 14px;
    font-size: 12px; cursor: pointer;
  }
  .filterNote { flex: 1; color: #555; font-size: 12px; }
  .filterClear { color: #B33; font-size: 12px; cursor: pointer; }

/* =============================================================
   THE LOOK
   Dark navy chrome, light grey page, white cards.
   ============================================================= */
html { background: #0B1E3D; }
body {
  background: #F5F6F8; color: #111827;
  /* Clear of the home bar at the bottom of newer phones. */
  padding-bottom: calc(86px + env(safe-area-inset-bottom, 0px));
}

.header {
  background: #0B1E3D;
  /* The top padding leaves the clock and battery their own space. */
  padding: calc(14px + env(safe-area-inset-top, 0px)) 16px 0;
}
.headerTop { margin-bottom: 12px; }
.brand { display: flex; align-items: center; gap: 5px; min-width: 0; }
.brandBolt { font-size: 17px; line-height: 1; }
.brandName {
  font-size: 19px; font-weight: 700; color: #fff;
  letter-spacing: -0.3px; white-space: nowrap;
}
.brandName span { color: #F5A623; }
.burger { color: #fff; }
.cog { color: #8FA6C4; }
.coins { background: #16305A; color: #FFC24A; }
.level { background: #F5A623; color: #3A2400; font-weight: 700; }

.xpRow { justify-content: flex-start; gap: 10px; padding-bottom: 14px; }
.xpTrack { flex: 1; width: auto; height: 6px; background: #16305A; border-radius: 3px; }
.xpFill { background: #F5A623; }
.xpText { font-size: 11px; color: #8FA6C4; order: 2; }
.xpRow::before {
  content: "Level"; font-size: 11px; color: #F5A623;
  font-weight: 600; flex-shrink: 0;
}

.ticker {
  height: auto; margin: 0 0 12px; flex: none; width: 100%;
  padding: 8px 12px; background: #16305A; border-radius: 10px;
}
.tickerLine { font-size: 14px; gap: 8px; justify-content: center; }
.tickerLine img { width: 18px; height: 18px; }
.tickerLine .nm { max-width: none; }
.tickerLine .sc {
  padding: 0 6px; font-size: 15px;
}
.tickerLine .mn { color: #4ADE80; font-weight: 600; }
.tickerQuiet { display: block; text-align: center; }

.dates { border-top: 1px solid #16305A; }
.dateBtn { color: #8FA6C4; border-radius: 8px 8px 0 0; }
.dateBtn.on { color: #fff; background: #1E6FD9; border-bottom-color: transparent; }

/* ---- Cards instead of flat rows ---- */
.updated { color: #6B7280; font-size: 12px; }

.leagueRow, .countryRow {
  background: transparent; padding: 14px 16px 8px;
  font-size: 12px; color: #374151; font-weight: 600;
}

.match {
  background: #fff; margin: 0 12px 8px; border-radius: 12px;
  border: 1px solid #ECEEF1; border-bottom: 1px solid #ECEEF1;
  box-shadow: 0 1px 2px rgba(16,24,40,0.04);
}
.when { color: #16A34A; font-weight: 600; }
.when.grey { color: #9CA3AF; }
.crest { width: 20px; height: 20px; }
.teamName { font-size: 14px; }
.goals { font-size: 15px; }

/* ---- Filter chips ---- */
.filterBar { background: transparent; padding: 12px 12px 6px; }
.chips { gap: 7px; }
.chip {
  background: #fff; border: 1px solid #E5E7EB; color: #4B5563;
  border-radius: 18px; padding: 8px 4px; font-weight: 500;
}
.chip.on { background: #1E6FD9; border-color: #1E6FD9; color: #fff; }
.chip[data-state="live"].on { background: #16A34A; border-color: #16A34A; }
.chip[data-state="finished"].on { background: #6B7280; border-color: #6B7280; }
.chip .cCount { opacity: 0.8; }
.filterBtn { background: #1E6FD9; border-radius: 18px; }

/* ---- Home board ---- */
.board { background: transparent; border: none; }
.boardHead {
  padding: 16px 16px 10px; color: #6B7280;
  font-size: 11px; letter-spacing: 0.5px;
}
.slotRow { gap: 9px; padding: 0 12px 8px; }
.slot {
  aspect-ratio: auto; height: auto; border-radius: 12px;
  background: #fff; border: 1px solid #ECEEF1;
  flex-direction: column; gap: 5px; padding: 10px 4px 8px;
  box-shadow: 0 1px 2px rgba(16,24,40,0.04);
}
.slot img { width: 30px; height: 30px; }
.slotName {
  font-size: 9px; color: #4B5563; text-align: center;
  width: 100%; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; line-height: 1.2;
}
.slotEmpty {
  border: 1.5px dashed #D1D5DB; background: transparent;
  box-shadow: none; min-height: 62px; justify-content: center;
}

.upRow {
  background: #fff; margin: 0 12px 8px; border-radius: 12px;
  border: 1px solid #ECEEF1; box-shadow: 0 1px 2px rgba(16,24,40,0.04);
  padding: 12px 14px;
}
.followRow, .liveCard {
  background: #fff; border-radius: 12px; border: 1px solid #ECEEF1;
  box-shadow: 0 1px 2px rgba(16,24,40,0.04);
}
.followRow { margin: 0 12px 8px; }
.liveCount { background: #DCFCE7; color: #166534; }
.lcTop { color: #16A34A; }

/* ---- Bottom bar ---- */
.nav {
  background: #0B1E3D; border-top: none;
  padding: 12px 0 calc(14px + env(safe-area-inset-bottom, 0px));
}
.navItem { color: #7C93B4; font-size: 11px; }
.navIcon { font-size: 20px; margin-bottom: 4px; }
.navItem.on { color: #F5A623; }
.navHomeBall {
  width: 58px; height: 58px; font-size: 28px;
  margin: -28px auto 3px;
  background: #1E6FD9; border: 5px solid #0B1E3D;
  box-shadow: 0 0 0 3px rgba(30,111,217,0.25);
}
.navHomeLabel { font-size: 11px; }
.navHome.on .navHomeBall { background: #1E6FD9; }
.navHomeLabel { color: #7C93B4; }
.navHome.on .navHomeLabel { color: #fff; }

/* ---- Match centre ---- */
.matchHead, .leagueHead { background: #0B1E3D; }
.bigScore .clock { color: #4ADE80; }
.tabs { background: #fff; }
.tab.on { color: #1E6FD9; border-bottom-color: #1E6FD9; }
.lTab.on { color: #F5A623; border-bottom-color: #F5A623; }
.commRow, .event, .statBox, .vizBox { border-bottom-color: #ECEEF1; }

/* ---- Tables ---- */
.tableHead, .statHead { background: #F0F1F4; color: #6B7280; }
.tableRow, .statRow { border-bottom-color: #ECEEF1; }
.tableRow.meRow { background: #EFF6FF; }

/* ---- Challenges as cards ---- */
.chGroup { background: transparent; border-top: none; padding: 18px 16px 8px; }
.chTitle { color: #374151; }
.chRow {
  background: #fff; margin: 0 12px 9px; border-radius: 12px;
  border: 1px solid #ECEEF1; border-bottom: 1px solid #ECEEF1;
  box-shadow: 0 1px 2px rgba(16,24,40,0.04);
  display: flex; gap: 12px; align-items: flex-start;
}
.chIcon {
  width: 40px; height: 40px; border-radius: 10px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 18px; background: #EFF6FF;
}
.chBody { flex: 1; min-width: 0; }
.chXp { color: #F5A623; }
.chFill { background: #1E6FD9; }
.chTaken .chFill { background: #16A34A; }
.chDone { color: #16A34A; }
.chClaim { background: #F5A623; color: #3A2400; }

/* ---- XP screen ---- */
.acctBox { border-bottom: 1px solid #ECEEF1; }
.profCard {
  background: #0B1E3D; margin: 12px; border-radius: 14px;
  padding: 18px;
}
.profRing { background: #F5A623; }
.profStats > div { background: #16305A; border-radius: 10px; }
.profStats span { color: #8FA6C4; }

.spinBox {
  background: #fff; margin: 0 12px 12px; border-radius: 14px;
  border: 1px solid #ECEEF1; border-bottom: 1px solid #ECEEF1;
  display: flex; align-items: center; gap: 16px; text-align: left;
}
.spinWheel { width: 92px; height: 92px; flex-shrink: 0; }
.spinRight { flex: 1; min-width: 0; }
.spinHead { font-size: 16px; }
.spinBtn { background: #F5A623; color: #3A2400; min-width: 0; padding: 10px 22px; }

.listBox { background: transparent; }
.boxHead { background: transparent; color: #6B7280; padding: 16px 16px 8px; }
.earnRow, .rung {
  background: #fff; border-bottom: 1px solid #ECEEF1;
}
.earnXp { color: #F5A623; }
.earnIcon {
  width: 26px; height: 26px; border-radius: 7px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; background: #EFF6FF;
}

.lgRow { background: #fff; border-bottom: 1px solid #ECEEF1; }
.lgAvatar {
  width: 26px; height: 26px; border-radius: 50%;
  background: #E5E7EB; color: #6B7280; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  font-size: 12px;
}
.lgYou { background: #EFF6FF; }
.lgYou .lgName { color: #1E6FD9; }
.setRow { border-bottom-color: #ECEEF1; }

/* =============================================================
   CHROME THAT FOLLOWS YOU DOWN THE PAGE
   Only one of these three is ever on screen at a time, so they
   can all sit at the top.
   ============================================================= */
#mainHeader, #matchHead, #leagueHead {
  position: sticky; top: 0; z-index: 35;
}
#matchHead:empty, #leagueHead:empty { display: none; }

/* The badge in the corner of the bar. */
.brandLogo {
  width: 27px; height: 27px; border-radius: 50%;
  object-fit: contain; flex-shrink: 0; display: block;
}
.brand { gap: 8px; }

/* Live, News and Following, sitting under the bar on Home. */
.subTabs {
  display: flex; align-items: stretch;
  border-top: 1px solid #16305A;
}
.subTab {
  flex: 1; display: flex; align-items: center; justify-content: center;
  gap: 6px; padding: 11px 4px 9px;
  font-size: 13px; color: #8FA6C4; cursor: pointer;
  user-select: none; border-bottom: 2px solid transparent;
}
.subTab.on { color: #fff; border-bottom-color: #F5A623; }
.subIcon {
  height: 15px; width: auto; flex-shrink: 0;
  fill: none; stroke: currentColor; stroke-width: 1.5;
  stroke-linejoin: round;
}
.subTab[data-sub="following"] .subIcon { fill: none; }
.subTab[data-sub="following"].on .subIcon { fill: #F5A623; stroke: #F5A623; }

/* Kick-off times now carry the day above them. */
.when {
  width: 60px; flex-shrink: 0;
  display: flex; flex-direction: column; gap: 2px;
  line-height: 1.2;
}
.whenDate {
  font-size: 10px; color: #9CA3AF;
  font-weight: 500; white-space: nowrap;
}
.whenMain { font-size: 12.5px; font-weight: 600; color: inherit; }

/* Team names on the match screen go somewhere now. */
.side.tappable { cursor: pointer; }
.side.tappable div { text-decoration: underline; text-decoration-color: rgba(255,255,255,0.35); text-underline-offset: 3px; }
.side.tappable:active { opacity: 0.7; }

/* News */
.newsRow {
  display: flex; align-items: flex-start; gap: 12px;
  background: #fff; margin: 0 12px 8px; padding: 12px 14px;
  border: 1px solid #ECEEF1; border-radius: 12px;
  box-shadow: 0 1px 2px rgba(16,24,40,0.04);
  cursor: pointer; text-decoration: none; color: inherit;
}
.newsThumb {
  width: 62px; height: 62px; border-radius: 8px;
  object-fit: cover; flex-shrink: 0; background: #F0F1F4;
}
.newsBody { flex: 1; min-width: 0; }
.newsTitle { font-size: 14px; line-height: 1.35; color: #111827; }
.newsMeta { font-size: 11px; color: #6B7280; margin-top: 6px; }
.newsNote {
  padding: 4px 16px 16px; font-size: 11px;
  color: #9CA3AF; line-height: 1.5; text-align: center;
}
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
    <div style="display:flex; align-items:center; min-width:0; flex-shrink:0">
      <span class="burger" id="burger">&#9776;</span>
      <div class="brand">
        <img class="brandLogo" id="brandLogo" src="/logo.png" alt="">
        <span class="brandName">Goal<span>Flash</span></span>
      </div>
    </div>

    <div class="badges">
      <span class="cog" id="cogBtn" style="display:none">&#9881;</span>
      <div class="coins">&#9679; <span id="coins">0</span></div>
      <div class="level" id="level">1</div>
    </div>
  </div>
  <div class="ticker" id="ticker">
    <div class="tickerInner" id="tickerInner">
      <span class="tickerQuiet">&nbsp;</span>
    </div>
  </div>
  <div class="dates" id="dates" style="display:none"></div>
  <div id="pickerBox" style="display:none"></div>
  <div id="searchArea" style="display:none">
    <div class="searchBox">
      <span style="color:#888">&#128269;</span>
      <input id="searchInput" placeholder="Search country or league" autocomplete="off">
    </div>
  </div>
  <div class="subTabs" id="subTabs" style="display:none">
    <div class="subTab on" data-sub="live">
      <svg class="subIcon" viewBox="0 0 24 16" aria-hidden="true">
        <rect x="1" y="1" width="22" height="14" rx="1.5"/>
        <line x1="12" y1="1" x2="12" y2="15"/>
        <circle cx="12" cy="8" r="3.2"/>
        <rect x="1" y="4.5" width="3.5" height="7"/>
        <rect x="19.5" y="4.5" width="3.5" height="7"/>
      </svg>
      <span>Live</span>
    </div>
    <div class="subTab" data-sub="news">
      <svg class="subIcon" viewBox="0 0 20 16" aria-hidden="true">
        <rect x="1" y="1.5" width="15" height="13" rx="1.5"/>
        <path d="M16 5h3v7.5a2 2 0 0 1-3 0z"/>
        <line x1="4" y1="5" x2="13" y2="5"/>
        <line x1="4" y1="8" x2="13" y2="8"/>
        <line x1="4" y1="11" x2="10" y2="11"/>
      </svg>
      <span>News</span>
    </div>
    <div class="subTab" data-sub="following">
      <svg class="subIcon" viewBox="0 0 18 17" aria-hidden="true">
        <path d="M9 1.4l2.3 4.7 5.2.75-3.75 3.65.9 5.15L9 13.2l-4.65 2.45.9-5.15L1.5 6.85l5.2-.75z"/>
      </svg>
      <span>Following</span>
    </div>
  </div>
</div>

<div id="matchHead"></div>
<div id="leagueHead"></div>
<div class="updated" id="updated">Loading...</div>
<div id="list"></div>

<div class="nav">
  <div class="navItem" id="navFavourites"><span class="navIcon">&#9733;</span>Favourites</div>
  <div class="navItem" id="navFixtures"><span class="navIcon">&#128197;</span>Fixtures</div>
  <div class="navHome on" id="navHome">
    <div class="navHomeBall">&#9917;</div>
    <div class="navHomeLabel">Home</div>
  </div>
  <div class="navItem" id="navXp"><span class="navIcon">&#9889;</span>XP League</div>
  <div class="navItem" id="navChallenges"><span class="navIcon">&#127919;</span>Challenges</div>
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

// Declared here rather than beside the sign-in code, because the
// startup checks below run before that point in the file.
let authToken = localStorage.getItem("authToken") || "";
let authEmail = localStorage.getItem("authEmail") || "";

let xp = load("xp", 0);
let coins = load("coins", 0);
let alerts = JSON.parse(localStorage.getItem("alerts") || "[]");

// ---------------------------------------------------------------
// XP, STREAKS AND DAILY LIMITS
//
// Everything that earns XP has a daily cap, so nobody can farm it
// by tapping through matches. The caps reset at midnight.
// ---------------------------------------------------------------
const DIVISIONS = [
  { name: "Rookie",       from: 0 },
  { name: "Amateur",      from: 3 },
  { name: "Semi-Pro",     from: 6 },
  { name: "Professional", from: 10 },
  { name: "National",     from: 15 },
  { name: "Continental",  from: 21 },
  { name: "Elite",        from: 28 },
  { name: "Champions",    from: 36 },
  { name: "World Class",  from: 45 },
  { name: "Legend",       from: 55 },
];

// What each action is worth. No daily limits - people earn as
// much as they use the app.
const EARNINGS = {
  daily:   { xp: 5,  once: true, label: "Open the app" },
  match:   { xp: 5,  label: "Look at a match centre" },
  club:    { xp: 5,  label: "Check one of your clubs" },
  table:   { xp: 3,  label: "Look at a league table" },
  streak:  { xp: 50, once: true, label: "Seven days in a row" },
};

let streak = load("streak", 0);
let shields = load("shields", 0);
let boostUntil = load("boostUntil", 0);
let boostSize = load("boostSize", 1);

let dailyCounts = JSON.parse(localStorage.getItem("dailyCounts") || "null");
const todayKey = new Date().toDateString();

if (!dailyCounts || dailyCounts.day !== todayKey) {
  dailyCounts = { day: todayKey };
}

// ---------------------------------------------------------------
// COUNTERS
//
// Three timescales: today, this week, and the whole season. The
// challenges read from these.
// ---------------------------------------------------------------

// Weeks start on Monday. This gives a key like "2026-W35".
function weekKeyOf(date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7;          // Monday = 0
  d.setDate(d.getDate() - day);              // back to Monday
  return d.getFullYear() + "-W" +
    String(Math.ceil(((d - new Date(d.getFullYear(), 0, 1)) / 86400000 + 1) / 7))
      .padStart(2, "0");
}

// Seasons run July to June, same as the fixture lists.
function seasonKeyOf(date) {
  const d = new Date(date);
  const start = d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
  return start + "/" + String(start + 1).slice(2);
}

const thisWeek = weekKeyOf(new Date());
const thisSeason = seasonKeyOf(new Date());

let weekCounts = JSON.parse(localStorage.getItem("weekCounts") || "null");
if (!weekCounts || weekCounts.week !== thisWeek) {
  weekCounts = { week: thisWeek, days: [] };
}

let seasonCounts = JSON.parse(localStorage.getItem("seasonCounts") || "null");
if (!seasonCounts || seasonCounts.season !== thisSeason) {
  seasonCounts = { season: thisSeason, days: 0 };
}

// A record of XP earned each week, kept for the graph.
let xpHistory = JSON.parse(localStorage.getItem("xpHistory") || "[]");
let weekStartXp = load("weekStartXp", null);
let bestDivision = load("bestDivision", 1);
let badgeClub = JSON.parse(localStorage.getItem("badgeClub") || "null");

// First run, or the week just turned over.
if (weekStartXp === null) {
  weekStartXp = xp;
} else if (localStorage.getItem("weekStartKey") !== thisWeek) {
  const lastWeek = localStorage.getItem("weekStartKey");
  if (lastWeek) {
    xpHistory.push({ week: lastWeek, xp: Math.max(0, xp - weekStartXp) });
    // Two seasons of weeks is plenty to keep.
    if (xpHistory.length > 80) xpHistory = xpHistory.slice(-80);
  }
  weekStartXp = xp;
}
localStorage.setItem("weekStartKey", thisWeek);

function saveHistory() {
  localStorage.setItem("xpHistory", JSON.stringify(xpHistory));
  localStorage.setItem("weekStartXp", weekStartXp);
  localStorage.setItem("bestDivision", bestDivision);
  localStorage.setItem("badgeClub", JSON.stringify(badgeClub));
}
saveHistory();

// Rewards already taken, keyed by challenge and the period it
// belonged to, so dailies can be claimed again tomorrow.
let claimed = JSON.parse(localStorage.getItem("claimed") || "{}");

function saveCounters() {
  localStorage.setItem("weekCounts", JSON.stringify(weekCounts));
  localStorage.setItem("seasonCounts", JSON.stringify(seasonCounts));
  localStorage.setItem("claimed", JSON.stringify(claimed));
}

// Adds one to today, this week and this season all at once.
function tally(kind) {
  dailyCounts[kind] = (dailyCounts[kind] || 0) + 1;
  weekCounts[kind] = (weekCounts[kind] || 0) + 1;
  seasonCounts[kind] = (seasonCounts[kind] || 0) + 1;
  saveCounters();
}

function saveXpState() {
  if (typeof pushProgress === "function") pushProgress();
  localStorage.setItem("xp", xp);
  localStorage.setItem("coins", coins);
  localStorage.setItem("streak", streak);
  localStorage.setItem("shields", shields);
  localStorage.setItem("boostUntil", boostUntil);
  localStorage.setItem("boostSize", boostSize);
  localStorage.setItem("dailyCounts", JSON.stringify(dailyCounts));
}

function boostActive() {
  return Date.now() < boostUntil;
}

function currentMultiplier() {
  return boostActive() ? boostSize : 1;
}

// The one way XP is ever added. Returns how much was given.
function earn(kind) {
  const rule = EARNINGS[kind];
  if (!rule) return 0;

  const used = dailyCounts[kind] || 0;

  // A couple of things only pay once a day - opening the app and
  // the weekly streak bonus. Everything else is unlimited.
  if (rule.once && used >= 1) return 0;

  tally(kind);
  const amount = rule.xp * currentMultiplier();
  xp = xp + amount;
  saveXpState();
  drawProgress();
  return amount;
}

function levelNow() {
  return Math.floor(xp / 1000) + 1;
}

function divisionFor(level) {
  let found = DIVISIONS[0];
  for (const division of DIVISIONS) {
    if (level >= division.from) found = division;
  }
  return found;
}

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

// First visit of the day: streak, daily XP and a coin or two.
const lastOpen = localStorage.getItem("lastOpen");
if (lastOpen !== todayKey) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);

  // A day missed resets the streak.
  streak = (lastOpen === yesterday.toDateString()) ? streak + 1 : 1;

  xp = xp + EARNINGS.daily.xp;
  coins = coins + 2;
  dailyCounts.daily = 1;

  // Every seventh day pays a bonus.
  if (streak > 0 && streak % 7 === 0) {
    xp = xp + EARNINGS.streak.xp;
    coins = coins + 10;
  }

  // Note the day, for challenges counting how often someone comes back.
  if (!weekCounts.days.includes(todayKey)) weekCounts.days.push(todayKey);
  seasonCounts.days = (seasonCounts.days || 0) + 1;

  localStorage.setItem("lastOpen", todayKey);
  saveXpState();
  saveCounters();
}

function saveProgress() {
  localStorage.setItem("alerts", JSON.stringify(alerts));
  saveXpState();
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
  const badge = document.getElementById("level");
  const level = Math.floor(xp / 1000) + 1;

  // Show the chosen club crest if there is one, otherwise the level.
  if (badgeClub && badgeClub.logo) {
    badge.innerHTML = '<img src="' + badgeClub.logo + '" alt="Profile">';
    badge.classList.add("hasCrest");
  } else {
    badge.textContent = level;
    badge.classList.remove("hasCrest");
  }

  document.getElementById("coins").textContent = coins;
}

// ---------------------------------------------------------------
// GOAL ALERTS
//
// The browser can pop a notification while the app is open. Proper
// background alerts need the phone app, but this works today.
// ---------------------------------------------------------------
let lastKnownScores = {};

function notificationsAllowed() {
  return typeof Notification !== "undefined" && Notification.permission === "granted";
}

async function askForNotifications() {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  if (Notification.permission === "denied") return false;
  const answer = await Notification.requestPermission();
  return answer === "granted";
}

function toggleAlert(fixtureId, element) {
  const position = alerts.indexOf(fixtureId);

  if (position === -1) {
    alerts.push(fixtureId);
    if (element) element.classList.add("on");
    tally("star");
    // Ask the first time somebody turns one on.
    askForNotifications();
  } else {
    alerts.splice(position, 1);
    if (element) element.classList.remove("on");
  }

  saveProgress();
  // Keep every copy of that bell in step, since the same match can
  // appear on more than one part of the screen.
  syncBells(fixtureId);
}

function syncBells(fixtureId) {
  const on = alerts.includes(fixtureId);
  for (const card of document.querySelectorAll('[data-id="' + fixtureId + '"]')) {
    const bell = card.querySelector(".bell");
    if (bell) bell.classList.toggle("on", on);
  }
}

// Runs on its own timer. Compares the score of every followed match
// against what it saw last time and shouts about anything new.
async function checkForGoals() {
  if (alerts.length === 0) return;

  let matches;
  try {
    matches = await (await fetch("/api/ticker")).json();
  } catch (error) {
    return;
  }

  for (const match of matches) {
    if (!alerts.includes(match.id)) continue;

    const now = (match.hg === null ? 0 : match.hg) + "-" +
                (match.ag === null ? 0 : match.ag);
    const before = lastKnownScores[match.id];

    // Only shout when we have seen this game before and it changed.
    if (before !== undefined && before !== now && notificationsAllowed()) {
      const clock = match.minute !== null ? match.minute + "'" : match.short;
      new Notification("GOAL - " + match.home + " " + now + " " + match.away, {
        body: match.league + "  " + clock,
        tag: "goal-" + match.id,
      });
    }

    lastKnownScores[match.id] = now;
  }
}

setInterval(checkForGoals, 30000);
checkForGoals();


// ---------------------------------------------------------------
// WHICH SCREEN
// ---------------------------------------------------------------
let screen = "home";

function isoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return year + "-" + month + "-" + day;
}

let chosenDate = isoDate(new Date());

// Kickoffs arrive as UTC. Which day a match belongs to depends on
// where the person is standing, so it is worked out here rather
// than by reading the date off the front of the timestamp.
function localDateOf(match) {
  const when = new Date(match.fixture.date);
  return isNaN(when) ? "" : isoDate(when);
}

// The day above a kick-off time. Today is left blank, because the
// time on its own says enough.
function dayLabel(when) {
  if (isNaN(when)) return "";

  const sameDay = function (a, b) {
    return a.getFullYear() === b.getFullYear() &&
           a.getMonth() === b.getMonth() &&
           a.getDate() === b.getDate();
  };

  const now = new Date();
  if (sameDay(when, now)) return "";

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (sameDay(when, tomorrow)) return "Tomorrow";

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (sameDay(when, yesterday)) return "Yesterday";

  return when.toLocaleDateString([], {
    weekday: "short", day: "numeric", month: "short",
  });
}

// Kick-off in the time the person is actually in.
function localTime(when) {
  return isNaN(when) ? "--:--"
    : when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function goTo(name) {
  screen = name;

  // Coming back from a club, league or match page.
  openClubInfo = null;
  document.getElementById("leagueHead").innerHTML = "";
  document.getElementById("matchHead").innerHTML = "";
  document.getElementById("mainHeader").style.display = "block";

  const buttons = {
    favourites: "navFavourites",
    fixtures: "navFixtures",
    home: "navHome",
    xp: "navXp",
    challenges: "navChallenges",
  };

  for (const key of Object.keys(buttons)) {
    document.getElementById(buttons[key]).classList.toggle("on", name === key);
  }

  document.getElementById("dates").style.display = name === "fixtures" ? "flex" : "none";
  document.getElementById("subTabs").style.display = name === "home" ? "flex" : "none";
  document.getElementById("pickerBox").style.display = "none";
  document.getElementById("searchArea").style.display = "none";
  document.getElementById("cogBtn").style.display = name === "home" ? "inline" : "none";

  // The bar carries the app name now, and the bottom bar shows
  // which screen you are on, so there is no title to update.

  refresh();
}

// No logo.png on the server, so put the old bolt back.
const brandLogo = document.getElementById("brandLogo");
if (brandLogo) {
  brandLogo.onerror = function () {
    const bolt = document.createElement("span");
    bolt.className = "brandBolt";
    bolt.innerHTML = "&#9889;";
    this.replaceWith(bolt);
  };
}

document.getElementById("cogBtn").onclick = function () { goTo("settings"); };
document.getElementById("level").onclick = function () { goTo("profile"); };
document.getElementById("navFavourites").onclick = function () { favView = "countries"; goTo("favourites"); };
document.getElementById("navFixtures").onclick = function () { goTo("fixtures"); };
document.getElementById("navHome").onclick = function () { goTo("home"); };

for (const tab of document.querySelectorAll(".subTab")) {
  tab.onclick = function () {
    homeTab = this.getAttribute("data-sub");
    if (screen === "home") {
      refresh();
    } else {
      goTo("home");
    }
  };
}
document.getElementById("navXp").onclick = function () { goTo("xp"); };
document.getElementById("navChallenges").onclick = function () { goTo("challenges"); };


// ---------------------------------------------------------------
// DATE STRIP
// ---------------------------------------------------------------
function drawDates() {
  const strip = document.getElementById("dates");
  strip.innerHTML = "";
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  for (let offset = 0; offset <= 6; offset++) {
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
// MATCH STATE
//
// Every screen needs to know whether a game is coming up, being
// played, or done. The API is not always consistent, so this works
// it out from several clues rather than trusting one field.
// ---------------------------------------------------------------
function stateOf(match) {
  const status = match.fixture.status;

  if (status.elapsed !== null) return "live";
  if (status.short === "HT") return "live";
  if (status.short === "FT" || status.short === "AET" || status.short === "PEN") {
    return "finished";
  }
  if (status.short === "PST" || status.short === "CANC") return "finished";

  // No minute and no clear status, but both scores filled in and
  // kick-off has passed - that is a finished game.
  const hasScores = match.goals.home !== null && match.goals.away !== null;
  const kickoff = new Date(match.fixture.date);
  const started = !isNaN(kickoff) && kickoff.getTime() < Date.now();

  if (hasScores && started) return "finished";
  return "upcoming";
}

// The minute a game is at. Uses the API's own figure when there is
// one; otherwise works it out from the kick-off time, allowing
// fifteen minutes for the interval.
function minuteOf(match) {
  if (match.fixture.status.elapsed !== null) {
    return match.fixture.status.elapsed;
  }
  if (match.fixture.status.short === "HT") return 45;

  const kickoff = new Date(match.fixture.date);
  if (isNaN(kickoff)) return null;

  const gone = Math.floor((Date.now() - kickoff.getTime()) / 60000);
  if (gone < 0) return null;

  // Before the break, the clock and real time match.
  if (gone <= 45) return gone;
  // During the interval.
  if (gone <= 60) return 45;
  // After it, take the fifteen minutes back off.
  const playing = gone - 15;
  return playing > 95 ? 90 : playing;
}

// True when the estimate came from the clock rather than the API,
// so the screen can mark it as approximate.
function minuteIsEstimated(match) {
  return match.fixture.status.elapsed === null &&
         match.fixture.status.short !== "HT";
}

// Live first, earliest minute at the top. Then games to come,
// then today's results.
function matchSort(a, b) {
  const order = { live: 0, upcoming: 1, finished: 2 };
  const sa = stateOf(a);
  const sb = stateOf(b);

  if (order[sa] !== order[sb]) return order[sa] - order[sb];

  if (sa === "live") {
    const ma = minuteOf(a);
    const mb = minuteOf(b);
    return (ma === null ? 45 : ma) - (mb === null ? 45 : mb);
  }

  return new Date(a.fixture.date) - new Date(b.fixture.date);
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

    // A game being played always shows its minute, whatever screen
    // we are on. Only games yet to start show a kick-off time.
    const state = stateOf(match);
    let when;
    let whenClass = "when";

    if (state === "live") {
      const minute = minuteOf(match);
      if (match.fixture.status.short === "HT") {
        when = "HT";
      } else if (minute === null) {
        when = "LIVE";
      } else {
        // A tilde marks a minute we worked out ourselves.
        when = (minuteIsEstimated(match) ? "~" : "") + minute + "'";
      }
    } else if (state === "finished") {
      when = "FT";
      whenClass = "when grey";
    } else {
      when = localTime(new Date(match.fixture.date));
      whenClass = "when grey";
    }

    // The day sits above the time on anything that is not being
    // played right now, so a season list reads properly.
    const kickoff = new Date(match.fixture.date);
    const dayText = state === "live" ? "" : dayLabel(kickoff);

    const homeGoals = match.goals.home === null ? "-" : match.goals.home;
    const awayGoals = match.goals.away === null ? "-" : match.goals.away;
    const isOn = alerts.includes(match.fixture.id);

    const row = document.createElement("div");
    row.className = "match";
    row.setAttribute("data-id", match.fixture.id);
    row.innerHTML =
      '<div class="' + whenClass + '">' +
        (dayText ? '<span class="whenDate">' + dayText + '</span>' : '') +
        '<span class="whenMain">' + when + '</span>' +
      '</div>' +
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
      '<div class="bell' + (isOn ? ' on' : '') + '">&#9733;</div>';

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
// FAVOURITES
//
// Two lists: leagues the person follows, and clubs they follow.
// Both are saved on the device and feed the Home screen.
// ---------------------------------------------------------------
let favLeagues = JSON.parse(localStorage.getItem("favLeagues") || "[]");
let favTeams = JSON.parse(localStorage.getItem("favTeams") || "[]");

function saveFavourites() {
  if (typeof pushProgress === "function") pushProgress();
  localStorage.setItem("favLeagues", JSON.stringify(favLeagues));
  localStorage.setItem("favTeams", JSON.stringify(favTeams));
}

function isFavLeague(id) {
  return favLeagues.some(function (l) { return l.id === id; });
}

function isFavTeam(id) {
  return favTeams.some(function (t) { return t.id === id; });
}

function toggleFavLeague(league) {
  if (isFavLeague(league.id)) {
    favLeagues = favLeagues.filter(function (l) { return l.id !== league.id; });
  } else {
    favLeagues.push({
      id: league.id, name: league.name,
      country: league.country, logo: league.logo,
    });
  }
  saveFavourites();
}

function toggleFavTeam(team, league) {
  if (isFavTeam(team.id)) {
    favTeams = favTeams.filter(function (t) { return t.id !== team.id; });
  } else {
    favTeams.push({
      id: team.id, name: team.name, logo: team.logo,
      leagueId: league ? league.id : null,
      leagueName: league ? league.name : "",
    });
  }
  saveFavourites();
}


// ---------------------------------------------------------------
// THE LIVE TICKER
//
// Cycles through every match being played in the world, one at a
// time, across the top of the screen. Uses the same cached data
// the scores list uses, so it costs no extra requests.
// ---------------------------------------------------------------
let tickerMatches = [];
let tickerAt = 0;

function drawTickerLine() {
  const inner = document.getElementById("tickerInner");

  if (tickerMatches.length === 0) {
    inner.innerHTML = '<span class="tickerQuiet">No matches being played</span>';
    return;
  }

  // Wrap around to the start when we reach the end.
  if (tickerAt >= tickerMatches.length) tickerAt = 0;
  const match = tickerMatches[tickerAt];

  const clock = match.minute !== null ? match.minute + "'" : match.short;
  const hg = match.hg === null ? "-" : match.hg;
  const ag = match.ag === null ? "-" : match.ag;

  inner.innerHTML =
    '<div class="tickerLine">' +
      (match.homeLogo ? '<img src="' + match.homeLogo + '" alt="">' : '') +
      '<span class="nm">' + match.home + '</span>' +
      '<span class="sc">' + hg + '-' + ag + '</span>' +
      '<span class="nm">' + match.away + '</span>' +
      (match.awayLogo ? '<img src="' + match.awayLogo + '" alt="">' : '') +
      '<span class="mn">' + clock + '</span>' +
    '</div>';
}

// Fade out, swap the match, fade back in.
function advanceTicker() {
  if (tickerMatches.length < 2) return;

  const inner = document.getElementById("tickerInner");
  inner.classList.add("fade");

  setTimeout(function () {
    tickerAt = tickerAt + 1;
    drawTickerLine();
    inner.classList.remove("fade");
  }, 350);
}

async function loadTicker() {
  try {
    const response = await fetch("/api/ticker");
    const fresh = await response.json();

    // Keep our place in the list if the same games are still on.
    const wasShowing = tickerMatches[tickerAt] ? tickerMatches[tickerAt].id : null;
    tickerMatches = fresh;

    if (wasShowing !== null) {
      const stillThere = fresh.findIndex(function (m) { return m.id === wasShowing; });
      tickerAt = stillThere === -1 ? 0 : stillThere;
    }
  } catch (error) {
    // Leave whatever was there rather than blanking it.
    return;
  }
  drawTickerLine();
}

loadTicker();
setInterval(advanceTicker, 4000);   // next match every four seconds
setInterval(loadTicker, 60000);     // refresh the list every minute


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
  earn("table");
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
// THE FAVOURITES SCREEN
//
// Drills down: countries, then that country's leagues, then that
// league's clubs. Stars on the leagues and the clubs.
// ---------------------------------------------------------------
let favView = "countries";     // countries | leagues | teams
let favCountry = null;
let favLeagueChosen = null;
let favTeamList = [];

function drawCrumbs() {
  const bits = ['<span class="crumb" data-go="countries">Countries</span>'];
  if (favCountry) {
    bits.push("&rsaquo;");
    bits.push('<span class="crumb" data-go="leagues">' + favCountry + '</span>');
  }
  if (favLeagueChosen) {
    bits.push("&rsaquo;");
    bits.push('<span>' + favLeagueChosen.name + '</span>');
  }

  const bar = document.createElement("div");
  bar.className = "crumbs";
  bar.innerHTML = bits.join(" ");

  for (const crumb of bar.querySelectorAll(".crumb")) {
    crumb.onclick = function () {
      const target = this.getAttribute("data-go");
      if (target === "countries") {
        favView = "countries";
        favCountry = null;
        favLeagueChosen = null;
      } else {
        favView = "leagues";
        favLeagueChosen = null;
      }
      refresh();
    };
  }
  return bar;
}

function drawFavCountries() {
  const list = document.getElementById("list");
  list.innerHTML = "";
  list.appendChild(drawCrumbs());

  if (allLeagues === null || allLeagues.length === 0) {
    list.innerHTML += '<div class="empty">Loading countries...</div>';
    return;
  }

  const grouped = countriesInOrder();

  for (const country of grouped.order) {
    const leagues = grouped.byCountry[country];
    const row = document.createElement("div");
    row.className = "pickRow";
    row.innerHTML =
      (leagues[0].logo ? '<img src="' + leagues[0].logo + '" alt="">' : '<img alt="">') +
      '<span class="pname">' + country + '</span>' +
      '<span class="chev">&#9654;</span>';
    row.onclick = function () {
      favCountry = country;
      favView = "leagues";
      refresh();
    };
    list.appendChild(row);
  }
}

function drawFavLeagues() {
  const list = document.getElementById("list");
  list.innerHTML = "";
  list.appendChild(drawCrumbs());

  const grouped = countriesInOrder();
  const leagues = grouped.byCountry[favCountry] || [];

  for (const league of leagues) {
    const starred = isFavLeague(league.id);

    const row = document.createElement("div");
    row.className = "pickRow";
    row.innerHTML =
      (league.logo ? '<img src="' + league.logo + '" alt="">' : '<img alt="">') +
      '<span class="pname">' + league.name + '</span>' +
      '<span class="star' + (starred ? " on" : "") + '">&#9733;</span>' +
      '<span class="chev">&#9654;</span>';

    // The star saves the league. Tapping anywhere else opens its clubs.
    row.querySelector(".star").onclick = function (event) {
      event.stopPropagation();
      toggleFavLeague(league);
      refresh();
    };
    row.onclick = function () {
      favLeagueChosen = league;
      favView = "teams";
      refresh();
    };
    list.appendChild(row);
  }

  if (leagues.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No leagues here.";
    list.appendChild(empty);
  }
}

function drawFavTeams() {
  const list = document.getElementById("list");
  list.innerHTML = "";
  list.appendChild(drawCrumbs());

  if (favTeamList.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML = "No clubs listed for this league.";
    list.appendChild(empty);
    return;
  }

  const sorted = favTeamList.slice().sort(function (a, b) {
    return a.name.localeCompare(b.name);
  });

  for (const team of sorted) {
    const starred = isFavTeam(team.id);

    const row = document.createElement("div");
    row.className = "pickRow";
    row.innerHTML =
      '<img src="' + team.logo + '" alt="">' +
      '<span class="pname">' + team.name + '</span>' +
      '<span class="star' + (starred ? " on" : "") + '">&#9733;</span>';

    row.onclick = function () {
      toggleFavTeam(team, favLeagueChosen);
      refresh();
    };
    list.appendChild(row);
  }
}


// ---------------------------------------------------------------
// THE HOME SCREEN
//
// Clubs down the left, leagues down the right. Tables underneath.
// With nothing followed, it fills up with games from the big
// countries instead of sitting empty.
// ---------------------------------------------------------------
function miniMatchHtml(match) {
  const state = stateOf(match);
  let when;

  if (state === "live") {
    const minute = minuteOf(match);
    if (match.fixture.status.short === "HT") {
      when = "Half time";
    } else if (minute === null) {
      when = "LIVE";
    } else {
      when = (minuteIsEstimated(match) ? "~" : "") + minute + "' LIVE";
    }
  } else if (state === "finished") {
    when = "Full time";
  } else {
    const kickoff = new Date(match.fixture.date);
    when = isNaN(kickoff) ? "" :
      kickoff.toLocaleDateString([], { weekday: "short", day: "numeric" }) + " " +
      kickoff.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  const live = state === "live";
  const isOn = alerts.includes(match.fixture.id);

  return '<div class="miniMatch" data-id="' + match.fixture.id + '">' +
    '<div class="miniTop">' +
      '<span class="miniWhen' + (live ? " liveNow" : "") + '">' + when + '</span>' +
      '<span class="bell miniBell' + (isOn ? " on" : "") + '">&#9733;</span>' +
    '</div>' +
    '<div class="miniTeam"><img src="' + match.teams.home.logo + '" alt="">' +
      '<span>' + match.teams.home.name + '</span></div>' +
    '<div class="miniTeam"><img src="' + match.teams.away.logo + '" alt="">' +
      '<span>' + match.teams.away.name + '</span></div>' +
  '</div>';
}

// The mini cards are built as plain text, so their bells are
// wired up afterwards.
function wireMiniBells() {
  for (const card of document.querySelectorAll(".miniMatch")) {
    const id = Number(card.getAttribute("data-id"));
    const bell = card.querySelector(".miniBell");
    if (!bell) continue;
    bell.onclick = function (event) {
      event.stopPropagation();
      toggleAlert(id, bell);
    };
  }
}

// ---------------------------------------------------------------
// THE HOME SCREEN
//
// Three views under the bar: what is being played, the papers, and
// whatever the person has starred.
// ---------------------------------------------------------------
let homeTab = "live";

async function drawHome() {
  const list = document.getElementById("list");
  const updated = document.getElementById("updated");
  list.innerHTML = "";
  updated.textContent = "";

  // Keep the sub-header in step, since Home can be reached from
  // several places.
  for (const tab of document.querySelectorAll(".subTab")) {
    tab.classList.toggle("on", tab.getAttribute("data-sub") === homeTab);
  }

  if (homeTab === "news") { await drawHomeNews(list); return; }
  if (homeTab === "following") { await drawHomeFollowing(list); return; }
  await drawHomeLive(list);
}

// ---- Live: your clubs and leagues, then whatever is on ----
async function drawHomeLive(list) {

  // Five slots each. Badges only, no names, so nothing collides.
  const slots = function (items, kind) {
    let html = '<div class="slotRow">';
    for (let i = 0; i < 5; i++) {
      const item = items[i];
      if (item) {
        const short = item.name.length > 11
          ? item.name.slice(0, 10) + "." : item.name;
        html += '<div class="slot" data-kind="' + kind + '" data-id="' + item.id + '">' +
          '<img src="' + item.logo + '" alt="">' +
          '<span class="slotName">' + short + '</span>' +
        '</div>';
      } else {
        html += '<div class="slot slotEmpty" data-kind="add">+</div>';
      }
    }
    return html + '</div>';
  };

  const board = document.createElement("div");
  board.className = "board";
  board.innerHTML =
    '<div class="boardHead">Your clubs</div>' +
    slots(favTeams.slice(0, 5), "club") +
    '<div class="boardHead">Your leagues</div>' +
    slots(favLeagues.slice(0, 5), "league");
  list.appendChild(board);

  for (const slot of board.querySelectorAll(".slot")) {
    const kind = slot.getAttribute("data-kind");
    const id = Number(slot.getAttribute("data-id"));

    slot.onclick = function () {
      if (kind === "add") {
        favView = "countries";
        goTo("favourites");
        return;
      }
      if (kind === "club") {
        const club = favTeams.find(function (t) { return t.id === id; });
        if (club) openClub(club);
        return;
      }
      // A league goes straight to its table.
      const league = favLeagues.find(function (l) { return l.id === id; });
      if (league) {
        openLeague(league);
        leagueTab = "table";
        refresh();
      }
    };
  }

  if (favTeams.length === 0 && favLeagues.length === 0) {
    const hint = document.createElement("div");
    hint.className = "empty";
    hint.innerHTML =
      "Tap a plus to add your clubs and leagues.<br><br>" +
      "Clubs open their fixtures, table and stats.<br>" +
      "Leagues go straight to the table.";
    list.appendChild(hint);
  }

  // ---- Live games, three across ----
  let live = [];
  try {
    live = await (await fetch("/api/ticker")).json();
  } catch (error) {
    live = [];
  }

  if (live.length > 0) {
    // Followed leagues first, then everyone else.
    const mine = favLeagues.map(function (l) { return l.id; });
    live.sort(function (a, b) {
      const aMine = mine.includes(a.leagueId) ? 0 : 1;
      const bMine = mine.includes(b.leagueId) ? 0 : 1;
      return aMine - bMine;
    });

    const heading = document.createElement("div");
    heading.className = "boardHead";
    heading.innerHTML = 'Live now <span class="liveCount">' + live.length + '</span>';
    list.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "liveGrid";
    grid.innerHTML = live.slice(0, 15).map(function (m) {
      const clock = m.minute !== null ? m.minute + "'" : (m.short || "LIVE");
      return '<div class="liveCard" data-id="' + m.id + '">' +
        '<div class="lcTop">' + clock + '</div>' +
        '<div class="lcSide">' +
          '<img src="' + m.homeLogo + '" alt="">' +
          '<span class="lcTag">' + shortName(m.home) + '</span>' +
          '<span class="lcScore">' + (m.hg === null ? "-" : m.hg) + '</span>' +
        '</div>' +
        '<div class="lcSide">' +
          '<img src="' + m.awayLogo + '" alt="">' +
          '<span class="lcTag">' + shortName(m.away) + '</span>' +
          '<span class="lcScore">' + (m.ag === null ? "-" : m.ag) + '</span>' +
        '</div>' +
      '</div>';
    }).join("");
    list.appendChild(grid);

    for (const card of grid.querySelectorAll(".liveCard")) {
      const id = Number(card.getAttribute("data-id"));
      card.onclick = function () { openMatch(id); };
    }
  }

}

// ---- Following: your clubs' next games, then starred matches ----
async function drawHomeFollowing(list) {
  // ---- Next two games for each followed club ----
  if (favTeams.length > 0) {
    const heading = document.createElement("div");
    heading.className = "boardHead";
    heading.textContent = "Coming up";
    list.appendChild(heading);

    const holder = document.createElement("div");
    list.appendChild(holder);

    for (const club of favTeams.slice(0, 5)) {
      let season = [];
      try {
        season = await (await fetch("/api/team-season?team=" + club.id)).json();
      } catch (error) {
        continue;
      }

      // Anything not finished yet, earliest first, take two.
      const next = season
        .filter(function (m) { return stateOf(m) !== "finished"; })
        .sort(function (a, b) {
          return new Date(a.fixture.date) - new Date(b.fixture.date);
        })
        .slice(0, 2);

      if (next.length === 0) continue;

      for (const match of next) {
        const kickoff = new Date(match.fixture.date);
        const when = isNaN(kickoff) ? "" :
          kickoff.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" }) +
          " " + kickoff.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

        const row = document.createElement("div");
        row.className = "upRow";
        row.innerHTML =
          '<img class="upCrest" src="' + club.logo + '" alt="">' +
          '<span class="upTeams">' +
            match.teams.home.name + ' v ' + match.teams.away.name +
          '</span>' +
          '<span class="upWhen">' + when + '</span>';
        row.onclick = function () { openMatch(match.fixture.id); };
        holder.appendChild(row);
      }
    }
  }

  // ---- Matches the person has starred ----
  if (alerts.length === 0) {
    const none = document.createElement("div");
    none.className = "empty";
    none.innerHTML =
      "No matches followed yet.<br><br>" +
      "Tap the star on any match and it will sit here, " +
      "with its score kept up to date.";
    list.appendChild(none);
  } else {
    const heading = document.createElement("div");
    heading.className = "boardHead";
    heading.innerHTML =
      'Starred matches <span class="liveCount">' + alerts.length + '</span>';
    list.appendChild(heading);

    const holder = document.createElement("div");
    list.appendChild(holder);

    // Anything already being played costs nothing to reuse.
    let live = [];
    try {
      live = await (await fetch("/api/ticker")).json();
    } catch (error) {
      live = [];
    }

    const known = {};
    for (const m of live) known[m.id] = m;

    let shown = 0;

    for (const id of alerts.slice(0, 8)) {
      let card = null;

      if (known[id]) {
        const m = known[id];
        card = {
          home: m.home, away: m.away,
          homeLogo: m.homeLogo, awayLogo: m.awayLogo,
          hg: m.hg, ag: m.ag,
          when: m.minute !== null ? m.minute + "'" : (m.short || "LIVE"),
          live: true,
        };
      } else {
        // Not live, so ask for it. Cached on the server for a minute.
        try {
          const match = await (await fetch("/api/match?id=" + id + "&light=1")).json();
          if (!match) continue;
          const state = stateOf(match);
          const kickoff = new Date(match.fixture.date);
          card = {
            home: match.teams.home.name, away: match.teams.away.name,
            homeLogo: match.teams.home.logo, awayLogo: match.teams.away.logo,
            hg: match.goals.home, ag: match.goals.away,
            when: state === "finished" ? "FT"
              : (isNaN(kickoff) ? "" :
                 kickoff.toLocaleDateString([], { weekday: "short", day: "numeric" }) +
                 " " + kickoff.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })),
            live: state === "live",
          };
        } catch (error) {
          continue;
        }
      }

      const row = document.createElement("div");
      row.className = "followRow";
      row.innerHTML =
        '<span class="fWhen' + (card.live ? " liveNow" : "") + '">' + card.when + '</span>' +
        '<span class="fTeams">' +
          '<span class="fLine">' +
            '<img src="' + card.homeLogo + '" alt="">' +
            '<span class="fName">' + card.home + '</span>' +
            '<span class="fScore">' + (card.hg === null ? "-" : card.hg) + '</span>' +
          '</span>' +
          '<span class="fLine">' +
            '<img src="' + card.awayLogo + '" alt="">' +
            '<span class="fName">' + card.away + '</span>' +
            '<span class="fScore">' + (card.ag === null ? "-" : card.ag) + '</span>' +
          '</span>' +
        '</span>' +
        '<span class="bell on">&#9733;</span>';

      row.onclick = function () { openMatch(id); };

      // The star comes off here as well as on the match itself.
      const star = row.querySelector(".bell");
      star.onclick = function (event) {
        event.stopPropagation();
        toggleAlert(id, star);
        drawHome();
      };

      holder.appendChild(row);
      shown++;
    }

    if (shown === 0) {
      const none = document.createElement("div");
      none.className = "colEmpty";
      none.textContent = "Could not load your followed games.";
      holder.appendChild(none);
    }
  }
}

// ---- News: headlines, linking out to whoever wrote them ----
async function drawHomeNews(list) {
  const loading = document.createElement("div");
  loading.className = "empty";
  loading.textContent = "Loading the headlines...";
  list.appendChild(loading);

  let items = [];
  try {
    items = await (await fetch("/api/news")).json();
  } catch (error) {
    items = [];
  }

  list.innerHTML = "";

  if (!Array.isArray(items) || items.length === 0) {
    list.innerHTML =
      '<div class="empty">No headlines right now.<br><br>' +
      'Try again in a few minutes.</div>';
    return;
  }

  // "14 minutes ago" reads better than a timestamp on a news list.
  const howLongAgo = function (iso) {
    if (!iso) return "";
    const then = new Date(iso);
    if (isNaN(then)) return "";

    const minutes = Math.round((Date.now() - then.getTime()) / 60000);
    if (minutes < 1) return "just now";
    if (minutes < 60) return minutes + " min ago";

    const hours = Math.round(minutes / 60);
    if (hours < 24) return hours + (hours === 1 ? " hour ago" : " hours ago");

    const days = Math.round(hours / 24);
    return days + (days === 1 ? " day ago" : " days ago");
  };

  const safe = function (text) {
    return String(text || "").replace(/[<>&"]/g, function (character) {
      return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[character];
    });
  };

  for (const item of items) {
    const row = document.createElement("a");
    row.className = "newsRow";
    row.href = item.link;
    row.target = "_blank";
    row.rel = "noopener noreferrer";
    row.innerHTML =
      (item.image
        ? '<img class="newsThumb" src="' + safe(item.image) + '" alt="">'
        : '') +
      '<span class="newsBody">' +
        '<span class="newsTitle">' + safe(item.title) + '</span>' +
        '<span class="newsMeta">' + safe(item.source) +
          (howLongAgo(item.at) ? ' &middot; ' + howLongAgo(item.at) : '') +
        '</span>' +
      '</span>';
    list.appendChild(row);
  }

  const note = document.createElement("div");
  note.className = "newsNote";
  note.textContent =
    "Headlines from their own feeds. Tapping one opens the full " +
    "story on the site that wrote it.";
  list.appendChild(note);
}



// Makes a three letter tag out of a club name, the way the
// scoreboards do it. "Real Madrid" becomes RMA, "Celtic" CEL.
const NAME_NOISE = [
  "fc", "sc", "cf", "afc", "ac", "as", "sv", "cd", "ca", "sk",
  "fk", "bk", "if", "sp", "ud", "rc", "us", "ss", "club", "de",
];

function shortName(name) {
  const words = String(name || "")
    .replace(/[.]/g, "")
    .split(/\s+/)
    .filter(function (word) {
      return word && !NAME_NOISE.includes(word.toLowerCase());
    });

  if (words.length === 0) return "???";
  if (words.length === 1) return words[0].slice(0, 3).toUpperCase();

  // First letter of the first word, first two of the second.
  return (words[0][0] + words[1].slice(0, 2)).toUpperCase();
}


// ---------------------------------------------------------------
// THE DAILY SPIN
//
// One free spin a day. Rewards are deliberately modest so nobody
// can build up anything worth much.
// ---------------------------------------------------------------
const SPIN_PRIZES = [
  { chance: 34, kind: "xp",     amount: 25,  text: "+25 XP" },
  { chance: 24, kind: "xp",     amount: 50,  text: "+50 XP" },
  { chance: 16, kind: "coins",  amount: 15,  text: "+15 coins" },
  { chance: 12, kind: "boost",  amount: 2, hours: 1, text: "Double XP for an hour" },
  { chance: 8,  kind: "xp",     amount: 100, text: "+100 XP" },
  { chance: 4,  kind: "boost",  amount: 2, hours: 24, text: "Double XP for a day" },
  { chance: 2,  kind: "shield", amount: 1,  text: "Relegation shield" },
];

function pickPrize() {
  const total = SPIN_PRIZES.reduce(function (sum, p) { return sum + p.chance; }, 0);
  let roll = Math.random() * total;
  for (const prize of SPIN_PRIZES) {
    roll -= prize.chance;
    if (roll <= 0) return prize;
  }
  return SPIN_PRIZES[0];
}

function spinUsedToday() {
  return localStorage.getItem("lastSpin") === todayKey;
}

function takeSpin() {
  const prize = pickPrize();

  if (prize.kind === "xp") {
    xp = xp + prize.amount;
  } else if (prize.kind === "coins") {
    coins = coins + prize.amount;
  } else if (prize.kind === "boost") {
    boostSize = prize.amount;
    boostUntil = Date.now() + prize.hours * 3600000;
  } else if (prize.kind === "shield") {
    // Only one at a time, so they cannot be stockpiled.
    shields = Math.min(1, shields + 1);
  }

  localStorage.setItem("lastSpin", todayKey);
  tally("spin");
  saveXpState();
  drawProgress();
  return prize;
}


// ---------------------------------------------------------------
// THE XP LEAGUE SCREEN
// ---------------------------------------------------------------
function drawXpScreen() {
  const list = document.getElementById("list");
  list.innerHTML = "";

  const level = levelNow();
  const division = divisionFor(level);
  const intoLevel = xp % 1000;

  // ---- Who you are ----
  // ---- Account ----
  const account = document.createElement("div");
  account.className = "acctBox";

  if (signedIn()) {
    account.innerHTML =
      '<div class="acctIn">' +
        '<span class="acctTick">&#10003;</span>' +
        '<span class="acctWho">' + authEmail + '</span>' +
        '<button class="acctOut" id="signOutBtn">Sign out</button>' +
      '</div>' +
      '<div class="acctNote">Progress saved to your account.</div>';
  } else {
    account.innerHTML =
      '<div class="acctHead">Save your progress</div>' +
      '<div class="acctNote">Right now everything is on this device only. ' +
        'Sign in and it follows you to any phone.</div>' +
      '<input class="acctField" id="acctEmail" type="email" ' +
        'placeholder="Email" autocomplete="email">' +
      '<input class="acctField" id="acctPass" type="password" ' +
        'placeholder="Password, 8 characters or more" autocomplete="current-password">' +
      '<div class="acctButtons">' +
        '<button class="acctBtn" id="signInBtn">Sign in</button>' +
        '<button class="acctBtn ghost" id="signUpBtn">Create account</button>' +
      '</div>' +
      '<div class="acctMsg" id="acctMsg"></div>';
  }
  list.appendChild(account);

  const outButton = document.getElementById("signOutBtn");
  if (outButton) {
    outButton.onclick = function () {
      signOut();
      drawXpScreen();
    };
  }

  const runAuth = async function (mode) {
    const email = document.getElementById("acctEmail").value.trim();
    const password = document.getElementById("acctPass").value;
    const message = document.getElementById("acctMsg");

    message.className = "acctMsg";
    message.textContent = "Just a moment...";

    let result;
    try {
      result = await doAuth(mode, email, password);
    } catch (error) {
      message.className = "acctMsg bad";
      message.textContent = "Could not reach the server.";
      return;
    }

    if (result.error) {
      message.className = "acctMsg bad";
      message.textContent = result.error;
      return;
    }
    if (result.needsConfirming) {
      message.className = "acctMsg";
      message.textContent = "Check your email to confirm, then sign in.";
      return;
    }
    drawXpScreen();
  };

  const inButton = document.getElementById("signInBtn");
  if (inButton) inButton.onclick = function () { runAuth("signin"); };
  const upButton = document.getElementById("signUpBtn");
  if (upButton) upButton.onclick = function () { runAuth("signup"); };

  const card = document.createElement("div");
  card.className = "profCard";
  card.innerHTML =
    '<div class="profTop">' +
      '<div class="profRing"><span>' + level + '</span></div>' +
      '<div class="profWho">' +
        '<div class="profDiv">' + division.name + '</div>' +
        '<div class="profSub">Level ' + level + ' &middot; ' + xp.toLocaleString() + ' XP total</div>' +
      '</div>' +
    '</div>' +
    '<div class="profBar"><div class="profFill" style="width:' + (intoLevel / 10) + '%"></div></div>' +
    '<div class="profBarText">' + intoLevel + ' / 1000 to level ' + (level + 1) + '</div>' +
    '<div class="profStats">' +
      '<div><b>' + streak + '</b><span>day streak</span></div>' +
      '<div><b>' + coins + '</b><span>coins</span></div>' +
      '<div><b>' + shields + '</b><span>shields</span></div>' +
    '</div>' +
    (boostActive()
      ? '<div class="boostFlag">' + boostSize + '\u00d7 XP active</div>' : "");
  list.appendChild(card);

  // ---- Daily spin ----
  // A simple eight-segment wheel, drawn rather than an image.
  const wheelSvg = (function () {
    let wedges = "";
    for (let i = 0; i < 8; i++) {
      const a1 = (i * 45 - 90) * Math.PI / 180;
      const a2 = ((i + 1) * 45 - 90) * Math.PI / 180;
      const x1 = 50 + 44 * Math.cos(a1);
      const y1 = 50 + 44 * Math.sin(a1);
      const x2 = 50 + 44 * Math.cos(a2);
      const y2 = 50 + 44 * Math.sin(a2);
      wedges += '<path d="M50 50 L' + x1.toFixed(1) + ' ' + y1.toFixed(1) +
        ' A44 44 0 0 1 ' + x2.toFixed(1) + ' ' + y2.toFixed(1) + ' Z" fill="' +
        (i % 2 ? "#1E6FD9" : "#DCE9FB") + '"/>';
    }
    return '<svg class="spinWheel" viewBox="0 0 100 100" role="img">' +
      '<title>Daily spin wheel</title>' + wedges +
      '<circle cx="50" cy="50" r="44" fill="none" stroke="#0B1E3D" stroke-width="3"/>' +
      '<circle cx="50" cy="50" r="7" fill="#fff" stroke="#0B1E3D" stroke-width="2.5"/>' +
      '<path d="M50 2 L45 12 L55 12 Z" fill="#0B1E3D"/>' +
    '</svg>';
  })();

  const spinBox = document.createElement("div");
  spinBox.className = "spinBox";
  spinBox.innerHTML = wheelSvg + (spinUsedToday()
    ? '<div class="spinRight">' +
        '<div class="spinHead">Daily spin</div>' +
        '<div class="spinDone">Come back tomorrow for another spin.</div>' +
        '<button class="spinBtn" disabled style="margin-top:10px">Spun today &#10003;</button>' +
      '</div>'
    : '<div class="spinRight">' +
        '<div class="spinHead">Daily spin</div>' +
        '<div class="spinSub">One free spin every day.</div>' +
        '<button class="spinBtn" id="spinBtn">Spin</button>' +
      '</div>');
  list.appendChild(spinBox);

  const button = document.getElementById("spinBtn");
  if (button) {
    button.onclick = function () {
      button.disabled = true;
      button.textContent = "...";

      // A brief flicker through the prizes before it settles.
      let ticks = 0;
      const rolling = setInterval(function () {
        button.textContent = SPIN_PRIZES[ticks % SPIN_PRIZES.length].text;
        ticks++;
        if (ticks > 12) {
          clearInterval(rolling);
          const prize = takeSpin();
          spinBox.innerHTML = wheelSvg +
            '<div class="spinRight">' +
              '<div class="spinHead">Daily spin</div>' +
              '<div class="spinWon">' + prize.text + '</div>' +
              '<div class="spinDone">Come back tomorrow.</div>' +
            '</div>';
        }
      }, 90);
    };
  }

  // ---- How to earn ----
  const earnBox = document.createElement("div");
  earnBox.className = "listBox";
  let earnRows = '<div class="boxHead">Earning XP today</div>';
  for (const key of Object.keys(EARNINGS)) {
    const rule = EARNINGS[key];
    const used = dailyCounts[key] || 0;
    const done = rule.once && used >= 1;
    const icons = {
      daily: "&#128241;", match: "&#9917;", club: "&#128085;",
      table: "&#9776;", streak: "&#128197;",
    };
    earnRows +=
      '<div class="earnRow' + (done ? " earnDone" : "") + '">' +
        '<span class="earnIcon">' + (icons[key] || "&#9917;") + '</span>' +
        '<span class="earnLabel">' + rule.label + '</span>' +
        '<span class="earnCap">' +
          (used > 0 ? used + " today" : "") +
        '</span>' +
        '<span class="earnXp">+' + rule.xp + '</span>' +
      '</div>';
  }
  earnBox.innerHTML = earnRows;
  list.appendChild(earnBox);

  // ---- This week's league ----
  if (signedIn()) {
    const leagueBox = document.createElement("div");
    leagueBox.className = "listBox";
    leagueBox.innerHTML = '<div class="boxHead">This week</div>' +
      '<div class="colEmpty">Loading your league...</div>';
    list.appendChild(leagueBox);

    (async function () {
      let data;
      try {
        const response = await fetch("/api/league", {
          headers: { "Authorization": "Bearer " + authToken },
        });
        data = await response.json();
      } catch (error) {
        leagueBox.innerHTML = '<div class="boxHead">This week</div>' +
          '<div class="colEmpty">Could not load the league.</div>';
        return;
      }

      if (data.error) {
        leagueBox.innerHTML = '<div class="boxHead">This week</div>' +
          '<div class="colEmpty">' + data.error + '</div>';
        return;
      }

      const divName = DIVISIONS[Math.max(0, data.division - 1)].name;
      const ends = new Date(data.weekEnds);
      const hoursLeft = Math.max(0, Math.round((ends - Date.now()) / 3600000));
      const timeLeft = hoursLeft > 48
        ? Math.round(hoursLeft / 24) + " days left"
        : hoursLeft + " hours left";

      let html =
        '<div class="boxHead">' + divName + ' division ' +
          '<span class="leagueTime">' + timeLeft + '</span>' +
        '</div>';

      // Tell them what happened last week, once.
      if (data.lastResult && data.lastResult.moved !== "stayed") {
        const up = data.lastResult.moved === "promoted";
        html += '<div class="movedBox ' + (up ? "up" : "down") + '">' +
          (up ? "Promoted" : "Relegated") + ' &middot; finished ' +
          data.lastResult.position + ' of ' + data.lastResult.outOf +
          ' with ' + data.lastResult.earned + ' XP' +
        '</div>';
      }

      if (data.table.length <= 1) {
        html += '<div class="colEmpty">You are the first one here. ' +
          'More people will join this group as they sign up.</div>';
      }

      for (const row of data.table) {
        const zone = row.position <= data.promoteAt ? "up"
          : (row.position > data.table.length - data.relegateAt &&
             data.table.length >= 8 ? "down" : "");

        html +=
          '<div class="lgRow ' + zone + (row.you ? " lgYou" : "") + '">' +
            '<span class="lgPos">' + row.position + '</span>' +
            '<span class="lgAvatar">' +
              (row.name ? row.name.slice(0, 1).toUpperCase() : "?") +
            '</span>' +
            '<span class="lgName">' + row.name + (row.you ? " (you)" : "") + '</span>' +
            '<span class="lgXp">' + row.earned.toLocaleString() + '</span>' +
          '</div>';
      }

      html += '<div class="lgKey">' +
        '<span><i class="upDot"></i>Promotion</span>' +
        '<span><i class="downDot"></i>Relegation</span>' +
      '</div>';

      // Let them choose the name others see.
      html += '<div class="nameRow">' +
        '<input class="nameField" id="lgName" maxlength="18" placeholder="Your name in the league" value="' +
          (data.name || "") + '">' +
        '<button class="nameBtn" id="lgNameBtn">Save</button>' +
      '</div>';

      leagueBox.innerHTML = html;

      document.getElementById("lgNameBtn").onclick = async function () {
        const name = document.getElementById("lgName").value.trim();
        if (!name) return;
        await fetch("/api/league", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + authToken,
          },
          body: JSON.stringify({ name: name }),
        });
        drawXpScreen();
      };
    })();
  }

  // ---- The ladder ----
  const ladder = document.createElement("div");
  ladder.className = "listBox";
  let rungs = '<div class="boxHead">Divisions</div>';

  for (let i = DIVISIONS.length - 1; i >= 0; i--) {
    const step = DIVISIONS[i];
    const here = step.name === division.name;
    const reached = level >= step.from;
    rungs +=
      '<div class="rung' + (here ? " rungNow" : "") + (reached ? "" : " rungLocked") + '">' +
        '<span class="rungNum">' + (i + 1) + '</span>' +
        '<span class="rungName">' + step.name + '</span>' +
        '<span class="rungReq">' + (step.from === 0 ? "Start" : "Level " + step.from) + '</span>' +
      '</div>';
  }
  ladder.innerHTML = rungs;
  list.appendChild(ladder);

  // ---- Honest note about what is not built ----
  const note = document.createElement("div");
  note.className = "extras";
  note.innerHTML =
    "Weekly leagues, promotion and the cup need accounts, so they " +
    "arrive once sign-in is added. Your XP, streak and shields are " +
    "saved on this device until then.";
  list.appendChild(note);
}


// ---------------------------------------------------------------
// SIGNING IN, AND KEEPING PROGRESS SAFE
//
// Everything still works signed out - it just lives on this device.
// Signing in copies it to the server so it follows the person
// around and survives a cleared browser.
// ---------------------------------------------------------------
function signedIn() {
  return Boolean(authToken);
}

// Everything worth keeping, in one lump.
function gatherProgress() {
  return {
    xp: xp,
    coins: coins,
    streak: streak,
    shields: shields,
    alerts: alerts,
    favTeams: favTeams,
    favLeagues: favLeagues,
    dailyCounts: dailyCounts,
    weekCounts: weekCounts,
    seasonCounts: seasonCounts,
    claimed: claimed,
    lastOpen: localStorage.getItem("lastOpen") || "",
    lastSpin: localStorage.getItem("lastSpin") || "",
    xpHistory: xpHistory,
    weekStartXp: weekStartXp,
    bestDivision: bestDivision,
    badgeClub: badgeClub,
  };
}

function applyProgress(data) {
  if (!data) return;

  // Whichever side has more XP wins, so signing in on a fresh
  // phone does not wipe a long-standing account, and signing in
  // after playing offline does not lose that either.
  const theirs = Number(data.xp) || 0;
  const mine = xp;

  if (theirs >= mine) {
    xp = theirs;
    coins = Number(data.coins) || 0;
    streak = Number(data.streak) || 0;
    shields = Number(data.shields) || 0;
    if (Array.isArray(data.alerts)) alerts = data.alerts;
    if (Array.isArray(data.favTeams)) favTeams = data.favTeams;
    if (Array.isArray(data.favLeagues)) favLeagues = data.favLeagues;
    if (data.claimed) claimed = data.claimed;
    if (data.dailyCounts && data.dailyCounts.day === todayKey) {
      dailyCounts = data.dailyCounts;
    }
    if (data.weekCounts && data.weekCounts.week === thisWeek) {
      weekCounts = data.weekCounts;
    }
    if (data.seasonCounts && data.seasonCounts.season === thisSeason) {
      seasonCounts = data.seasonCounts;
    }
    if (data.lastOpen) localStorage.setItem("lastOpen", data.lastOpen);
    if (data.lastSpin) localStorage.setItem("lastSpin", data.lastSpin);
    if (Array.isArray(data.xpHistory)) xpHistory = data.xpHistory;
    if (typeof data.weekStartXp === "number") weekStartXp = data.weekStartXp;
    if (data.bestDivision) bestDivision = data.bestDivision;
    if (data.badgeClub) badgeClub = data.badgeClub;
    saveHistory();
  }

  saveXpState();
  saveCounters();
  saveFavourites();
  saveProgress();
  drawProgress();
}

// Pushes progress up. Quietly does nothing when signed out.
let savePending = null;
function pushProgress() {
  if (!signedIn()) return;

  // Wait a moment in case several things change at once.
  clearTimeout(savePending);
  savePending = setTimeout(async function () {
    try {
      await fetch("/api/progress", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + authToken,
        },
        body: JSON.stringify({ data: gatherProgress() }),
      });
    } catch (error) {
      // Offline. It will go up next time something changes.
    }
  }, 2000);
}

async function pullProgress() {
  if (!signedIn()) return;
  try {
    const response = await fetch("/api/progress", {
      headers: { "Authorization": "Bearer " + authToken },
    });
    if (response.status === 401) { signOut(); return; }
    const result = await response.json();
    applyProgress(result.data);
  } catch (error) {
    // Offline. Carry on with what is on the device.
  }
}

function signOut() {
  authToken = "";
  authEmail = "";
  localStorage.removeItem("authToken");
  localStorage.removeItem("authEmail");
}

async function doAuth(mode, email, password) {
  const response = await fetch("/api/account", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: mode, email: email, password: password }),
  });

  const result = await response.json();
  if (result.error) return result;

  if (result.needsConfirming) return result;

  authToken = result.token;
  authEmail = result.email;
  localStorage.setItem("authToken", authToken);
  localStorage.setItem("authEmail", authEmail);

  await pullProgress();
  pushProgress();
  return result;
}


// ---------------------------------------------------------------
// THE PROFILE SCREEN
//
// Reached by tapping the badge in the top right.
// ---------------------------------------------------------------
let leagueSnapshot = null;   // filled in whenever the league loads

// Things worth showing off, worked out from what we already track.
function trophiesEarned() {
  const won = [];
  const level = levelNow();
  const best = Math.max(bestDivision, divisionNumber());

  if (level >= 5)  won.push({ icon: "&#127941;", text: "Reached level 5" });
  if (level >= 15) won.push({ icon: "&#127941;", text: "Reached level 15" });
  if (level >= 30) won.push({ icon: "&#127942;", text: "Reached level 30" });
  if (streak >= 7)  won.push({ icon: "&#128293;", text: "Seven day streak" });
  if (streak >= 30) won.push({ icon: "&#128293;", text: "Thirty day streak" });
  if (best >= 4) won.push({ icon: "&#9889;", text: "Reached " + DIVISIONS[best - 1].name });
  if ((seasonCounts.match || 0) >= 100) won.push({ icon: "&#9917;", text: "100 matches followed" });
  if (xpHistory.length >= 10) won.push({ icon: "&#128197;", text: "Ten weeks played" });

  return won;
}

function divisionNumber() {
  return leagueSnapshot ? leagueSnapshot.division : 1;
}

function drawProfile() {
  const list = document.getElementById("list");
  list.innerHTML = "";

  const level = levelNow();
  const division = DIVISIONS[Math.max(0, divisionNumber() - 1)];
  const club = badgeClub || favTeams[0] || null;

  // ---- Who they are ----
  const head = document.createElement("div");
  head.className = "profHead";
  head.innerHTML =
    '<div class="profCrest">' +
      (club
        ? '<img src="' + club.logo + '" alt="">'
        : '<span class="profLevelBig">' + level + '</span>') +
      '<span class="profLevelTag">' + level + '</span>' +
    '</div>' +
    '<div class="profNameBox">' +
      '<div class="profNick">' + (leagueSnapshot && leagueSnapshot.name
        ? leagueSnapshot.name : "Set your name") + '</div>' +
      '<div class="profUnder">' + division.name + ' division' +
        (leagueSnapshot && leagueSnapshot.position
          ? ' &middot; ' + leagueSnapshot.position + ' this week' : "") +
      '</div>' +
      (club ? '<div class="profClub">' + club.name + '</div>' : "") +
    '</div>';
  list.appendChild(head);

  // ---- The numbers ----
  const weeks = xpHistory.slice();
  const thisWeekXp = Math.max(0, xp - weekStartXp);
  const lastWeekXp = weeks.length > 0 ? weeks[weeks.length - 1].xp : 0;
  const best = weeks.reduce(function (top, w) {
    return Math.max(top, w.xp);
  }, thisWeekXp);
  const average = weeks.length > 0
    ? Math.round(weeks.reduce(function (sum, w) { return sum + w.xp; }, 0) / weeks.length)
    : thisWeekXp;

  const stats = [
    ["This week", thisWeekXp],
    ["Last week", lastWeekXp],
    ["Best week", best],
    ["Weekly average", average],
    ["Lifetime XP", xp],
    ["Weeks played", weeks.length + 1],
  ];

  const statBox = document.createElement("div");
  statBox.className = "profGrid";
  statBox.innerHTML = stats.map(function (pair) {
    return '<div class="profCell">' +
      '<b>' + pair[1].toLocaleString() + '</b>' +
      '<span>' + pair[0] + '</span>' +
    '</div>';
  }).join("");
  list.appendChild(statBox);

  const divBox = document.createElement("div");
  divBox.className = "profGrid two";
  divBox.innerHTML =
    '<div class="profCell"><b>' + division.name + '</b><span>Division now</span></div>' +
    '<div class="profCell"><b>' +
      DIVISIONS[Math.max(0, Math.max(bestDivision, divisionNumber()) - 1)].name +
    '</b><span>Best reached</span></div>';
  list.appendChild(divBox);

  // ---- The graph ----
  const shown = weeks.slice(-10).concat([{ week: thisWeek, xp: thisWeekXp }]);

  const graphBox = document.createElement("div");
  graphBox.className = "vizBox";

  if (shown.length < 2) {
    graphBox.innerHTML =
      '<div class="vizHead"><span>XP by week</span></div>' +
      '<div class="colEmpty">The graph fills in as the weeks go by.</div>';
  } else {
    const W = 320;
    const H = 110;
    const top = Math.max.apply(null, shown.map(function (w) { return w.xp; })) || 1;
    const step = W / shown.length;

    let bars = "";
    let labels = "";
    for (let i = 0; i < shown.length; i++) {
      const value = shown[i].xp;
      const height = Math.max(2, (value / top) * (H - 26));
      const x = i * step + 3;
      const last = i === shown.length - 1;
      bars += '<rect x="' + x.toFixed(1) + '" y="' + (H - 18 - height).toFixed(1) +
        '" width="' + (step - 6).toFixed(1) + '" height="' + height.toFixed(1) +
        '" rx="2" fill="' + (last ? "#F5A623" : "#1E6FD9") + '"/>';
      labels += '<text x="' + (x + (step - 6) / 2).toFixed(1) + '" y="' + (H - 5) +
        '" text-anchor="middle" font-size="8" fill="#9CA3AF">' +
        (last ? "now" : (i + 1)) + '</text>';
    }

    graphBox.innerHTML =
      '<div class="vizHead"><span>XP by week</span>' +
        '<span class="vizKey">best ' + top.toLocaleString() + '</span></div>' +
      '<div class="vizInner">' +
        '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" role="img">' +
          '<title>XP earned each week</title>' + bars + labels +
        '</svg>' +
      '</div>';
  }
  list.appendChild(graphBox);

  // ---- Trophies ----
  const won = trophiesEarned();
  const trophyHead = document.createElement("div");
  trophyHead.className = "boxHead";
  trophyHead.textContent = "Trophies";
  list.appendChild(trophyHead);

  const trophyBox = document.createElement("div");
  trophyBox.className = "trophyWrap";
  trophyBox.innerHTML = won.length === 0
    ? '<div class="colEmpty">Nothing won yet. Keep playing.</div>'
    : won.map(function (t) {
        return '<div class="trophy"><span>' + t.icon + '</span>' + t.text + '</div>';
      }).join("");
  list.appendChild(trophyBox);

  // ---- Which badge shows in the bar ----
  if (favTeams.length > 0) {
    const pickHead = document.createElement("div");
    pickHead.className = "boxHead";
    pickHead.textContent = "Badge in the top bar";
    list.appendChild(pickHead);

    const picker = document.createElement("div");
    picker.className = "badgePick";
    picker.innerHTML =
      '<div class="pickOne' + (badgeClub ? "" : " on") + '" data-id="none">' +
        '<span class="pickLevel">' + level + '</span>' +
      '</div>' +
      favTeams.slice(0, 5).map(function (team) {
        return '<div class="pickOne' +
          (badgeClub && badgeClub.id === team.id ? " on" : "") +
          '" data-id="' + team.id + '">' +
          '<img src="' + team.logo + '" alt="' + team.name + '">' +
        '</div>';
      }).join("");
    list.appendChild(picker);

    for (const option of picker.querySelectorAll(".pickOne")) {
      option.onclick = function () {
        const id = this.getAttribute("data-id");
        badgeClub = id === "none"
          ? null
          : favTeams.find(function (t) { return String(t.id) === id; }) || null;
        saveHistory();
        pushProgress();
        drawProgress();
        drawProfile();
      };
    }
  }

  // ---- What they follow ----
  const followHead = document.createElement("div");
  followHead.className = "boxHead";
  followHead.textContent = "Follows";
  list.appendChild(followHead);

  const follows = document.createElement("div");
  follows.className = "trophyWrap";
  follows.innerHTML =
    favTeams.map(function (t) {
      return '<div class="chipItem"><img src="' + t.logo + '" alt="">' + t.name + '</div>';
    }).join("") +
    favLeagues.map(function (l) {
      return '<div class="chipItem"><img src="' + l.logo + '" alt="">' + l.name + '</div>';
    }).join("");
  if (favTeams.length === 0 && favLeagues.length === 0) {
    follows.innerHTML = '<div class="colEmpty">Nothing followed yet.</div>';
  }
  list.appendChild(follows);

  // ---- Recently starred matches ----
  const recentHead = document.createElement("div");
  recentHead.className = "boxHead";
  recentHead.textContent = "Recently starred";
  list.appendChild(recentHead);

  const recentBox = document.createElement("div");
  recentBox.innerHTML = alerts.length === 0
    ? '<div class="colEmpty">No matches starred yet.</div>'
    : '<div class="colEmpty">Loading...</div>';
  list.appendChild(recentBox);

  if (alerts.length > 0) {
    (async function () {
      const wanted = alerts.slice(-5).reverse();
      let rows = "";

      for (const id of wanted) {
        try {
          const match = await (await fetch("/api/match?id=" + id + "&light=1")).json();
          if (!match) continue;
          const hg = match.goals.home === null ? "-" : match.goals.home;
          const ag = match.goals.away === null ? "-" : match.goals.away;
          rows += '<div class="recentRow">' +
            '<span class="recentStar">&#9733;</span>' +
            '<img src="' + match.teams.home.logo + '" alt="">' +
            '<span class="recentName">' + match.teams.home.name + '</span>' +
            '<span class="recentScore">' + hg + ' - ' + ag + '</span>' +
            '<span class="recentName right">' + match.teams.away.name + '</span>' +
            '<img src="' + match.teams.away.logo + '" alt="">' +
          '</div>';
        } catch (error) {
          // Skip that one.
        }
      }

      recentBox.innerHTML = rows || '<div class="colEmpty">Could not load them.</div>';
    })();
  }
}


// ---------------------------------------------------------------
// SETTINGS
// ---------------------------------------------------------------
function drawSettings() {
  const list = document.getElementById("list");
  list.innerHTML = "";

  const section = function (title) {
    const head = document.createElement("div");
    head.className = "boxHead";
    head.textContent = title;
    list.appendChild(head);
  };

  const row = function (label, right, onTap) {
    const item = document.createElement("div");
    item.className = "setRow" + (onTap ? " setTap" : "");
    item.innerHTML =
      '<span class="setLabel">' + label + '</span>' +
      '<span class="setRight">' + (right || "") + '</span>';
    if (onTap) item.onclick = onTap;
    list.appendChild(item);
    return item;
  };

  // ---- Account ----
  section("Account");
  if (signedIn()) {
    row("Signed in as", authEmail);
    row("Sign out", "&rsaquo;", function () {
      signOut();
      drawSettings();
    });
  } else {
    row("Not signed in", "&rsaquo;", function () { goTo("xp"); });
    const note = document.createElement("div");
    note.className = "setNote";
    note.textContent =
      "Your progress is only on this device. Sign in from the XP League tab to keep it safe.";
    list.appendChild(note);
  }

  // ---- Alerts ----
  section("Alerts");
  const permission = (typeof Notification === "undefined")
    ? "Not supported"
    : (Notification.permission === "granted" ? "On"
       : Notification.permission === "denied" ? "Blocked" : "Off");

  row("Goal notifications", permission, async function () {
    if (typeof Notification === "undefined") return;
    if (Notification.permission === "default") {
      await askForNotifications();
      drawSettings();
    }
  });
  row("Matches followed", String(alerts.length));

  const alertNote = document.createElement("div");
  alertNote.className = "setNote";
  alertNote.textContent =
    "Alerts arrive while the app is open. Background alerts come with the phone app.";
  list.appendChild(alertNote);

  // ---- What you follow ----
  section("Following");
  row("Clubs", String(favTeams.length), function () {
    favView = "countries";
    goTo("favourites");
  });
  row("Leagues", String(favLeagues.length), function () {
    favView = "countries";
    goTo("favourites");
  });

  // ---- Legal ----
  section("About");
  row("Privacy policy", "&rsaquo;", function () {
    window.open("/privacy", "_blank");
  });
  row("Football data", "apifootball.com");
  row("Version", "1.0");

  // ---- Clearing up ----
  section("Data");
  const clearRow = row("Clear this device", "&rsaquo;", function () {
    if (clearRow.getAttribute("data-armed") === "yes") {
      localStorage.clear();
      location.reload();
      return;
    }
    clearRow.setAttribute("data-armed", "yes");
    clearRow.querySelector(".setLabel").textContent = "Tap again to confirm";
    clearRow.querySelector(".setRight").textContent = "";
    clearRow.classList.add("setDanger");
  });

  const clearNote = document.createElement("div");
  clearNote.className = "setNote";
  clearNote.textContent = signedIn()
    ? "This wipes the app on this phone. Your account keeps everything, so signing back in restores it."
    : "This wipes everything. Without an account there is no way to get it back.";
  list.appendChild(clearNote);
}


// ---------------------------------------------------------------
// CHALLENGES
//
// Four groups. Dailies reset at midnight, weeklies on Monday, and
// the season goals run until June. The season ones are set high
// enough that only someone using the app most days will finish
// them, but low enough that they will finish them before May.
// ---------------------------------------------------------------
const CHALLENGES = [
  // ---- Every day ----
  { id: "d1", group: "daily", text: "Open the app",
    target: 1,  xp: 10,  read: function () { return dailyCounts.daily || 0; } },
  { id: "d2", group: "daily", text: "Look at 3 match centres",
    target: 3,  xp: 20,  read: function () { return dailyCounts.match || 0; } },
  { id: "d3", group: "daily", text: "Check one of your clubs",
    target: 1,  xp: 15,  read: function () { return dailyCounts.club || 0; } },
  { id: "d4", group: "daily", text: "Take your daily spin",
    target: 1,  xp: 15,  read: function () { return dailyCounts.spin || 0; } },

  // ---- This week, the gentle ones ----
  { id: "we1", group: "weekEasy", text: "Visit on 3 different days",
    target: 3,  xp: 60,  read: function () { return (weekCounts.days || []).length; } },
  { id: "we2", group: "weekEasy", text: "Look at 15 match centres",
    target: 15, xp: 60,  read: function () { return weekCounts.match || 0; } },
  { id: "we3", group: "weekEasy", text: "Star 3 matches to follow",
    target: 3,  xp: 50,  read: function () { return weekCounts.star || 0; } },
  { id: "we4", group: "weekEasy", text: "Look at 5 league tables",
    target: 5,  xp: 50,  read: function () { return weekCounts.table || 0; } },

  // ---- This week, the ones that take effort ----
  { id: "wh1", group: "weekHard", text: "Visit every day this week",
    target: 7,  xp: 200, read: function () { return (weekCounts.days || []).length; } },
  { id: "wh2", group: "weekHard", text: "Look at 60 match centres",
    target: 60, xp: 200, read: function () { return weekCounts.match || 0; } },
  { id: "wh3", group: "weekHard", text: "Check your clubs 20 times",
    target: 20, xp: 175, read: function () { return weekCounts.club || 0; } },
  { id: "wh4", group: "weekHard", text: "Look at 25 league tables",
    target: 25, xp: 175, read: function () { return weekCounts.table || 0; } },

  // ---- The whole season ----
  { id: "s1", group: "season", text: "Visit on 150 days",
    target: 150,  xp: 2500, read: function () { return seasonCounts.days || 0; } },
  { id: "s2", group: "season", text: "Look at 1,000 match centres",
    target: 1000, xp: 3000, read: function () { return seasonCounts.match || 0; } },
  { id: "s3", group: "season", text: "Reach a 60 day streak",
    target: 60,   xp: 2500, read: function () { return streak; } },
  { id: "s4", group: "season", text: "Follow 250 matches",
    target: 250,  xp: 2000, read: function () { return seasonCounts.star || 0; } },
  { id: "s5", group: "season", text: "Reach level 30",
    target: 30,   xp: 3500, read: function () { return levelNow(); } },
  { id: "s6", group: "season", text: "Take 120 daily spins",
    target: 120,  xp: 2000, read: function () { return seasonCounts.spin || 0; } },
];

// A symbol for each challenge, so the list is easier to scan.
const CHALLENGE_ICONS = {
  d1: "&#128241;", d2: "&#9917;", d3: "&#128085;", d4: "&#127920;",
  we1: "&#128197;", we2: "&#9917;", we3: "&#9733;", we4: "&#9776;",
  wh1: "&#128197;", wh2: "&#9917;", wh3: "&#128085;", wh4: "&#9776;",
  s1: "&#128197;", s2: "&#9917;", s3: "&#128293;", s4: "&#9733;",
  s5: "&#9889;", s6: "&#127920;",
};

// The period a challenge belongs to, so dailies can come round again.
function periodOf(group) {
  if (group === "daily") return todayKey;
  if (group === "season") return thisSeason;
  return thisWeek;
}

function claimKey(challenge) {
  return challenge.id + "|" + periodOf(challenge.group);
}

function isClaimed(challenge) {
  return Boolean(claimed[claimKey(challenge)]);
}

function claim(challenge) {
  if (isClaimed(challenge)) return;
  if (challenge.read() < challenge.target) return;

  claimed[claimKey(challenge)] = true;
  xp = xp + challenge.xp * currentMultiplier();
  saveXpState();
  saveCounters();
  drawProgress();
}

function drawChallenges() {
  const list = document.getElementById("list");
  list.innerHTML = "";

  const groups = [
    ["daily",    "Today",            "Resets at midnight"],
    ["weekEasy", "This week",        "Resets Monday"],
    ["weekHard", "This week - hard", "Resets Monday"],
    ["season",   "Season " + thisSeason, "Runs until June"],
  ];

  for (const [key, title, note] of groups) {
    const mine = CHALLENGES.filter(function (c) { return c.group === key; });
    const done = mine.filter(function (c) { return isClaimed(c); }).length;

    const head = document.createElement("div");
    head.className = "chGroup";
    head.innerHTML =
      '<span class="chTitle">' + title + '</span>' +
      '<span class="chNote">' + done + ' / ' + mine.length + ' &middot; ' + note + '</span>';
    list.appendChild(head);

    for (const challenge of mine) {
      const at = Math.min(challenge.read(), challenge.target);
      const ready = at >= challenge.target;
      const taken = isClaimed(challenge);
      const pct = (at / challenge.target) * 100;

      const row = document.createElement("div");
      row.className = "chRow" + (taken ? " chTaken" : "");
      row.innerHTML =
        '<div class="chIcon">' + (CHALLENGE_ICONS[challenge.id] || "&#9917;") + '</div>' +
        '<div class="chBody">' +
          '<div class="chTop">' +
            '<span class="chText">' + challenge.text + '</span>' +
            '<span class="chXp">+' + challenge.xp + '</span>' +
          '</div>' +
          '<div class="chBar"><div class="chFill" style="width:' + pct + '%"></div></div>' +
          '<div class="chBottom">' +
            '<span class="chCount">' + at.toLocaleString() + ' / ' +
              challenge.target.toLocaleString() + '</span>' +
            (taken
              ? '<span class="chDone">Claimed</span>'
              : (ready
                  ? '<button class="chClaim">Claim</button>'
                  : '<span class="chTodo">In progress</span>')) +
          '</div>' +
        '</div>';

      const button = row.querySelector(".chClaim");
      if (button) {
        button.onclick = function () {
          claim(challenge);
          drawChallenges();
        };
      }

      list.appendChild(row);
    }
  }
}


// ---------------------------------------------------------------
// THE CLUB SCREEN
// Fixtures, table and player stats for one club.
// ---------------------------------------------------------------
let openClubInfo = null;
let clubTab = "fixtures";

// Set when a club page is opened from a match, so the back arrow
// knows to return to the match rather than dumping you on Home.
let clubReturnFixture = null;

function openClub(club) {
  earn("club");
  openClubInfo = club;
  clubTab = "fixtures";
  screen = "club";
  document.getElementById("mainHeader").style.display = "none";
  document.getElementById("leagueHead").innerHTML = "";
  document.getElementById("matchHead").innerHTML = "";
  refresh();
}

function closeClub() {
  const backToMatch = clubReturnFixture;
  clubReturnFixture = null;
  openClubInfo = null;
  document.getElementById("leagueHead").innerHTML = "";

  if (backToMatch) {
    openMatch(backToMatch);
    // Leaving from the match should go where the match came from,
    // not back into this club page.
    previousScreen = "home";
    return;
  }

  document.getElementById("mainHeader").style.display = "block";
  goTo("home");
}

function drawClubHead() {
  const head = document.getElementById("leagueHead");
  const club = openClubInfo;

  const tabs = [["fixtures", "Fixtures"], ["table", "Table"], ["stats", "Stats"]];
  let tabHtml = "";
  for (const [key, label] of tabs) {
    tabHtml += '<div class="lTab' + (clubTab === key ? " on" : "") +
      '" data-tab="' + key + '">' + label + '</div>';
  }

  head.innerHTML =
    '<div class="leagueHead">' +
      '<div class="leagueHeadTop">' +
        '<span class="back" id="clubBack">&#8592;</span>' +
        '<img src="' + club.logo + '" alt="">' +
        '<div class="txt">' +
          '<div class="ln">' + club.name + '</div>' +
          '<div class="cn">' + (club.leagueName || "") + '</div>' +
        '</div>' +
      '</div>' +
      '<div class="leagueTabs">' + tabHtml + '</div>' +
    '</div>';

  document.getElementById("clubBack").onclick = closeClub;
  for (const tab of head.querySelectorAll(".lTab")) {
    tab.onclick = function () {
      clubTab = this.getAttribute("data-tab");
      refresh();
    };
  }
}

// Goals, assists and bookings for a squad.
function drawClubStats(players) {
  const list = document.getElementById("list");
  list.innerHTML = "";

  const played = players.filter(function (p) {
    return p.goals > 0 || p.assists > 0 || p.yellow > 0 || p.red > 0;
  });

  if (played.length === 0) {
    list.innerHTML =
      '<div class="empty">No player stats yet.<br><br>' +
      'These build up as the season goes on.</div>';
    return;
  }

  // Most involved first.
  played.sort(function (a, b) {
    const scoreA = a.goals * 3 + a.assists * 2;
    const scoreB = b.goals * 3 + b.assists * 2;
    if (scoreA !== scoreB) return scoreB - scoreA;
    return (b.yellow + b.red) - (a.yellow + a.red);
  });

  const head = document.createElement("div");
  head.className = "statHead";
  head.innerHTML =
    '<span class="shPlayer">Player</span>' +
    '<span class="shNum">Gls</span>' +
    '<span class="shNum">Ast</span>' +
    '<span class="shNum">Yel</span>' +
    '<span class="shNum">Red</span>';
  list.appendChild(head);

  for (const player of played) {
    const row = document.createElement("div");
    row.className = "statRow";
    row.innerHTML =
      '<span class="shPlayer">' +
        (player.image
          ? '<img src="' + player.image + '" alt="">'
          : '<span class="noFace">' + (player.number || "") + '</span>') +
        '<span class="pName">' + player.name + '</span>' +
      '</span>' +
      '<span class="shNum strong">' + player.goals + '</span>' +
      '<span class="shNum">' + player.assists + '</span>' +
      '<span class="shNum ' + (player.yellow > 0 ? "yel" : "") + '">' + player.yellow + '</span>' +
      '<span class="shNum ' + (player.red > 0 ? "red" : "") + '">' + player.red + '</span>';
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
  earn("match");
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
        '<div class="side" id="sideHome">' +
          '<img src="' + match.teams.home.logo + '" alt="">' +
          '<div>' + match.teams.home.name + '</div>' +
        '</div>' +
        '<div class="bigScore">' +
          '<div class="nums">' + homeGoals + ' - ' + awayGoals + '</div>' +
          '<div class="clock">' + clock + '</div>' +
        '</div>' +
        '<div class="side" id="sideAway">' +
          '<img src="' + match.teams.away.logo + '" alt="">' +
          '<div>' + match.teams.away.name + '</div>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="tabs">' +
      '<div class="tab' + (matchTab === "summary" ? " on" : "") + '" id="tabSummary">Summary</div>' +
      '<div class="tab' + (matchTab === "comm" ? " on" : "") + '" id="tabComm">Commentary</div>' +
      '<div class="tab' + (matchTab === "pitch" ? " on" : "") + '" id="tabPitch">Line-ups</div>' +
      '<div class="tab' + (matchTab === "stats" ? " on" : "") + '" id="tabStats">Stats</div>' +
    '</div>';

  document.getElementById("backBtn").onclick = closeMatch;

  // Tapping either club opens its own page, and the back arrow
  // there brings you straight back to this match.
  const wireSide = function (elementId, which) {
    const side = document.getElementById(elementId);
    const team = match.teams[which];
    if (!side || !team || !team.id) return;

    side.classList.add("tappable");
    side.onclick = function () {
      clubReturnFixture = match.fixture.id;
      openClub({
        id: team.id,
        name: team.name,
        logo: team.logo,
        leagueId: match.league.id,
        leagueName: match.league.name,
      });
    };
  };
  wireSide("sideHome", "home");
  wireSide("sideAway", "away");
  document.getElementById("tabSummary").onclick = function () { matchTab = "summary"; drawMatch(match); };
  document.getElementById("tabComm").onclick = function () { matchTab = "comm"; drawMatch(match); };
  document.getElementById("tabPitch").onclick = function () { matchTab = "pitch"; drawMatch(match); };
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

  if (matchTab === "comm") {
    const feed = match.commentary || [];

    // ---- Momentum, worked out from the commentary ----
    // Each kind of moment is worth a different amount, added up in
    // five minute blocks. Home counts up, away counts down.
    const WORTH = {
      goal: 6, danger: 3, corner: 2, shot: 3,
      attack: 1, penalty: 4, possession: 0.4, freekick: 0.5,
    };

    const blocks = new Array(19).fill(0);   // 0-5, 5-10 ... up to 95
    let anyMomentum = false;

    for (const moment of feed) {
      if (!moment.side) continue;
      const worth = WORTH[moment.kind];
      if (!worth) continue;
      const block = Math.min(18, Math.floor(moment.minute / 5));
      blocks[block] += moment.side === "home" ? worth : -worth;
      anyMomentum = true;
    }

    if (anyMomentum) {
      // Scale so the tallest bar fills the space.
      let biggest = 1;
      for (const value of blocks) biggest = Math.max(biggest, Math.abs(value));

      const W = 340;
      const H = 64;
      const mid = H / 2;
      const barW = W / blocks.length;

      let bars = "";
      for (let i = 0; i < blocks.length; i++) {
        const value = blocks[i];
        if (value === 0) continue;
        const height = Math.max(2, (Math.abs(value) / biggest) * (mid - 4));
        const x = i * barW + 2;
        const y = value > 0 ? mid - height : mid;
        bars += '<rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) +
          '" width="' + (barW - 4).toFixed(1) + '" height="' + height.toFixed(1) +
          '" fill="' + (value > 0 ? "#185FA5" : "#EF9F27") + '" rx="1"/>';
      }

      const box = document.createElement("div");
      box.className = "vizBox";
      box.innerHTML =
        '<div class="vizHead">' +
          '<span>Momentum</span>' +
          '<span class="vizKey">' +
            '<i style="background:#185FA5"></i>' + match.teams.home.name +
            '<i style="background:#EF9F27;margin-left:10px"></i>' + match.teams.away.name +
          '</span>' +
        '</div>' +
        '<div class="vizInner">' +
          '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" role="img">' +
            '<line x1="0" y1="' + mid + '" x2="' + W + '" y2="' + mid +
              '" stroke="#DDD" stroke-width="1"/>' + bars +
          '</svg>' +
        '</div>';
      list.appendChild(box);
    }

    // ---- Timeline of the big moments ----
    const bigOnes = feed.filter(function (m) {
      return m.kind === "goal" || m.kind === "red" || m.kind === "yellow";
    });

    if (bigOnes.length > 0 || stateOf(match) !== "upcoming") {
      const W = 340;
      const H = 46;
      const played = minuteOf(match) === null ? 90 : Math.min(90, minuteOf(match));
      const at = function (minute) { return 8 + (Math.min(95, minute) / 95) * (W - 16); };

      let marks = "";
      let lastLabelX = -100;

      // Earliest first, so labels can be spaced from left to right.
      const ordered = bigOnes.slice().sort(function (a, b) {
        return a.minute - b.minute;
      });

      for (const moment of ordered) {
        const x = at(moment.minute);

        if (moment.kind === "goal") {
          marks += '<circle cx="' + x.toFixed(1) + '" cy="20" r="5.5" ' +
            'fill="#EF9F27" stroke="#fff" stroke-width="1.5"/>';

          // Only label it if there is room since the last one.
          if (x - lastLabelX > 18) {
            marks += '<text x="' + x.toFixed(1) + '" y="40" text-anchor="middle" ' +
              'font-size="9" fill="#888">' + moment.minute + "'" + '</text>';
            lastLabelX = x;
          }
        } else {
          marks += '<rect x="' + (x - 1.75).toFixed(1) + '" y="14" width="3.5" height="12" rx="1" fill="' +
            (moment.kind === "red" ? "#E24B4A" : "#BA7517") + '"/>';
        }
      }

      const box = document.createElement("div");
      box.className = "vizBox";
      box.innerHTML =
        '<div class="vizHead"><span>Timeline</span></div>' +
        '<div class="vizInner">' +
          '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" role="img">' +
            '<rect x="8" y="17" width="' + (W - 16) + '" height="6" rx="3" fill="#E4E4E0"/>' +
            '<rect x="8" y="17" width="' + ((played / 95) * (W - 16)).toFixed(1) +
              '" height="6" rx="3" fill="#185FA5"/>' +
            marks +
          '</svg>' +
        '</div>';
      list.appendChild(box);
    }

    if (feed.length <= 1) {
      list.innerHTML =
        '<div class="empty">Nothing has happened yet.<br><br>' +
        'Goals, cards and substitutions appear here as they go in.</div>';
      return;
    }

    const icons = {
      goal: "&#9917;", yellow: "&#129000;", red: "&#128308;",
      sub: "&#8646;", start: "&#9654;", end: "&#9209;",
      corner: "&#9971;", attack: "&#8599;", freekick: "&#9678;",
      throw: "&#8646;", offside: "&#9873;", penalty: "&#9899;",
      shot: "&#10162;", danger: "&#10071;", note: "&#8226;",
      possession: "&#9679;", goalkick: "&#9678;",
    };

    const heading = document.createElement("div");
    heading.className = "drawerHint";
    heading.innerHTML = match.hasLiveCommentary
      ? 'Live commentary <span class="liveTag2">minute by minute</span>'
      : "Match events";
    list.appendChild(heading);

    // Newest at the top, the way commentary normally reads.
    for (const moment of feed.slice().reverse()) {
      const row = document.createElement("div");
      row.className = "commRow " + moment.kind;
      row.innerHTML =
        '<div class="commMin">' +
          (moment.clock ? moment.clock : (moment.minute > 0 ? moment.minute + "'" : "")) +
        '</div>' +
        '<div class="commIcon">' + (icons[moment.kind] || "&#8226;") + '</div>' +
        '<div class="commText">' + moment.text + '</div>';
      list.appendChild(row);
    }
    return;
  }

  if (matchTab === "pitch") {
    const pitch = match.pitch;

    if (!pitch || (!pitch.home.keeper && !pitch.away.keeper)) {
      list.innerHTML =
        '<div class="empty">Line-ups not available.<br><br>' +
        'They usually appear about an hour before kick off.</div>';
      return;
    }

    // Anyone who scored gets a ball on their badge.
    const scorers = {};
    for (const event of (match.events || [])) {
      if (event.player && event.player.name) {
        scorers[event.player.name.trim()] = true;
      }
    }

    const W = 340;
    const H = 470;
    let svg =
      '<svg width="100%" viewBox="0 0 ' + W + ' ' + H + '" role="img">' +
      '<title>Line-ups on the pitch</title>' +
      '<desc>Both starting elevens laid out in their formations.</desc>' +
      '<rect x="0" y="0" width="' + W + '" height="' + H + '" rx="6" fill="#2F6410"/>' +
      '<g stroke="#C0DD97" stroke-width="1.4" fill="none" opacity="0.5">' +
        '<rect x="8" y="8" width="' + (W - 16) + '" height="' + (H - 16) + '"/>' +
        '<line x1="8" y1="' + (H / 2) + '" x2="' + (W - 8) + '" y2="' + (H / 2) + '"/>' +
        '<circle cx="' + (W / 2) + '" cy="' + (H / 2) + '" r="42"/>' +
        '<rect x="' + (W / 2 - 78) + '" y="8" width="156" height="52"/>' +
        '<rect x="' + (W / 2 - 78) + '" y="' + (H - 60) + '" width="156" height="52"/>' +
      '</g>';

    // One player badge: photo if we have it, shirt number if not.
    const badge = function (player, x, y, colour, textColour) {
      const safeName = player.name.replace(/[<>&]/g, "");
      // Surnames only, so they fit between the rows.
      const bits = safeName.split(" ");
      let shortName = bits.length > 1 ? bits[bits.length - 1] : safeName;
      if (shortName.length > 10) shortName = shortName.slice(0, 9) + ".";
      const clipId = "clip" + Math.abs(x * 1000 + y);

      let inner;
      if (player.image) {
        inner =
          '<clipPath id="' + clipId + '"><circle cx="' + x + '" cy="' + y + '" r="16"/></clipPath>' +
          '<image href="' + player.image + '" x="' + (x - 16) + '" y="' + (y - 16) +
          '" width="32" height="32" clip-path="url(#' + clipId + ')" preserveAspectRatio="xMidYMid slice"/>' +
          '<circle cx="' + x + '" cy="' + y + '" r="16" fill="none" stroke="' + colour + '" stroke-width="2.5"/>';
      } else {
        inner =
          '<circle cx="' + x + '" cy="' + y + '" r="16" fill="' + colour + '" stroke="#fff" stroke-width="2"/>' +
          '<text x="' + x + '" y="' + (y + 4) + '" text-anchor="middle" font-size="12" ' +
          'font-weight="600" fill="' + textColour + '">' + (player.number || "") + '</text>';
      }

      const scored = scorers[safeName] ? ' &#9917;' : '';

      return inner +
        '<text x="' + x + '" y="' + (y + 27) + '" text-anchor="middle" font-size="8.5" ' +
        'fill="#FFFFFF" stroke="#1B3D08" stroke-width="2.5" paint-order="stroke" ' +
        'font-weight="600">' + shortName + scored + '</text>';
    };

    // Home fills the top half, away the bottom.
    const placeSide = function (side, topDown, colour, textColour) {
      let out = "";
      const bands = side.rows.length + 1;
      const half = H / 2;

      for (let r = 0; r <= side.rows.length; r++) {
        const players = r === 0 ? [side.keeper] : side.rows[r - 1];
        if (!players || players.length === 0 || !players[0]) continue;

        const step = half / (bands + 0.4);
        const y = topDown
          ? 34 + r * step
          : H - 34 - r * step;

        for (let i = 0; i < players.length; i++) {
          const x = (W / (players.length + 1)) * (i + 1);
          out += badge(players[i], Math.round(x), Math.round(y), colour, textColour);
        }
      }
      return out;
    };

    svg += placeSide(pitch.home, true, "#185FA5", "#FFFFFF");
    svg += placeSide(pitch.away, false, "#EF9F27", "#412402");
    svg += '</svg>';

    const wrap = document.createElement("div");
    wrap.className = "pitchWrap";
    wrap.innerHTML =
      '<div class="pitchNote">' +
        '<span><b>' + match.teams.home.name + '</b> ' + (match.formations.home || "") + '</span>' +
        '<span>' + (match.formations.away || "") + ' <b>' + match.teams.away.name + '</b></span>' +
      '</div>' + svg;
    list.appendChild(wrap);

    // Full team sheets, side by side under the pitch.
    const sheetOf = function (side) {
      const all = [];
      if (side.keeper) all.push(side.keeper);
      for (const row of side.rows) for (const p of row) all.push(p);
      return all;
    };

    // Who came off and who came on, so the sheet can mark them.
    const cameOff = {};
    const cameOn = {};
    for (const moment of (match.commentary || [])) {
      if (moment.kind !== "sub") continue;
      const bits = String(moment.text).split(":");
      const detail = bits.length > 1 ? bits[1] : moment.text;
      const pair = detail.split(/\||,| in,| out/);
      if (pair[0]) cameOff[pair[0].trim()] = moment.minute;
      if (pair[1]) cameOn[pair[1].trim()] = moment.minute;
    }

    const listOut = function (players, onBench) {
      if (players.length === 0) {
        return '<div class="sheetRow sheetNone">None listed</div>';
      }
      return players.map(function (p) {
        const clean = p.name.trim();
        const scored = scorers[clean] ? ' <span class="sheetGoal">&#9917;</span>' : "";

        let mark = "";
        if (!onBench && cameOff[clean] !== undefined) {
          mark = '<span class="subMark off">&#9660;</span>';
        } else if (onBench && cameOn[clean] !== undefined) {
          mark = '<span class="subMark on">&#9650;</span>';
        }

        return '<div class="sheetRow' + (onBench ? " benchRow" : "") + '">' +
          '<span class="sheetNum">' + (p.number || "") + '</span>' +
          '<span class="sheetName">' + p.name + scored + '</span>' +
          mark +
        '</div>';
      }).join("");
    };

    const columnFor = function (side, team, which) {
      let html =
        '<div class="sheetHead ' + which + '">' + team + '</div>' +
        listOut(sheetOf(side), false);

      html += '<div class="sheetSub">Substitutes</div>' +
              listOut(side.bench || [], true);

      if (side.coach) {
        html += '<div class="sheetSub">Manager</div>' +
                '<div class="sheetRow"><span class="sheetNum"></span>' +
                '<span class="sheetName">' + side.coach + '</span></div>';
      }

      if ((side.missing || []).length > 0) {
        html += '<div class="sheetSub">Unavailable</div>' +
          side.missing.map(function (n) {
            return '<div class="sheetRow benchRow"><span class="sheetNum"></span>' +
              '<span class="sheetName">' + n + '</span></div>';
          }).join("");
      }

      return '<div class="sheetCol">' + html + '</div>';
    };

    const sheets = document.createElement("div");
    sheets.className = "sheets";
    sheets.innerHTML =
      columnFor(pitch.home, match.teams.home.name, "home") +
      columnFor(pitch.away, match.teams.away.name, "away");
    list.appendChild(sheets);

    const extras = match.extras || {};
    if (extras.stadium || extras.referee) {
      const info = document.createElement("div");
      info.className = "extras";
      info.innerHTML =
        (extras.stadium ? "Ground: " + extras.stadium + "<br>" : "") +
        (extras.referee ? "Referee: " + extras.referee : "");
      list.appendChild(info);
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
// ---------------------------------------------------------------
// THE FIXTURES SCREEN FILTER
// ---------------------------------------------------------------
let fixtureFilter = null;   // { country, league } or null
let filterStage = "off";    // off | country | league

// Which kinds of match to show: all, upcoming, live or finished.
let stateFilter = "all";

function drawFilterBar(counts) {
  const bar = document.createElement("div");
  bar.className = "filterBar";

  const leagueRow = fixtureFilter
    ? '<span class="filterNote">' + fixtureFilter.country +
      ' &rsaquo; ' + fixtureFilter.league.name + '</span>' +
      '<span class="filterClear" id="clearFilter">Clear</span>'
    : '<button class="filterBtn" id="openFilter">Filter by league</button>' +
      '<span class="filterNote">Showing everywhere</span>';

  const chip = function (key, icon, label, count) {
    return '<div class="chip' + (stateFilter === key ? " on" : "") +
      '" data-state="' + key + '">' +
      '<span class="cIcon">' + icon + '</span>' + label +
      (count === undefined ? "" : '<span class="cCount">' + count + '</span>') +
      '</div>';
  };

  bar.innerHTML =
    leagueRow +
    '<div class="chips">' +
      chip("all", "&#9776;", "All", counts.all) +
      chip("upcoming", "&#128197;", "Fixtures", counts.upcoming) +
      chip("live", "&#9679;", "Live", counts.live) +
      chip("finished", "&#10003;", "Results", counts.finished) +
    '</div>';

  return bar;
}

function wireFilterBar() {
  const open = document.getElementById("openFilter");
  if (open) {
    open.onclick = function () {
      filterStage = "country";
      refresh();
    };
  }
  const clear = document.getElementById("clearFilter");
  if (clear) {
    clear.onclick = function () {
      fixtureFilter = null;
      filterStage = "off";
      refresh();
    };
  }
  for (const chip of document.querySelectorAll(".chip")) {
    chip.onclick = function () {
      stateFilter = this.getAttribute("data-state");
      refresh();
    };
  }
}

// The two picking steps reuse the same row style as Favourites.
function drawFilterPicker() {
  const list = document.getElementById("list");
  list.innerHTML = "";

  const grouped = countriesInOrder();

  const back = document.createElement("div");
  back.className = "crumbs";
  back.innerHTML = '<span class="crumb">&#8592; Back to fixtures</span>';
  back.querySelector(".crumb").onclick = function () {
    filterStage = "off";
    refresh();
  };
  list.appendChild(back);

  if (filterStage === "country") {
    for (const country of grouped.order) {
      const leagues = grouped.byCountry[country];
      const row = document.createElement("div");
      row.className = "pickRow";
      row.innerHTML =
        (leagues[0].logo ? '<img src="' + leagues[0].logo + '" alt="">' : '<img alt="">') +
        '<span class="pname">' + country + '</span>' +
        '<span class="chev">&#9654;</span>';
      row.onclick = function () {
        fixtureFilter = { country: country, league: null };
        filterStage = "league";
        refresh();
      };
      list.appendChild(row);
    }
    return;
  }

  const leagues = grouped.byCountry[fixtureFilter.country] || [];
  for (const league of leagues) {
    const row = document.createElement("div");
    row.className = "pickRow";
    row.innerHTML =
      (league.logo ? '<img src="' + league.logo + '" alt="">' : '<img alt="">') +
      '<span class="pname">' + league.name + '</span>';
    row.onclick = function () {
      fixtureFilter.league = league;
      filterStage = "off";
      refresh();
    };
    list.appendChild(row);
  }
}


// ---------------------------------------------------------------
// LOADING WHATEVER THE CURRENT SCREEN NEEDS
// ---------------------------------------------------------------
async function refresh() {
  const list = document.getElementById("list");
  const updated = document.getElementById("updated");

  // Most screens need the league list, so fetch it once up front.
  if (allLeagues === null &&
      ["favourites", "home", "fixtures"].includes(screen)) {
    try {
      allLeagues = await (await fetch("/api/leagues")).json();
    } catch (error) {
      allLeagues = [];
    }
  }

  if (screen === "club") {
    drawClubHead();
    const club = openClubInfo;
    updated.textContent = "Loading...";

    try {
      if (clubTab === "fixtures") {
        const matches = await (await fetch("/api/team-season?team=" + club.id)).json();
        if (matches.length === 0) {
          list.innerHTML = '<div class="empty">No fixtures found for this season.</div>';
          updated.textContent = "";
          return;
        }
        matches.sort(function (a, b) {
          return new Date(a.fixture.date) - new Date(b.fixture.date);
        });
        drawMatches(matches, true);
        updated.textContent = matches.length + " games this season";

      } else if (clubTab === "table") {
        // Fall back to reading the league off a fixture if we did
        // not store it when the club was favourited.
        let leagueId = club.leagueId;
        if (!leagueId) {
          const matches = await (await fetch("/api/team-season?team=" + club.id)).json();
          if (matches.length > 0) {
            leagueId = matches[0].league.id;
            club.leagueId = leagueId;
            club.leagueName = matches[0].league.name;
            saveFavourites();
          }
        }

        if (!leagueId) {
          list.innerHTML = '<div class="empty">Could not work out which league.</div>';
          updated.textContent = "";
          return;
        }

        const rows = await (await fetch("/api/table?league=" + leagueId)).json();
        drawTable(rows);
        // Mark where this club sits.
        for (const row of list.querySelectorAll(".tableRow")) {
          if (row.textContent.includes(club.name)) row.classList.add("meRow");
        }
        updated.textContent = club.leagueName || "";

      } else {
        const players = await (await fetch("/api/team-stats?team=" + club.id)).json();
        drawClubStats(players);
        updated.textContent = "";
      }
    } catch (error) {
      updated.textContent = "Could not reach the server";
    }
    return;
  }

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
        const from = isoDate(new Date());
        const later = new Date();
        later.setDate(later.getDate() + 14);
        const matches = await (await fetch(
          "/api/league-fixtures?league=" + id + "&from=" + from + "&to=" + isoDate(later))).json();
        matches.sort(matchSort);
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
      match = await (await fetch("/api/match?id=" + openFixtureId)).json();
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

  if (screen === "favourites") {
    updated.textContent =
      favTeams.length + " clubs, " + favLeagues.length + " leagues followed";

    if (favView === "countries") { drawFavCountries(); return; }
    if (favView === "leagues") { drawFavLeagues(); return; }

    // Teams need fetching for the chosen league.
    list.innerHTML = "";
    list.appendChild(drawCrumbs());
    const loading = document.createElement("div");
    loading.className = "empty";
    loading.textContent = "Loading clubs...";
    list.appendChild(loading);

    try {
      favTeamList = await (await fetch("/api/teams?league=" + favLeagueChosen.id)).json();
    } catch (error) {
      favTeamList = [];
    }
    drawFavTeams();
    return;
  }

  if (screen === "home") {
    await drawHome();
    return;
  }

  if (screen === "xp") {
    updated.textContent = "";
    drawXpScreen();
    return;
  }

  if (screen === "profile") {
    updated.textContent = "";
    // Fetch the league standing first, so the profile can show
    // the division and this week's position.
    if (signedIn() && !leagueSnapshot) {
      try {
        const response = await fetch("/api/league", {
          headers: { "Authorization": "Bearer " + authToken },
        });
        const data = await response.json();
        if (!data.error) {
          leagueSnapshot = data;
          bestDivision = Math.max(bestDivision, data.division || 1);
          saveHistory();
        }
      } catch (error) {
        // Carry on without it.
      }
    }
    drawProfile();
    return;
  }

  if (screen === "settings") {
    updated.textContent = "",
    drawSettings();
    return;
  }

  if (screen === "challenges") {
    updated.textContent = "";
    drawChallenges();
    return;
  }

  // Fixtures screen.
  if (filterStage !== "off") {
    updated.textContent = "";
    drawFilterPicker();
    return;
  }

  updated.textContent = "Loading...";

  let matches = [];
  try {
    if (fixtureFilter && fixtureFilter.league) {
      // Fetch the week in one call, since that caches well, then
      // show only the day that is selected.
      const later = new Date(chosenDate);
      later.setDate(later.getDate() + 7);
      const week = await (await fetch(
        "/api/league-fixtures?league=" + fixtureFilter.league.id +
        "&from=" + chosenDate + "&to=" + isoDate(later))).json();

      matches = week.filter(function (m) {
        return localDateOf(m) === chosenDate;
      });
    } else {
      // Everywhere. The server sends the day either side as well,
      // so the local day can be picked out here.
      const wide = await (await fetch(
        "/api/fixtures?date=" + chosenDate + "&all=1&span=1")).json();
      matches = wide.filter(function (m) {
        return localDateOf(m) === chosenDate;
      });
    }
  } catch (error) {
    updated.textContent = "Could not reach the server";
    return;
  }

  // Count each kind so the chips can show numbers.
  const counts = { all: matches.length, live: 0, upcoming: 0, finished: 0 };
  for (const match of matches) counts[stateOf(match)]++;

  const shown = stateFilter === "all"
    ? matches
    : matches.filter(function (m) { return stateOf(m) === stateFilter; });

  shown.sort(matchSort);

  // drawMatches clears the list, so draw first then put the bar on top.
  if (shown.length === 0) {
    list.innerHTML = '<div class="empty">Nothing to show here.</div>';
  } else {
    drawMatches(shown, true);
  }

  const bar = drawFilterBar(counts);
  list.insertBefore(bar, list.firstChild);
  wireFilterBar();

  updated.textContent = shown.length + " of " + matches.length + " games";
  drawProgress();
}

drawDates();
drawProgress();

// If already signed in, fetch whatever the account has saved.
if (signedIn()) {
  pullProgress().then(function () { if (screen === "xp") drawXpScreen(); });
}

goTo("home");

// The ticker keeps live scores moving on its own, so only the
// home screen needs periodic refreshing.
setInterval(function () {
  if (screen === "home") refresh();
}, 120000);

// An open match refreshes on its own, so new commentary appears
// without the person doing anything.
setInterval(function () {
  if (screen === "match" && matchTab === "comm") refresh();
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

  // ---- Accounts ----
  if (address.pathname === "/api/account" && request.method === "POST") {
    if (!DB_ON) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Accounts are not set up yet" }));
      return;
    }

    let body = "";
    for await (const chunk of request) body += chunk;

    let sent;
    try { sent = JSON.parse(body); } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Could not read that" }));
      return;
    }

    const email = String(sent.email || "").trim().toLowerCase();
    const password = String(sent.password || "");

    if (!email.includes("@") || password.length < 8) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        error: "Need an email address and a password of at least 8 characters",
      }));
      return;
    }

    const result = sent.mode === "signup"
      ? await signUp(email, password)
      : await signIn(email, password);

    response.writeHead(result.error ? 400 : 200,
      { "Content-Type": "application/json" });
    response.end(JSON.stringify(result));
    return;
  }

  // ---- Saved progress ----
  if (address.pathname === "/api/progress") {
    if (!DB_ON) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Accounts are not set up yet" }));
      return;
    }

    const token = String(request.headers.authorization || "").replace("Bearer ", "");
    const who = token ? await whoIs(token) : null;

    if (!who) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Please sign in again" }));
      return;
    }

    if (request.method === "GET") {
      const data = await loadProgress(who.id);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: data }));
      return;
    }

    let body = "";
    for await (const chunk of request) body += chunk;

    let sent;
    try { sent = JSON.parse(body); } catch (error) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Could not read that" }));
      return;
    }

    const saved = await saveProgressFor(who.id, who.email, sent.data || {});
    response.writeHead(saved ? 200 : 500, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ saved: saved }));
    return;
  }

  // ---- The weekly league ----
  if (address.pathname === "/api/league") {
    if (!DB_ON) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Leagues are not set up yet" }));
      return;
    }

    const token = String(request.headers.authorization || "").replace("Bearer ", "");
    const who = token ? await whoIs(token) : null;

    if (!who) {
      response.writeHead(401, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Sign in to join a league" }));
      return;
    }

    // Let someone set the name others see.
    if (request.method === "POST") {
      let body = "";
      for await (const chunk of request) body += chunk;

      let sent;
      try { sent = JSON.parse(body); } catch (error) { sent = {}; }

      const name = String(sent.name || "").trim().slice(0, 18);
      if (name) await updateProfile(who.id, { name: name });
    }

    const profile = await rollWeek(who.id);
    if (!profile) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "No profile saved yet" }));
      return;
    }

    const table = await groupTable(profile.group_key);
    const place = table.findIndex(function (row) { return row.id === who.id; });

    // Only send back what the screen needs, and no email addresses.
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      division: Number(profile.division) || 1,
      name: profile.name || "",
      position: place === -1 ? null : place + 1,
      table: table.map(function (row, index) {
        return {
          position: index + 1,
          name: row.name,
          earned: row.earned,
          you: row.id === who.id,
        };
      }),
      promoteAt: PROMOTE,
      relegateAt: RELEGATE,
      lastResult: profile.last_result || null,
      weekEnds: (function () {
        const d = new Date();
        const daysLeft = (7 - ((d.getUTCDay() + 6) % 7)) % 7 || 7;
        const end = new Date(d);
        end.setUTCDate(end.getUTCDate() + daysLeft);
        end.setUTCHours(0, 0, 0, 0);
        return end.toISOString();
      })(),
    }));
    return;
  }

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
    // span=1 widens it to the day either side, for timezones.
    let all;
    if (address.searchParams.get("span") === "1") {
      const shift = function (days) {
        const d = new Date(date + "T12:00:00Z");
        d.setUTCDate(d.getUTCDate() + days);
        return d.toISOString().slice(0, 10);
      };
      all = await getFixturesRange(shift(-1), shift(1));
    } else {
      all = await getFixturesFor(date);
    }

    // all=1 means every country, used by the Fixtures screen.
    const matches = address.searchParams.get("all") === "1"
      ? all
      : onlyTheirLeagues(all, leagueIdsFrom(address));
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
    // light=1 skips the line-up and squad work.
    const match = address.searchParams.get("light") === "1"
      ? await getMatchLight(fixtureId)
      : await getMatch(fixtureId);
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

  if (address.pathname === "/api/team-fixtures") {
    const teamId = Number(address.searchParams.get("team"));
    const from = address.searchParams.get("from");
    const to = address.searchParams.get("to");
    const dateOk = /^\d{4}-\d{2}-\d{2}$/;

    if (!teamId || !dateOk.test(from) || !dateOk.test(to)) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end("[]");
      return;
    }
    const matches = await getTeamFixtures(teamId, from, to);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(matches));
    return;
  }

  if (address.pathname === "/api/team-season") {
    const teamId = Number(address.searchParams.get("team"));
    if (!teamId) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end("[]");
      return;
    }
    const matches = await getSeason(teamId);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(matches));
    return;
  }

  if (address.pathname === "/api/team-stats") {
    const teamId = Number(address.searchParams.get("team"));
    if (!teamId) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end("[]");
      return;
    }

    const squad = await getSquad(teamId);
    const players = Object.keys(squad).map(function (id) {
      const p = squad[id];
      return {
        name: p.name, image: p.image, number: p.number,
        position: p.position, goals: p.goals, assists: p.assists,
        yellow: p.yellow, red: p.red, played: p.played,
      };
    });

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(players));
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

  // Every live match in the world, not filtered by followed
  // leagues. Shares the same cache, so it costs nothing extra.
  if (address.pathname === "/api/ticker") {
    const all = await getLiveScores();
    const small = all.map(function (m) {
      return {
        id: m.fixture.id,
        home: m.teams.home.name,
        away: m.teams.away.name,
        homeLogo: m.teams.home.logo,
        awayLogo: m.teams.away.logo,
        hg: m.goals.home,
        ag: m.goals.away,
        minute: m.fixture.status.elapsed,
        short: m.fixture.status.short,
        league: m.league.name,
        leagueId: m.league.id,
      };
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(small));
    return;
  }

  // The badge in the top bar. Drop a logo.png next to this file
  // and it appears; without one the bar falls back to a bolt.
  if (address.pathname === "/logo.png") {
    const file = pathlib.join(__dirname, "logo.png");
    fs.readFile(file, function (error, data) {
      if (error) {
        response.writeHead(404);
        response.end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
      });
      response.end(data);
    });
    return;
  }

  if (address.pathname === "/api/news") {
    const items = await getNews();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(items));
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

  // Lists every different match_status value the API is sending
  // today, with an example of each. This is how we find out what
  // words it actually uses for finished, half time and so on.
  // Shows what the API really sends for one match: whether there
  // is a line-up at all, and what the fields are called.
  if (address.pathname === "/api/rawmatch") {
    let id = address.searchParams.get("id");

    // No id given, so pick a live match and use that.
    if (!id) {
      const live = await askApi("get_events", "&match_live=1");
      if (live === null || live.length === 0) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({
          error: "nothing live right now, so pass ?id=MATCHID instead",
        }, null, 2));
        return;
      }
      id = live[0].match_id;
    }

    const raw = await askApi("get_events", "&match_id=" + id);

    if (raw === null || raw.length === 0) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "nothing came back for that match" }, null, 2));
      return;
    }

    const row = raw[0];
    const lineup = row.lineup || {};
    const homeStart = (lineup.home && lineup.home.starting_lineups) || [];
    const awayStart = (lineup.away && lineup.away.starting_lineups) || [];

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      match_id: row.match_id,
      match: row.match_hometeam_name + " v " + row.match_awayteam_name,
      status: row.match_status,
      home_id: row.match_hometeam_id,
      away_id: row.match_awayteam_id,
      formations: {
        home: row.match_hometeam_system,
        away: row.match_awayteam_system,
      },
      lineup_present: Boolean(row.lineup),
      home_starters: homeStart.length,
      away_starters: awayStart.length,
      first_home_player: homeStart[0] || null,
      all_top_level_fields: Object.keys(row),
    }, null, 2));
    return;
  }

  // Shows whether a club's squad photos can be reached.
  if (address.pathname === "/api/rawsquad") {
    const teamId = address.searchParams.get("team");
    if (!teamId) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "add ?team=TEAMID" }, null, 2));
      return;
    }

    const raw = await askApi("get_teams", "&team_id=" + teamId);
    const team = raw && raw[0];

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      team: team ? team.team_name : null,
      player_count: team ? (team.players || []).length : 0,
      first_player: team && team.players ? team.players[0] : null,
    }, null, 2));
    return;
  }

  // Checks whether live commentary is included in the plan.
  if (address.pathname === "/api/commentcheck") {
    const live = await askApi("get_events", "&match_live=1");
    if (live === null || live.length === 0) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "nothing live to test with" }, null, 2));
      return;
    }

    const id = live[0].match_id;
    const data = await askApiObject("get_live_odds_commnets", "&match_id=" + id);
    const entry = data && (data[String(id)] || Object.values(data)[0]);
    const comments = (entry && entry.live_comments) || [];

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      tested_match: live[0].match_hometeam_name + " v " + live[0].match_awayteam_name,
      match_id: id,
      available: comments.length > 0,
      comment_count: comments.length,
      sample: comments.slice(0, 8),
      raw_if_empty: comments.length === 0 ? data : undefined,
    }, null, 2));
    return;
  }

  if (address.pathname === "/api/statuses") {
    const date = address.searchParams.get("date") || isoToday();
    const raw = await askApi("get_events", "&from=" + date + "&to=" + date);

    if (raw === null) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "no answer from the API" }, null, 2));
      return;
    }

    const seen = {};
    for (const row of raw) {
      const key = JSON.stringify(row.match_status);
      if (!seen[key]) {
        seen[key] = {
          match_status: row.match_status,
          count: 0,
          example: row.match_hometeam_name + " " + row.match_hometeam_score +
                   "-" + row.match_awayteam_score + " " + row.match_awayteam_name,
          match_time: row.match_time,
          live: row.match_live,
        };
      }
      seen[key].count++;
    }

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      date: date,
      total: raw.length,
      statuses: Object.values(seen),
    }, null, 2));
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
