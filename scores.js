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
// Which timezone the kickoff times coming back from the API are
// actually in.
//
// We ask for UTC. apifootball ignores that and keeps sending its
// own default, Europe/Berlin - proved by a live Liga 1 match that
// the API reported at minute 1 while its kickoff time was still
// two hours in the future, exactly Berlin's summer offset. So we
// convert from Berlin, and daylight saving comes out in the wash
// because the offset is read off the clock rather than a table.
//
// The same value is sent to the API and used to convert, so if
// they ever start honouring the parameter this still holds. Set
// APIFOOTBALL_TZ to override.
const API_TZ = process.env.APIFOOTBALL_TZ || "Europe/Berlin";

// Minutes that a zone is ahead of UTC at a given instant, worked
// out from the clock rather than a table, so daylight saving is
// handled for free.
function zoneOffsetMinutes(timeZone, when) {
  const format = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });

  const parts = {};
  for (const part of format.formatToParts(when)) parts[part.type] = part.value;

  const asIfUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));

  return (asIfUtc - when.getTime()) / 60000;
}

// "2026-09-11" + "19:00" in some zone, turned into a real instant.
// Two passes, because the offset itself depends on the instant and
// the clocks can change between the guess and the answer.
function toUtcIso(dateText, timeText) {
  const naive = Date.parse(dateText + "T" + timeText + ":00Z");
  if (isNaN(naive)) return dateText + "T" + timeText + ":00Z";
  if (API_TZ === "UTC") return new Date(naive).toISOString();

  let instant = naive;
  for (let pass = 0; pass < 2; pass++) {
    instant = naive - zoneOffsetMinutes(API_TZ, new Date(instant)) * 60000;
  }
  return new Date(instant).toISOString();
}

// ---------------------------------------------------------------
// THE BADGE
//
// The GoalFlash mark, carried inside this file as base64 so there
// is nothing separate to upload and nothing to go missing on a
// deploy. A logo.png sitting next to this file wins if there is
// one, which is how you swap it without touching the code.
// ---------------------------------------------------------------
const LOGO_BASE64 =
  "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" +
  "vIbMokC8hgAAAABJRU5ErkJggg==";

const LOGO_BYTES = Buffer.from(LOGO_BASE64, "base64");

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
      // Always a real instant. Without this the phone reads the
      // time as its own local one and everybody outside the API's
      // timezone sees the wrong kickoff.
      date: toUtcIso(raw.match_date, raw.match_time || "00:00"),
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

// A standing check on the clock. The API tells us how many minutes
// a live game has been going; our kickoff time implies a figure of
// its own. If the two disagree by more than about twenty minutes
// across several matches at once, the timezone is wrong - which is
// how the Europe/Berlin problem was found in the first place.
function checkClockDrift(matches) {
  const gaps = [];

  for (const match of matches) {
    const elapsed = match.fixture.status.elapsed;
    // First and last few minutes are noisy; skip them.
    if (elapsed === null || elapsed < 5 || elapsed > 85) continue;

    const kickoff = new Date(match.fixture.date);
    if (isNaN(kickoff)) continue;

    gaps.push(((Date.now() - kickoff.getTime()) / 60000) - elapsed);
  }

  if (gaps.length < 3) return;

  gaps.sort(function (a, b) { return a - b; });
  const middle = gaps[Math.floor(gaps.length / 2)];

  if (Math.abs(middle) > 20) {
    console.log("   !! CLOCK DRIFT: kickoff times look " +
      (Math.round(middle / 6) / 10) + " hours out across " +
      gaps.length + " live matches. API_TZ is currently " + API_TZ +
      ". Open /api/tzcheck.");
  }
}

async function getLiveScores() {
  const hit = fromCache("live", 60);
  if (hit) return hit;

  const raw = await askApi("get_events", "&match_live=1");
  if (raw === null) return cache["live"] ? cache["live"].data : [];

  const matches = raw.map(translateMatch);
  checkClockDrift(matches);
  return intoCache("live", matches);
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

// ---------------------------------------------------------------
// FANTASY PREMIER LEAGUE
//
// The 6-a-side game runs on the official FPL data. It is free and
// needs no key, but two things about it matter:
//
//   1. It returns 403 to anything that does not look like a
//      browser, hence the User-Agent below.
//   2. It is undocumented and carries no promises. Everything here
//      is written to survive a missing or renamed field rather
//      than throw, and /api/fpl-raw shows what actually came back.
// ---------------------------------------------------------------
const FPL_BASE = "https://fantasy.premierleague.com/api/";

const FPL_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Accept": "application/json",
};

// FPL calls forwards "FWD"; the squad calls them strikers.
const FPL_POSITION = { 1: "GK", 2: "DEF", 3: "MID", 4: "ST" };

async function fplGet(part) {
  const url = FPL_BASE + part;
  console.log("fetching FPL: " + part);

  let response;
  try {
    response = await fetch(url, { headers: FPL_HEADERS });
  } catch (error) {
    console.log("   !! could not reach FPL: " + error.message);
    return null;
  }

  if (!response.ok) {
    console.log("   !! FPL said " + response.status +
      (response.status === 403 ? " - it is refusing this request" : ""));
    return null;
  }

  try {
    return await response.json();
  } catch (error) {
    console.log("   !! FPL answer was not readable");
    return null;
  }
}

// Roughly a megabyte, so it is kept for six hours.
async function getFplBootstrap() {
  const hit = fromCache("fpl-bootstrap", 21600);
  if (hit) return hit;

  const data = await fplGet("bootstrap-static/");
  if (!data || !Array.isArray(data.elements)) {
    return cache["fpl-bootstrap"] ? cache["fpl-bootstrap"].data : null;
  }
  return intoCache("fpl-bootstrap", data);
}

// One gameweek's per-player points. Cached briefly while it is
// still being played, and for a day once it has been signed off.
async function getFplEvent(eventId) {
  const name = "fpl-event-" + eventId;
  const settled = cache[name] && cache[name].data && cache[name].data.dataChecked;
  const hit = fromCache(name, settled ? 86400 : 300);
  if (hit) return hit;

  const data = await fplGet("event/" + eventId + "/live/");
  if (!data || !Array.isArray(data.elements)) {
    return cache[name] ? cache[name].data : null;
  }

  const points = {};
  for (const entry of data.elements) {
    points[String(entry.id)] = Number(entry.stats && entry.stats.total_points) || 0;
  }

  // Whether it is finished comes from the gameweek list, not here.
  const boot = await getFplBootstrap();
  const event = boot && (boot.events || []).find(function (e) {
    return Number(e.id) === Number(eventId);
  });

  return intoCache(name, {
    id: Number(eventId),
    finished: Boolean(event && event.finished),
    dataChecked: Boolean(event && event.data_checked),
    deadline: (event && event.deadline_time) || null,
    points: points,
  });
}

function fplPhoto(player) {
  const code = player.code || String(player.photo || "").replace(/\.[a-z]+$/i, "");
  if (!code) return "";
  return "https://resources.premierleague.com/premierleague/photos/players/" +
    "110x140/p" + code + ".png";
}

function fplBadge(team) {
  if (!team || !team.code) return "";
  return "https://resources.premierleague.com/premierleague/badges/70/t" +
    team.code + ".png";
}

// Everything the squad picker and the statistics table need, in
// one shape, with last week's points folded in.
async function getFplPlayers() {
  const hit = fromCache("fpl-players", 3600);
  if (hit) return hit;

  const boot = await getFplBootstrap();
  if (!boot) {
    return cache["fpl-players"]
      ? cache["fpl-players"].data
      : { players: [], currentEvent: null, previousEvent: null,
          error: "Could not reach the Fantasy Premier League API" };
  }

  const events = boot.events || [];
  const find = function (flag) {
    const found = events.find(function (e) { return e[flag]; });
    return found ? Number(found.id) : null;
  };

  const currentEvent = find("is_current");
  const previousEvent = find("is_previous");
  const nextEvent = find("is_next");

  // Last week's points, if there was a last week.
  let lastWeek = {};
  if (previousEvent) {
    const past = await getFplEvent(previousEvent);
    if (past) lastWeek = past.points || {};
  }

  const teams = {};
  for (const team of (boot.teams || [])) teams[String(team.id)] = team;

  const number = function (value) { return Number(value) || 0; };

  const players = (boot.elements || []).map(function (p) {
    const team = teams[String(p.team)] || {};
    return {
      id: p.id,
      name: p.web_name,
      fullName: ((p.first_name || "") + " " + (p.second_name || "")).trim(),
      team: team.name || "",
      teamShort: team.short_name || "",
      teamBadge: fplBadge(team),
      position: FPL_POSITION[p.element_type] || "",
      photo: fplPhoto(p),

      // The two numbers the list shows.
      points: number(p.total_points),
      lastWeek: number(lastWeek[String(p.id)]),

      form: p.form || "0.0",
      ppg: p.points_per_game || "0.0",
      minutes: number(p.minutes),
      starts: number(p.starts),
      goals: number(p.goals_scored),
      assists: number(p.assists),
      cleanSheets: number(p.clean_sheets),
      conceded: number(p.goals_conceded),
      ownGoals: number(p.own_goals),
      penSaved: number(p.penalties_saved),
      penMissed: number(p.penalties_missed),
      yellow: number(p.yellow_cards),
      red: number(p.red_cards),
      saves: number(p.saves),
      bonus: number(p.bonus),
      bps: number(p.bps),
      xG: p.expected_goals || "0.00",
      xA: p.expected_assists || "0.00",
      ict: p.ict_index || "0.0",
      price: number(p.now_cost) / 10,
      selectedBy: p.selected_by_percent || "0.0",
      status: p.status || "a",
      news: p.news || "",
    };
  });

  players.sort(function (a, b) { return b.points - a.points; });

  return intoCache("fpl-players", {
    players: players,
    currentEvent: currentEvent,
    previousEvent: previousEvent,
    nextEvent: nextEvent,
    updated: new Date().toISOString(),
    error: "",
  });
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

/* A club crest reads far better on white than on gold, so the
   gold moves out to a ring around it. */
.level.hasCrest {
  background: #FFFFFF; padding: 3px;
  border: 2px solid #F5A623;
  box-shadow: 0 0 0 1px rgba(11,30,61,0.35);
}
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

/* The way back out of a tab. The empty twin on the right is there
   so the middle tab sits in the actual middle. */
.subBack {
  flex: 0 0 34px; display: flex;
  align-items: center; justify-content: center;
  font-size: 19px; color: #8FA6C4;
  cursor: pointer; user-select: none;
  padding-bottom: 2px;
}
.subBack:active { color: #fff; }
.subSpacer { pointer-events: none; }
.subTabs .subTab span {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

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
/* =============================================================
   THE FEATURED MATCH
   Sits at the top of Home, laid out the way the match centre
   lays a game out.
   ============================================================= */
.feature {
  background: #0B1E3D; color: #fff; cursor: pointer;
  margin: 12px 12px 4px; border-radius: 14px;
  padding: 14px 14px 12px;
  box-shadow: 0 2px 10px rgba(11,30,61,0.18);
}
.feature:active { opacity: 0.92; }
.featTop {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 11px; margin-bottom: 12px;
}
.featComp {
  color: #8FA6C4; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.featClock {
  color: #4ADE80; font-weight: 700;
  flex-shrink: 0; margin-left: 10px;
}
.featDot {
  display: inline-block; width: 6px; height: 6px;
  border-radius: 50%; background: #4ADE80;
  margin-right: 5px; vertical-align: middle;
  animation: featPulse 1.6s ease-in-out infinite;
}
@keyframes featPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.2; } }

.featScore { display: flex; align-items: center; }
.featSide { flex: 1; min-width: 0; text-align: center; }
.featSide img {
  width: 42px; height: 42px; object-fit: contain;
  margin-bottom: 7px;
}
.featName {
  font-size: 12.5px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.featNums {
  font-size: 30px; font-weight: 700; letter-spacing: -0.5px;
  padding: 0 12px; flex-shrink: 0;
}

/* Room for four scorers a side, held open whether they are there
   or not. Without this the card grows and shrinks as it cycles
   and the whole screen jumps under your thumb. */
.featGoals {
  display: flex; gap: 10px; align-items: flex-start;
  margin-top: 12px; padding-top: 10px;
  border-top: 1px solid #16305A;
  min-height: 76px;
}
.featCol {
  flex: 1; min-width: 0; font-size: 11.5px;
  color: #B9C8DC; line-height: 1.65;
}
.featCol.right { text-align: right; }
.featMore { color: #6F86A6; }
.featCol div {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* The goalless and loading states have to stand exactly as tall
   as a full set of scorers, or the card still jumps. */
.featQuiet {
  margin-top: 12px; padding-top: 10px;
  border-top: 1px solid #16305A;
  font-size: 11.5px; color: #6F86A6; text-align: center;
  min-height: 76px;
  display: flex; align-items: center; justify-content: center;
}
.featDots {
  display: flex; justify-content: center;
  gap: 5px; margin-top: 12px;
}
.featDots i {
  display: block; width: 5px; height: 5px;
  border-radius: 50%; background: #2C4570;
  transition: width 0.2s, background 0.2s;
}
.featDots i.on { background: #F5A623; width: 15px; border-radius: 3px; }

/* =============================================================
   THE FIVE-A-SIDE TEAM
   ============================================================= */
.profRing { position: relative; }
.profRing.hasCrest {
  background: #FFFFFF; padding: 5px;
  border: 3px solid #F5A623;
  box-shadow: 0 0 0 1px rgba(11,30,61,0.35);
}
.profRing.hasCrest img { width: 100%; height: 100%; object-fit: contain; }
.profRingTag {
  position: absolute; right: -4px; bottom: -4px;
  min-width: 22px; height: 22px; padding: 0 5px;
  border-radius: 11px; background: #F5A623; color: #3A2400;
  font-size: 11px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  border: 2px solid #0B1E3D;
}
.profRing:not(.hasCrest) .profRingTag { display: none; }

.fiveTotal {
  display: flex; justify-content: space-between; align-items: center;
  background: #fff; margin: 12px 12px 0;
  border: 1px solid #ECEEF1; border-radius: 12px; padding: 13px 15px;
  box-shadow: 0 1px 2px rgba(16,24,40,0.04);
}
.fiveTotalHead { font-size: 15px; font-weight: 600; color: #111827; }
.fiveTotalSub { font-size: 12px; color: #6B7280; margin-top: 3px; }
.fiveTotalNum { font-size: 22px; font-weight: 700; color: #1E6FD9; }

.fivePitch {
  background: #2F6410; margin: 10px 12px 0;
  border-radius: 14px; padding: 18px 10px;
}
.fiveRow {
  display: flex; justify-content: center;
  gap: 12px; margin-bottom: 16px;
}
.fiveRow:last-child { margin-bottom: 0; }
.fiveSlot { width: 88px; text-align: center; cursor: pointer; }
.fiveSlot:active { opacity: 0.75; }
.fiveShirt {
  width: 54px; height: 54px; border-radius: 50%;
  margin: 0 auto 7px; overflow: hidden;
  background: rgba(255,255,255,0.12);
  border: 2px dashed rgba(255,255,255,0.55);
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; color: rgba(255,255,255,0.85);
}
.fiveShirt.filled {
  background: #fff; border: 2px solid #F5A623;
  color: #0B1E3D; font-weight: 700;
}
.fiveShirt img { width: 100%; height: 100%; object-fit: cover; }
.fivePos {
  font-size: 9.5px; color: #C9E3A8;
  text-transform: uppercase; letter-spacing: 0.5px;
}
.fiveWho {
  font-size: 11px; color: #fff; margin-top: 3px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.fiveStrip {
  display: grid; grid-template-columns: repeat(6, 1fr);
  gap: 7px; padding: 0 12px 10px;
}
.fiveMini { text-align: center; cursor: pointer; }
.fiveMiniDisc {
  width: 100%; aspect-ratio: 1; border-radius: 50%;
  background: #fff; border: 1.5px dashed #D1D5DB;
  display: flex; align-items: center; justify-content: center;
  color: #C4C4BE; font-size: 15px; overflow: hidden;
}
.fiveMiniDisc.filled {
  border: 2px solid #F5A623; color: #0B1E3D; font-weight: 700;
}
.fiveMiniDisc img { width: 100%; height: 100%; object-fit: cover; }
.fiveMiniPos {
  font-size: 9px; color: #6B7280; margin-top: 4px;
  text-transform: uppercase; letter-spacing: 0.3px;
}

.playerRow {
  display: flex; align-items: center; gap: 11px;
  background: #fff; padding: 11px 16px;
  border-bottom: 1px solid #ECEEF1; cursor: pointer;
}
.playerRow:active { background: #F5F6F8; }
.playerTaken { opacity: 0.45; cursor: default; }
.playerFace {
  width: 34px; height: 34px; border-radius: 50%;
  object-fit: cover; flex-shrink: 0; background: #F1EFE8;
}
.playerWho { flex: 1; min-width: 0; }
.playerName {
  display: block; font-size: 14px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.playerTeam { display: block; font-size: 11.5px; color: #6B7280; margin-top: 2px; }
.playerPts { font-size: 15px; font-weight: 700; color: #1E6FD9; flex-shrink: 0; }
.playerTick { width: 16px; color: #16A34A; font-size: 14px; flex-shrink: 0; }

/* =============================================================
   PREMIER LEAGUE PLAYERS
   ============================================================= */
.plHead {
  display: flex; align-items: center; gap: 10px;
  padding: 9px 14px; background: #F0F1F4;
  font-size: 11px; color: #6B7280;
}
.plPosHead { width: 34px; flex-shrink: 0; }
.plFaceHead { width: 36px; flex-shrink: 0; }

.plRow {
  display: flex; align-items: center; gap: 10px;
  background: #fff; padding: 10px 14px;
  border-bottom: 1px solid #ECEEF1; cursor: pointer;
}
.plRow:active { background: #F5F6F8; }
.plPos {
  width: 34px; flex-shrink: 0; text-align: center;
  font-size: 10px; font-weight: 700; letter-spacing: 0.3px;
  padding: 4px 0; border-radius: 5px;
  background: #EFF6FF; color: #1E6FD9;
}
.plPos.gk  { background: #FEF3C7; color: #92400E; }
.plPos.def { background: #DCFCE7; color: #166534; }
.plPos.mid { background: #EFF6FF; color: #1E6FD9; }
.plPos.st  { background: #FCE7F3; color: #9D174D; }
.plFace {
  width: 36px; height: 36px; border-radius: 50%;
  object-fit: cover; background: #F0F1F4; flex-shrink: 0;
  display: block;
}
.plWho { flex: 1; min-width: 0; }
.plName {
  display: block; font-size: 14px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.plTeam { display: block; font-size: 11px; color: #6B7280; margin-top: 2px; }
.plNum {
  width: 46px; flex-shrink: 0; text-align: right;
  font-size: 13px; color: #6B7280;
}
.plNum.total { font-weight: 700; color: #111827; }

.plHero {
  background: #0B1E3D; color: #fff; margin: 12px;
  border-radius: 14px; padding: 18px;
  display: flex; align-items: center; gap: 16px;
}
.plHeroFace {
  width: 76px; height: 76px; border-radius: 50%;
  object-fit: cover; background: #16305A; flex-shrink: 0;
  border: 3px solid #F5A623; display: block;
}
.plHeroWho { min-width: 0; }
.plHeroName { display: block; font-size: 19px; font-weight: 600; }
.plHeroTeam {
  display: flex; align-items: center; gap: 7px;
  font-size: 12.5px; color: #8FA6C4; margin-top: 6px;
}
.plHeroTeam img { width: 18px; height: 18px; object-fit: contain; }
.plHeroPos {
  display: inline-block; margin-top: 9px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.4px;
  padding: 3px 10px; border-radius: 9px;
  background: #F5A623; color: #3A2400;
}
.plNews {
  margin: 0 12px 12px; padding: 11px 14px;
  background: #FEF3C7; border-radius: 10px;
  font-size: 12.5px; color: #92400E; line-height: 1.5;
}

/* The Wednesday lock. */
.lockBar {
  margin: 8px 12px 0; padding: 12px 14px;
  background: #fff; border: 1px solid #ECEEF1;
  border-radius: 12px;
}
.lockLine {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; color: #111827;
}
.lockDot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #16A34A; flex-shrink: 0;
}
.lockPaid { font-size: 11.5px; color: #6B7280; margin-top: 7px; }

/* Where the XP came from. */
.splitRow {
  display: flex; align-items: center; gap: 11px;
  background: #fff; padding: 11px 16px;
  border-bottom: 1px solid #ECEEF1;
}
.splitBody { flex: 1; min-width: 0; }
.splitTop {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: 10px; margin-bottom: 6px;
}
.splitLabel {
  font-size: 14px; color: #111827; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.splitXp { font-size: 13px; font-weight: 700; color: #F5A623; flex-shrink: 0; }
.splitBar {
  display: block; height: 5px; border-radius: 3px;
  background: #EDEDE9; overflow: hidden;
}
.splitFill { display: block; height: 100%; background: #1E6FD9; }
.splitTotal {
  display: flex; justify-content: space-between;
  padding: 12px 16px; background: #fff;
  font-size: 14px; font-weight: 700; color: #111827;
  border-top: 1px solid #E3E6EA;
}

/* Stars on the Coming up rows. */
.upRow { gap: 10px; }
.upStar {
  font-size: 17px; color: #F5A623; flex-shrink: 0;
  user-select: none; line-height: 1; padding-left: 2px;
}
.upStar.off { color: #D8DBE0; }
.followRow .bell { font-size: 17px; }

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
  <div class="subTabs" id="xpTabs" style="display:none">
    <div class="subBack" id="xpBack">&#8592;</div>
    <div class="subTab" data-xp="five">
      <svg class="subIcon" viewBox="0 0 20 18" aria-hidden="true">
        <path d="M7 1.5 3 3.5 1.5 7l3 1.5V16.5h11V8.5l3-1.5L17 3.5 13 1.5a3 3 0 0 1-6 0z"/>
      </svg>
      <span>6-a-side</span>
    </div>
    <div class="subTab on" data-xp="league">
      <svg class="subIcon" viewBox="0 0 18 18" aria-hidden="true">
        <path d="M4.5 1.5h9v5a4.5 4.5 0 0 1-9 0z"/>
        <path d="M4.5 3h-3v1.5a3 3 0 0 0 3 3"/>
        <path d="M13.5 3h3v1.5a3 3 0 0 1-3 3"/>
        <line x1="9" y1="11" x2="9" y2="14"/>
        <line x1="5.5" y1="16.5" x2="12.5" y2="16.5"/>
      </svg>
      <span>League</span>
    </div>
    <div class="subTab" data-xp="players">
      <svg class="subIcon" viewBox="0 0 18 16" aria-hidden="true">
        <line x1="1.5" y1="14.5" x2="16.5" y2="14.5"/>
        <rect x="3" y="8" width="3.2" height="6.5"/>
        <rect x="7.4" y="4" width="3.2" height="10.5"/>
        <rect x="11.8" y="10" width="3.2" height="4.5"/>
      </svg>
      <span>Players</span>
    </div>
    <div class="subBack subSpacer" aria-hidden="true"></div>
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
// WHERE THE XP CAME FROM
//
// One running total per source, so the league page can break it
// down rather than showing a single number nobody can account for.
// Anything earned before this existed lands in "other" on first
// run, which keeps the parts adding up to the whole.
// ---------------------------------------------------------------
let xpSources = JSON.parse(localStorage.getItem("xpSources") || "null");
if (!xpSources) {
  xpSources = {
    challenges: 0, matches: 0, sixaside: 0,
    spin: 0, favourites: 0, other: xp,
  };
}

// The only place XP is ever added. Returns what was given.
function creditXp(source, amount) {
  const given = Number(amount) || 0;
  if (given === 0) return 0;

  xp = xp + given;
  xpSources[source] = (xpSources[source] || 0) + given;
  localStorage.setItem("xpSources", JSON.stringify(xpSources));
  return given;
}

// Which bucket each earnable action belongs in.
const SOURCE_OF = {
  match: "matches",
  table: "matches",
  club: "favourites",
  daily: "other",
  streak: "other",
};

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

// Calendar months, for the monthly challenges.
function monthKeyOf(date) {
  const d = new Date(date);
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
}

const thisWeek = weekKeyOf(new Date());
const thisMonth = monthKeyOf(new Date());
const thisSeason = seasonKeyOf(new Date());

let weekCounts = JSON.parse(localStorage.getItem("weekCounts") || "null");
if (!weekCounts || weekCounts.week !== thisWeek) {
  weekCounts = { week: thisWeek, days: [] };
}

let monthCounts = JSON.parse(localStorage.getItem("monthCounts") || "null");
if (!monthCounts || monthCounts.month !== thisMonth) {
  monthCounts = { month: thisMonth, days: [] };
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
  localStorage.setItem("monthCounts", JSON.stringify(monthCounts));
  localStorage.setItem("seasonCounts", JSON.stringify(seasonCounts));
  localStorage.setItem("claimed", JSON.stringify(claimed));
}

// Adds one to today, this week, this month and this season at once.
function tally(kind) {
  dailyCounts[kind] = (dailyCounts[kind] || 0) + 1;
  weekCounts[kind] = (weekCounts[kind] || 0) + 1;
  monthCounts[kind] = (monthCounts[kind] || 0) + 1;
  seasonCounts[kind] = (seasonCounts[kind] || 0) + 1;
  saveCounters();
}

function saveXpState() {
  if (typeof pushProgress === "function") pushProgress();
  localStorage.setItem("xp", xp);
  localStorage.setItem("xpSources", JSON.stringify(xpSources));
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
  const amount = creditXp(SOURCE_OF[kind] || "other",
                          rule.xp * currentMultiplier());
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

  creditXp("other", EARNINGS.daily.xp);
  coins = coins + 2;
  dailyCounts.daily = 1;

  // Every seventh day pays a bonus.
  if (streak > 0 && streak % 7 === 0) {
    creditXp("other", EARNINGS.streak.xp);
    coins = coins + 10;
  }

  // Note the day, for challenges counting how often someone comes back.
  if (!weekCounts.days.includes(todayKey)) weekCounts.days.push(todayKey);
  if (!monthCounts.days.includes(todayKey)) monthCounts.days.push(todayKey);
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
  document.getElementById("xpTabs").style.display = name === "xp" ? "flex" : "none";
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

for (const tab of document.querySelectorAll("#subTabs .subTab")) {
  tab.onclick = function () {
    homeTab = this.getAttribute("data-sub");
    tally(homeTab);
    if (screen === "home") {
      refresh();
    } else {
      goTo("home");
    }
  };
}

for (const tab of document.querySelectorAll("#xpTabs .subTab")) {
  tab.onclick = function () {
    xpTab = this.getAttribute("data-xp");
    fivePicking = null;
    openPlayerId = null;
    if (screen === "xp") {
      drawXpScreen();
    } else {
      goTo("xp");
    }
  };
}

// One step back out, wherever you are on the XP page: out of a
// player list to the squad, off a side tab to the league, and off
// the league to Home.
document.getElementById("xpBack").onclick = function () {
  if (openPlayerId) {
    openPlayerId = null;
    drawXpScreen();
    return;
  }
  if (fivePicking) {
    fivePicking = null;
    drawXpScreen();
    return;
  }
  if (xpTab !== "home") {
    xpTab = "home";
    drawXpScreen();
    return;
  }
  goTo("home");
};
document.getElementById("navXp").onclick = function () {
  xpTab = "home";
  fivePicking = null;
  openPlayerId = null;
  goTo("xp");
};
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
      if (leagueTab === "stats") tally("scorers");
      if (leagueTab === "teams") tally("teams");
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
// THE FEATURED MATCH
//
// One game at the top of Home, drawn the way the match centre
// draws it. Anything the person follows comes first; if none of
// their games are on, the biggest match in the world stands in.
// ---------------------------------------------------------------
let featureList = [];      // live matches worth featuring, best first
let featureAt = 0;         // which one is on screen
let featureDetails = {};   // fixture id -> { at, match }, for scorers

// How much a competition is worth when nothing is being followed.
// Leans on the same ranking the country drawer uses, so the World
// Cup outranks a Latvian cup tie without a second list to keep.
function competitionWeight(item) {
  const country = item.country || "";
  const tier = rankOf({ name: item.league || "", country: country });

  const pinnedAt = PINNED.findIndex(function (name) {
    return matchesPinned(name, country);
  });

  // rankOf returns -1 for anything it would rather not show, and
  // 100-and-up for women's competitions.
  const tierScore = tier < 0 ? 40 : (tier >= 100 ? 20 + (tier - 100) : tier);
  const countryScore = pinnedAt === -1 ? 12 : pinnedAt;

  // The level of the competition counts for more than which
  // country it is in, so La Liga outranks England's League One.
  return 20 + (tierScore * 3) + countryScore;
}

// Lower is better. Anything under 20 is something they follow.
function featureRank(item) {
  if (alerts.includes(item.id)) return 0;

  const theirs = favTeams.some(function (team) {
    return team.id === item.homeId || team.id === item.awayId;
  });
  if (theirs) return 1;

  const theirLeague = favLeagues.some(function (league) {
    return league.id === item.leagueId;
  });
  if (theirLeague) return 2;

  if (myLeagues.includes(item.leagueId)) return 3;

  return competitionWeight(item);
}

// Works out what goes in the card and in what order. Their own
// matches cycle; a stand-in does not.
function buildFeature(live) {
  const playing = (live || []).slice();

  if (playing.length === 0) {
    featureList = [];
    featureAt = 0;
    return;
  }

  const ranked = playing
    .map(function (item) {
      return { item: item, rank: featureRank(item) };
    })
    .sort(function (a, b) { return a.rank - b.rank; });

  const followed = ranked.filter(function (entry) { return entry.rank < 20; });

  // Four is enough to cycle through without it becoming a slideshow.
  const chosen = followed.length > 0
    ? followed.slice(0, 4)
    : ranked.slice(0, 1);

  const before = featureList[featureAt] ? featureList[featureAt].id : null;
  featureList = chosen.map(function (entry) { return entry.item; });

  // Stay on the same match across a refresh where we can.
  const stillThere = featureList.findIndex(function (item) {
    return item.id === before;
  });
  featureAt = stillThere === -1 ? 0 : stillThere;
}

// Goalscorers, which the ticker does not carry. Kept for a minute
// and a half on the device, since they hardly ever change.
async function featureDetail(id) {
  const saved = featureDetails[id];
  if (saved && Date.now() - saved.at < 90000) return saved.match;

  try {
    const match = await (await fetch("/api/match?id=" + id + "&light=1")).json();
    if (match) featureDetails[id] = { at: Date.now(), match: match };
    return match || (saved ? saved.match : null);
  } catch (error) {
    return saved ? saved.match : null;
  }
}

// Surnames only, so two scorers fit on one line.
function scorerName(name) {
  const clean = String(name || "").trim();
  if (clean.length <= 14) return clean;
  const bits = clean.split(/\s+/);
  return bits.length > 1 ? bits[bits.length - 1] : clean.slice(0, 13) + ".";
}

function featureGoalsHtml(match, item) {
  if (!match || !Array.isArray(match.events) || match.events.length === 0) {
    return '<div class="featQuiet">No goals yet</div>';
  }

  const home = [];
  const away = [];

  for (const event of match.events) {
    const who = scorerName(event.player && event.player.name) || "Unknown";
    const minute = event.time && event.time.elapsed ? event.time.elapsed + "'" : "";
    const line = '<div>' + who + ' ' + minute + '</div>';

    if (event.team && event.team.name === match.teams.home.name) {
      home.push(line);
    } else {
      away.push(line);
    }
  }

  // Four lines a side is what the card is built to hold. A fifth
  // goal turns the last line into a count rather than pushing the
  // card taller.
  const trim = function (lines) {
    if (lines.length <= 4) return lines.join("");
    const over = lines.length - 3;
    return lines.slice(0, 3).join("") +
      '<div class="featMore">+' + over + ' more</div>';
  };

  return '<div class="featGoals">' +
    '<div class="featCol">&#9917; ' + (trim(home) || "<div></div>") + '</div>' +
    '<div class="featCol right">' + (trim(away) || "<div></div>") + ' &#9917;</div>' +
  '</div>';
}

// Draws whichever match is currently up. Score and minute come from
// the ticker so they are always fresh; the scorers arrive after.
async function paintFeature() {
  const box = document.getElementById("featureBox");
  if (!box) return;

  if (featureList.length === 0) {
    box.innerHTML = "";
    return;
  }

  if (featureAt >= featureList.length) featureAt = 0;
  const item = featureList[featureAt];

  const clock = item.minute !== null ? item.minute + "'" : (item.short || "LIVE");
  const hg = item.hg === null ? "-" : item.hg;
  const ag = item.ag === null ? "-" : item.ag;

  const dots = featureList.length > 1
    ? '<div class="featDots">' + featureList.map(function (other, index) {
        return '<i class="' + (index === featureAt ? "on" : "") + '"></i>';
      }).join("") + '</div>'
    : "";

  // Anything already known about the scorers, drawn straight away.
  const known = featureDetails[item.id];

  const shell = function (goalsHtml) {
    return '<div class="feature" data-feature="' + item.id + '">' +
      '<div class="featTop">' +
        '<span class="featComp">' + (item.league || "") + '</span>' +
        '<span class="featClock"><i class="featDot"></i>' + clock + '</span>' +
      '</div>' +
      '<div class="featScore">' +
        '<div class="featSide">' +
          '<img src="' + item.homeLogo + '" alt="">' +
          '<div class="featName">' + item.home + '</div>' +
        '</div>' +
        '<div class="featNums">' + hg + ' - ' + ag + '</div>' +
        '<div class="featSide">' +
          '<img src="' + item.awayLogo + '" alt="">' +
          '<div class="featName">' + item.away + '</div>' +
        '</div>' +
      '</div>' +
      goalsHtml +
      dots +
    '</div>';
  };

  box.innerHTML = shell(known
    ? featureGoalsHtml(known.match, item)
    : '<div class="featQuiet">Loading the goals...</div>');

  const card = box.querySelector(".feature");
  if (card) {
    card.onclick = function () { tally("feature"); openMatch(item.id); };
  }

  // Then fill the scorers in, if they were not already to hand.
  if (!known) {
    const match = await featureDetail(item.id);

    // The card may have moved on while that was in the air.
    const current = box.querySelector("[data-feature]");
    if (!current || current.getAttribute("data-feature") !== String(item.id)) {
      return;
    }

    box.innerHTML = shell(featureGoalsHtml(match, item));
    const again = box.querySelector(".feature");
    if (again) again.onclick = function () { openMatch(item.id); };
  }
}

// Move on to the next one every few seconds. A lone match, or a
// stand-in when nothing followed is being played, just sits there.
setInterval(function () {
  if (screen !== "home" || homeTab !== "live") return;
  if (featureList.length < 2) return;
  featureAt = (featureAt + 1) % featureList.length;
  paintFeature();
}, 7000);


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
  // several places. Scoped to its own strip, or it would wipe the
  // highlight off the XP tabs sitting in the same bar.
  for (const tab of document.querySelectorAll("#subTabs .subTab")) {
    tab.classList.toggle("on", tab.getAttribute("data-sub") === homeTab);
  }

  if (homeTab === "news") { await drawHomeNews(list); return; }
  if (homeTab === "following") { await drawHomeFollowing(list); return; }
  await drawHomeLive(list);
}

// ---- Live: your clubs and leagues, then whatever is on ----
async function drawHomeLive(list) {
  // The featured match goes in first so it sits at the very top,
  // and gets filled once the live feed arrives.
  const featureBox = document.createElement("div");
  featureBox.id = "featureBox";
  list.appendChild(featureBox);

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
  // One request feeds both the card at the top and the grid here.
  let live = [];
  try {
    live = await (await fetch("/api/ticker")).json();
  } catch (error) {
    live = [];
  }

  buildFeature(live);
  await paintFeature();

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

// ---- Following ----
//
// One pool of matches: everything starred, plus the next games of
// every club followed. It is split by whether the game has kicked
// off, so a match moves up the screen on its own the moment it
// starts rather than waiting for anybody to tap anything.
async function drawHomeFollowing(list) {
  if (favTeams.length === 0 && alerts.length === 0) {
    list.innerHTML =
      '<div class="empty">Nothing followed yet.<br><br>' +
      'Star a match, or add a club from Favourites, and it will ' +
      'sit here with its score kept up to date.</div>';
    return;
  }

  const loading = document.createElement("div");
  loading.className = "empty";
  loading.textContent = "Loading your matches...";
  list.appendChild(loading);

  // Live scores first, so anything being played shows a real score
  // rather than whatever was cached an hour ago.
  let live = [];
  try {
    live = await (await fetch("/api/ticker")).json();
  } catch (error) {
    live = [];
  }

  const liveById = {};
  for (const m of live) liveById[m.id] = m;

  // ---- Gather ----
  const pool = {};

  for (const club of favTeams.slice(0, 5)) {
    let season = [];
    try {
      season = await (await fetch("/api/team-season?team=" + club.id)).json();
    } catch (error) {
      continue;
    }

    const next = season
      .filter(function (m) { return stateOf(m) !== "finished"; })
      .sort(function (a, b) {
        return new Date(a.fixture.date) - new Date(b.fixture.date);
      })
      .slice(0, 2);

    for (const match of next) {
      if (!pool[match.fixture.id]) {
        pool[match.fixture.id] = { match: match, club: club };
      }
    }
  }

  for (const id of alerts.slice(0, 12)) {
    if (pool[id]) continue;
    try {
      const match = await (await fetch("/api/match?id=" + id + "&light=1")).json();
      if (match) pool[id] = { match: match, club: null };
    } catch (error) {
      // Skip that one.
    }
  }

  list.innerHTML = "";

  const everything = Object.keys(pool).map(function (key) { return pool[key]; });

  if (everything.length === 0) {
    list.innerHTML =
      '<div class="empty">Could not load your matches.<br><br>' +
      'Pull down to try again.</div>';
    return;
  }

  // Under way or already played on one side, still to come on the
  // other. This is the whole trick: nothing needs moving by hand.
  const started = everything.filter(function (entry) {
    return stateOf(entry.match) !== "upcoming";
  });
  const later = everything.filter(function (entry) {
    return stateOf(entry.match) === "upcoming";
  });

  started.sort(function (a, b) { return matchSort(a.match, b.match); });
  later.sort(function (a, b) {
    return new Date(a.match.fixture.date) - new Date(b.match.fixture.date);
  });

  // The star behaves the same wherever it appears: gold when the
  // match is starred, grey when it is not, and it toggles.
  const wireStar = function (star, id) {
    star.onclick = function (event) {
      event.stopPropagation();
      toggleAlert(id, null);
      drawHome();
    };
  };

  // ---- Under way, or done ----
  if (started.length > 0) {
    const heading = document.createElement("div");
    heading.className = "boardHead";
    heading.innerHTML =
      'Following <span class="liveCount">' + started.length + '</span>';
    list.appendChild(heading);

    for (const entry of started) {
      const match = entry.match;
      const id = match.fixture.id;
      const feed = liveById[id];
      const state = stateOf(match);

      // Prefer the live feed's score and minute where there is one.
      const hg = feed ? feed.hg : match.goals.home;
      const ag = feed ? feed.ag : match.goals.away;

      let when;
      if (state === "live") {
        const minute = feed && feed.minute !== null
          ? feed.minute : minuteOf(match);
        when = match.fixture.status.short === "HT" ? "HT"
          : (minute === null ? "LIVE" : minute + "'");
      } else {
        when = "FT";
      }

      const starred = alerts.includes(id);

      const row = document.createElement("div");
      row.className = "followRow";
      row.innerHTML =
        '<span class="fWhen' + (state === "live" ? " liveNow" : "") + '">' +
          when + '</span>' +
        '<span class="fTeams">' +
          '<span class="fLine">' +
            '<img src="' + match.teams.home.logo + '" alt="">' +
            '<span class="fName">' + match.teams.home.name + '</span>' +
            '<span class="fScore">' + (hg === null ? "-" : hg) + '</span>' +
          '</span>' +
          '<span class="fLine">' +
            '<img src="' + match.teams.away.logo + '" alt="">' +
            '<span class="fName">' + match.teams.away.name + '</span>' +
            '<span class="fScore">' + (ag === null ? "-" : ag) + '</span>' +
          '</span>' +
        '</span>' +
        '<span class="bell' + (starred ? " on" : "") + '">&#9733;</span>';

      row.onclick = function () { openMatch(id); };
      wireStar(row.querySelector(".bell"), id);
      list.appendChild(row);
    }
  }

  // ---- Still to come ----
  if (later.length > 0) {
    const heading = document.createElement("div");
    heading.className = "boardHead";
    heading.textContent = "Coming up";
    list.appendChild(heading);

    for (const entry of later) {
      const match = entry.match;
      const id = match.fixture.id;
      const kickoff = new Date(match.fixture.date);

      const when = isNaN(kickoff) ? "" :
        kickoff.toLocaleDateString([], {
          weekday: "short", day: "numeric", month: "short",
        }) + " " + localTime(kickoff);

      const crest = entry.club ? entry.club.logo : match.teams.home.logo;
      const starred = alerts.includes(id);

      const row = document.createElement("div");
      row.className = "upRow";
      row.innerHTML =
        '<img class="upCrest" src="' + crest + '" alt="">' +
        '<span class="upTeams">' +
          match.teams.home.name + ' v ' + match.teams.away.name +
        '</span>' +
        '<span class="upWhen">' + when + '</span>' +
        '<span class="upStar' + (starred ? "" : " off") + '">&#9733;</span>';

      row.onclick = function () { openMatch(id); };
      wireStar(row.querySelector(".upStar"), id);
      list.appendChild(row);
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
    creditXp("spin", prize.amount);
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
// ---------------------------------------------------------------
// THE FIVE-A-SIDE TEAM
//
// A squad picked from Premier League players. The shape of the
// team is the list below, so changing it is one edit rather than
// a hunt through the drawing code.
//
// NOTE ON THE COUNT: six slots, because that is the line-up asked
// for - a keeper, two at the back, two in the middle and one up
// front. A true five-a-side is five. Drop a line from this list
// and everything else follows.
// ---------------------------------------------------------------
const FIVE_A_SIDE = [
  { slot: "gk",  label: "Goalkeeper", position: "GK",  line: 3 },
  { slot: "df1", label: "Defender",   position: "DEF", line: 2 },
  { slot: "df2", label: "Defender",   position: "DEF", line: 2 },
  { slot: "mf1", label: "Midfield",   position: "MID", line: 1 },
  { slot: "mf2", label: "Midfield",   position: "MID", line: 1 },
  { slot: "st",  label: "Striker",    position: "ST",  line: 0 },
];

// Every Premier League player, straight from the official Fantasy
// Premier League data. Loaded once and kept for the session.
let PL_PLAYERS = [];
let fplMeta = {
  loaded: false, loading: false, error: "",
  currentEvent: null, previousEvent: null,
};

async function loadFplPlayers() {
  if (fplMeta.loaded || fplMeta.loading) return;
  fplMeta.loading = true;

  try {
    const data = await (await fetch("/api/fpl-players")).json();
    PL_PLAYERS = Array.isArray(data.players) ? data.players : [];
    fplMeta.currentEvent = data.currentEvent || null;
    fplMeta.previousEvent = data.previousEvent || null;
    fplMeta.error = data.error ||
      (PL_PLAYERS.length === 0 ? "No players came back" : "");
  } catch (error) {
    fplMeta.error = "Could not reach the player list";
  }

  fplMeta.loading = false;
  fplMeta.loaded = true;
}

// Redraws the XP page if it is still the thing on screen.
function refreshXpIfShowing() {
  if (screen === "xp") drawXpScreen();
}

let fiveASide = JSON.parse(localStorage.getItem("fiveASide") || "{}");
let fivePicking = null;   // which slot is being filled, if any
let openPlayerId = null;  // whose statistics are being read

// ---------------------------------------------------------------
// THE WEDNESDAY LOCK
//
// The squad you had at midnight on Wednesday is the one that
// scores that week. You can still change your picks whenever you
// like - the changes simply wait for the next Wednesday. That way
// nobody can pick a hat-trick scorer on Sunday afternoon.
// ---------------------------------------------------------------
const XP_PER_FPL_POINT = 15;

// The Wednesday that the week containing this date began.
function squadCycleKey(when) {
  const day = new Date(when);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - ((day.getDay() - 3 + 7) % 7));
  return isoDate(day);
}

let squadHistory = JSON.parse(localStorage.getItem("squadHistory") || "{}");
let paidEvents = JSON.parse(localStorage.getItem("paidEvents") || "[]");
let lastSettlement = JSON.parse(localStorage.getItem("lastSettlement") || "null");

function saveSquadLock() {
  // Two months of weeks is more than enough to settle against.
  const cycles = Object.keys(squadHistory).sort();
  while (cycles.length > 8) delete squadHistory[cycles.shift()];

  localStorage.setItem("squadHistory", JSON.stringify(squadHistory));
  localStorage.setItem("paidEvents", JSON.stringify(paidEvents));
  localStorage.setItem("lastSettlement", JSON.stringify(lastSettlement));
  if (typeof pushProgress === "function") pushProgress();
}

// Freezes the current picks for this week, if that has not already
// happened. Called on startup and before every change, so the
// frozen copy is always what was picked before Wednesday.
function ensureSquadLocked() {
  const cycle = squadCycleKey(new Date());
  if (squadHistory[cycle]) return;

  squadHistory[cycle] = Object.assign({}, fiveASide);
  saveSquadLock();
}

function lockedPicks() {
  return squadHistory[squadCycleKey(new Date())] || {};
}

// How many changes are waiting for the next Wednesday.
function pendingChanges() {
  const locked = lockedPicks();
  return FIVE_A_SIDE.filter(function (spot) {
    return String(fiveASide[spot.slot] || "") !== String(locked[spot.slot] || "");
  }).length;
}

// When the current week's picks stop being changeable.
function nextLockDate() {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + (((3 - day.getDay()) + 7) % 7 || 7));
  return day;
}

// Pays out any finished gameweek that has not been paid yet, using
// whichever squad was locked in for the week that gameweek fell in.
async function settleGameweeks() {
  if (!fplMeta.loaded) await loadFplPlayers();

  const candidates = [fplMeta.previousEvent, fplMeta.currentEvent]
    .filter(function (id) { return id && paidEvents.indexOf(id) === -1; });

  for (const eventId of candidates) {
    let event;
    try {
      event = await (await fetch("/api/fpl-event?id=" + eventId)).json();
    } catch (error) {
      continue;
    }

    // Bonus points land late, so wait until the week is signed off.
    if (!event || !event.finished || !event.dataChecked) continue;

    const picks = squadHistory[squadCycleKey(event.deadline || new Date())] || {};

    let points = 0;
    for (const spot of FIVE_A_SIDE) {
      const id = picks[spot.slot];
      if (id) points += Number(event.points[String(id)]) || 0;
    }

    paidEvents.push(eventId);

    if (points > 0) {
      const given = awardSixASide(points * XP_PER_FPL_POINT);
      lastSettlement = { event: eventId, points: points, xp: given };
    } else {
      lastSettlement = { event: eventId, points: 0, xp: 0 };
    }

    saveSquadLock();
  }
}

function saveFiveASide() {
  localStorage.setItem("fiveASide", JSON.stringify(fiveASide));
  if (typeof pushProgress === "function") pushProgress();
}

function playerById(id) {
  return PL_PLAYERS.find(function (p) { return String(p.id) === String(id); }) || null;
}

function playerInSlot(slot) {
  return fiveASide[slot] ? playerById(fiveASide[slot]) : null;
}

// What the squad is worth. This is the hook into the XP league:
// once the scoring rules are settled, feed this into the weekly
// total. It deliberately does not touch xp on its own yet.
function fiveASidePoints() {
  let total = 0;
  for (const spot of FIVE_A_SIDE) {
    const player = playerInSlot(spot.slot);
    if (player) total += Number(player.points) || 0;
  }
  return total;
}

function fiveASideFilled() {
  return FIVE_A_SIDE.filter(function (spot) {
    return Boolean(playerInSlot(spot.slot));
  }).length;
}

// ---- The squad laid out on a pitch ----
function drawFiveASideTab(list) {
  if (fivePicking) { drawPlayerChooser(list); return; }

  const filled = fiveASideFilled();

  const total = document.createElement("div");
  total.className = "fiveTotal";
  total.innerHTML =
    '<span>' +
      '<div class="fiveTotalHead">Your 6-a-side team</div>' +
      '<div class="fiveTotalSub">' + filled + ' of ' + FIVE_A_SIDE.length +
        ' picked</div>' +
    '</span>' +
    '<span class="fiveTotalNum">' + fiveASidePoints().toLocaleString() + '</span>';
  list.appendChild(total);

  // What was paid out last time, and what is waiting on Wednesday.
  const lock = document.createElement("div");
  lock.className = "lockBar";

  const waiting = pendingChanges();
  const locksOn = nextLockDate().toLocaleDateString([], {
    weekday: "long", day: "numeric", month: "short",
  });

  lock.innerHTML =
    '<div class="lockLine">' +
      '<span class="lockDot"></span>' +
      (waiting > 0
        ? waiting + (waiting === 1 ? " change takes" : " changes take") +
          " effect on " + locksOn
        : "This team is locked in and scoring") +
    '</div>' +
    (lastSettlement && lastSettlement.xp > 0
      ? '<div class="lockPaid">Gameweek ' + lastSettlement.event + ': ' +
        lastSettlement.points + ' pts paid as ' +
        lastSettlement.xp.toLocaleString() + ' XP</div>'
      : '<div class="lockPaid">Each Fantasy point is worth ' +
        XP_PER_FPL_POINT + ' XP, paid when the gameweek is settled.</div>');
  list.appendChild(lock);

  const pitch = document.createElement("div");
  pitch.className = "fivePitch";

  // Striker at the top, keeper at the bottom.
  const linesOut = [0, 1, 2, 3];
  let html = "";

  for (const lineNumber of linesOut) {
    const inLine = FIVE_A_SIDE.filter(function (spot) {
      return spot.line === lineNumber;
    });
    if (inLine.length === 0) continue;

    html += '<div class="fiveRow">';
    for (const spot of inLine) {
      const player = playerInSlot(spot.slot);
      html +=
        '<div class="fiveSlot" data-slot="' + spot.slot + '">' +
          '<div class="fiveShirt' + (player ? " filled" : "") + '">' +
            (player
              ? (player.photo
                  ? '<img src="' + player.photo + '" alt="">'
                  : '<span class="fiveInitial">' +
                      player.name.slice(0, 1).toUpperCase() + '</span>')
              : "+") +
          '</div>' +
          '<div class="fivePos">' + spot.position + '</div>' +
          '<div class="fiveWho">' + (player ? player.name : "Empty") + '</div>' +
        '</div>';
    }
    html += '</div>';
  }

  pitch.innerHTML = html;
  list.appendChild(pitch);

  for (const slot of pitch.querySelectorAll(".fiveSlot")) {
    slot.onclick = function () {
      fivePicking = this.getAttribute("data-slot");
      drawXpScreen();
    };
  }

  const note = document.createElement("div");
  note.className = "extras";
  note.innerHTML = PL_PLAYERS.length === 0
    ? "No players loaded yet. Once the Premier League player list " +
      "is in, tap any shirt to pick from it."
    : "Tap a shirt to change that player. What your squad is worth " +
      "feeds into your weekly XP total.";
  list.appendChild(note);
}

// ---- Choosing a player for one slot ----
function drawPlayerChooser(list) {
  const spot = FIVE_A_SIDE.find(function (s) { return s.slot === fivePicking; });
  if (!spot) { fivePicking = null; return; }

  const head = document.createElement("div");
  head.className = "boxHead";
  head.textContent = "Choose a " + spot.label.toLowerCase();
  list.appendChild(head);

  if (!fplMeta.loaded) {
    const wait = document.createElement("div");
    wait.className = "empty";
    wait.textContent = "Loading Premier League players...";
    list.appendChild(wait);
    loadFplPlayers().then(refreshXpIfShowing);
    return;
  }

  const eligible = PL_PLAYERS.filter(function (player) {
    return player.position === spot.position;
  });

  if (eligible.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.innerHTML =
      "No " + spot.label.toLowerCase() + "s available.<br><br>" +
      (fplMeta.error || "Try again shortly.");
    list.appendChild(empty);
    return;
  }

  // Best first, so the obvious pick is at the top.
  eligible.sort(function (a, b) {
    return (Number(b.points) || 0) - (Number(a.points) || 0);
  });

  const taken = {};
  for (const other of FIVE_A_SIDE) {
    if (other.slot !== spot.slot && fiveASide[other.slot]) {
      taken[String(fiveASide[other.slot])] = true;
    }
  }

  for (const player of eligible) {
    const already = taken[String(player.id)];
    const here = String(fiveASide[spot.slot]) === String(player.id);

    const row = document.createElement("div");
    row.className = "playerRow" + (already ? " playerTaken" : "");
    row.innerHTML =
      (player.photo
        ? '<img class="playerFace" src="' + player.photo + '" alt="">'
        : '<span class="noFace">' + player.name.slice(0, 1).toUpperCase() + '</span>') +
      '<span class="playerWho">' +
        '<span class="playerName">' + player.name + '</span>' +
        '<span class="playerTeam">' + (player.team || "") +
          (already ? " &middot; already picked" : "") + '</span>' +
      '</span>' +
      '<span class="playerPts">' + (Number(player.points) || 0) + '</span>' +
      '<span class="playerTick">' + (here ? "&#10003;" : "") + '</span>';

    if (!already) {
      row.onclick = function () {
        // Freeze this week's team before the change lands, so the
        // change belongs to next week and not this one.
        ensureSquadLocked();
        fiveASide[spot.slot] = player.id;
        saveFiveASide();
        tally("fivea");
        fivePicking = null;
        drawXpScreen();
      };
    }
    list.appendChild(row);
  }

  if (fiveASide[spot.slot]) {
    const clear = document.createElement("div");
    clear.className = "setRow setTap setDanger";
    clear.innerHTML = '<span class="setLabel">Leave this place empty</span>' +
      '<span class="setRight">&rsaquo;</span>';
    clear.onclick = function () {
      ensureSquadLocked();
      delete fiveASide[spot.slot];
      saveFiveASide();
      fivePicking = null;
      drawXpScreen();
    };
    list.appendChild(clear);
  }
}

// ---- Player statistics ----
// ---- Player statistics ----
// Position, face, name, last week and the season so far. Tapping
// a row opens everything else there is on them.
function drawPlayerStatsTab(list) {
  if (openPlayerId) { drawPlayerDetail(list); return; }

  if (!fplMeta.loaded) {
    list.innerHTML = '<div class="empty">Loading Premier League players...</div>';
    loadFplPlayers().then(refreshXpIfShowing);
    return;
  }

  if (PL_PLAYERS.length === 0) {
    list.innerHTML =
      '<div class="empty">No players available.<br><br>' +
      (fplMeta.error || "Try again shortly.") +
      '<br><br>Open /api/fpl-raw to see what came back.</div>';
    return;
  }

  const head = document.createElement("div");
  head.className = "plHead";
  head.innerHTML =
    '<span class="plPosHead">Pos</span>' +
    '<span class="plFaceHead"></span>' +
    '<span class="plWho">Player</span>' +
    '<span class="plNum">Last wk</span>' +
    '<span class="plNum">Season</span>';
  list.appendChild(head);

  for (const player of PL_PLAYERS) {
    list.appendChild(playerRowElement(player));
  }

  const note = document.createElement("div");
  note.className = "newsNote";
  note.textContent = "Points and statistics from the official " +
    "Fantasy Premier League game.";
  list.appendChild(note);
}

// One row of the players list. Also used by the squad chooser.
function playerRowElement(player) {
  const row = document.createElement("div");
  row.className = "plRow";
  row.innerHTML =
    '<span class="plPos ' + (player.position || "").toLowerCase() + '">' +
      (player.position || "-") + '</span>' +
    (player.photo
      ? '<img class="plFace" src="' + player.photo + '" alt="">'
      : '<span class="plFace"></span>') +
    '<span class="plWho">' +
      '<span class="plName">' + player.name + '</span>' +
      '<span class="plTeam">' + (player.teamShort || player.team || "") + '</span>' +
    '</span>' +
    '<span class="plNum">' + player.lastWeek + '</span>' +
    '<span class="plNum total">' + player.points + '</span>';

  row.onclick = function () {
    openPlayerId = player.id;
    drawXpScreen();
  };
  return row;
}

// ---- Everything known about one player ----
function drawPlayerDetail(list) {
  const player = playerById(openPlayerId);
  if (!player) { openPlayerId = null; drawPlayerStatsTab(list); return; }

  const hero = document.createElement("div");
  hero.className = "plHero";
  hero.innerHTML =
    (player.photo
      ? '<img class="plHeroFace" src="' + player.photo + '" alt="">'
      : '<span class="plHeroFace"></span>') +
    '<span class="plHeroWho">' +
      '<span class="plHeroName">' + (player.fullName || player.name) + '</span>' +
      '<span class="plHeroTeam">' +
        (player.teamBadge ? '<img src="' + player.teamBadge + '" alt="">' : '') +
        (player.team || "") +
      '</span>' +
      '<span class="plHeroPos">' + (player.position || "") + '</span>' +
    '</span>';
  list.appendChild(hero);

  // Anything about an injury or a suspension goes straight up top.
  if (player.news) {
    const news = document.createElement("div");
    news.className = "plNews";
    news.textContent = player.news;
    list.appendChild(news);
  }

  const section = function (title, cells) {
    const heading = document.createElement("div");
    heading.className = "boxHead";
    heading.textContent = title;
    list.appendChild(heading);

    const grid = document.createElement("div");
    grid.className = "profGrid";
    grid.innerHTML = cells.map(function (cell) {
      return '<div class="profCell"><b>' + cell[1] + '</b>' +
        '<span>' + cell[0] + '</span></div>';
    }).join("");
    list.appendChild(grid);
  };

  section("Points", [
    ["Season total", player.points],
    ["Last week", player.lastWeek],
    ["Form", player.form],
    ["Per game", player.ppg],
    ["Bonus", player.bonus],
    ["Bonus rank pts", player.bps],
  ]);

  section("Attack", [
    ["Goals", player.goals],
    ["Assists", player.assists],
    ["Expected goals", player.xG],
    ["Expected assists", player.xA],
    ["ICT index", player.ict],
    ["Pens missed", player.penMissed],
  ]);

  const defence = [
    ["Clean sheets", player.cleanSheets],
    ["Conceded", player.conceded],
    ["Own goals", player.ownGoals],
  ];
  if (player.position === "GK") {
    defence.push(["Saves", player.saves]);
    defence.push(["Pens saved", player.penSaved]);
  }
  section("Defence", defence);

  section("Discipline and time", [
    ["Yellow cards", player.yellow],
    ["Red cards", player.red],
    ["Minutes", player.minutes.toLocaleString()],
    ["Starts", player.starts],
  ]);

  section("In the game", [
    ["Price", "\u00a3" + player.price.toFixed(1) + "m"],
    ["Picked by", player.selectedBy + "%"],
    ["Worth to you", (player.points * XP_PER_FPL_POINT).toLocaleString() + " XP"],
  ]);

  // Straight into the squad, if there is room for them.
  const spot = FIVE_A_SIDE.find(function (s) {
    return s.position === player.position && !fiveASide[s.slot];
  });

  if (spot) {
    const add = document.createElement("div");
    add.className = "setRow setTap";
    add.innerHTML = '<span class="setLabel">Put in your 6-a-side as ' +
      spot.label.toLowerCase() + '</span><span class="setRight">&rsaquo;</span>';
    add.onclick = function () {
      ensureSquadLocked();
      fiveASide[spot.slot] = player.id;
      saveFiveASide();
      tally("fivea");
      openPlayerId = null;
      xpTab = "five";
      drawXpScreen();
    };
    list.appendChild(add);
  }
}

// The compact strip that sits under the daily spin.
function drawFiveASideStrip(list) {
  const head = document.createElement("div");
  head.className = "boxHead";
  head.innerHTML = 'Your 6-a-side team ' +
    '<span class="liveCount">' + fiveASidePoints().toLocaleString() + ' pts</span>';
  list.appendChild(head);

  const strip = document.createElement("div");
  strip.className = "fiveStrip";
  strip.innerHTML = FIVE_A_SIDE.map(function (spot) {
    const player = playerInSlot(spot.slot);
    return '<div class="fiveMini" data-slot="' + spot.slot + '">' +
      '<div class="fiveMiniDisc' + (player ? " filled" : "") + '">' +
        (player
          ? (player.photo
              ? '<img src="' + player.photo + '" alt="">'
              : player.name.slice(0, 1).toUpperCase())
          : "+") +
      '</div>' +
      '<div class="fiveMiniPos">' + spot.position + '</div>' +
    '</div>';
  }).join("");
  list.appendChild(strip);

  for (const mini of strip.querySelectorAll(".fiveMini")) {
    mini.onclick = function () {
      fivePicking = this.getAttribute("data-slot");
      xpTab = "five";
      drawXpScreen();
    };
  }
}


// ---------------------------------------------------------------
// THE XP SCREEN
// Three tabs: the squad, the league, and who is worth picking.
// ---------------------------------------------------------------
// "home" is the XP page itself. The three named tabs are drilled
// into from the bar and the back arrow returns here.
let xpTab = "home";

function drawXpScreen() {
  const list = document.getElementById("list");
  list.innerHTML = "";

  // The tabs are up in the bar with the rest of the chrome, so all
  // that is needed here is keeping them in step.
  for (const tab of document.querySelectorAll("#xpTabs .subTab")) {
    tab.classList.toggle("on", tab.getAttribute("data-xp") === xpTab);
  }

  if (xpTab === "five") { drawFiveASideTab(list); return; }
  if (xpTab === "players") { drawPlayerStatsTab(list); return; }
  if (xpTab === "league") { drawXpLeagueTab(list); return; }
  drawXpOverview(list);
}

// ---- The XP page itself ----
// Who you are, the spin, your squad and how XP is earned. The
// league table lives on its own tab, reached from the bar.
function drawXpOverview(list) {
  const level = levelNow();
  const division = divisionFor(level);
  const intoLevel = xp % 1000;

  // ---- Account ----
  // Only shown when signed out. Once someone is in there is no
  // reason to keep a login form on the page; signing out lives in
  // Settings.
  if (!signedIn()) {
    const account = document.createElement("div");
    account.className = "acctBox";
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
    list.appendChild(account);

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

    document.getElementById("signInBtn").onclick = function () { runAuth("signin"); };
    document.getElementById("signUpBtn").onclick = function () { runAuth("signup"); };
  }

  // ---- Who you are ----
  // The ring carries the same crest as the badge in the bar, on
  // white with a gold rim so it can actually be made out.
  const ringClub = badgeClub || favTeams[0] || null;

  const card = document.createElement("div");
  card.className = "profCard";
  card.innerHTML =
    '<div class="profTop">' +
      '<div class="profRing' + (ringClub && ringClub.logo ? " hasCrest" : "") + '">' +
        (ringClub && ringClub.logo
          ? '<img src="' + ringClub.logo + '" alt="">'
          : '<span>' + level + '</span>') +
        '<span class="profRingTag">' + level + '</span>' +
      '</div>' +
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

  // ---- The five-a-side team ----
  drawFiveASideStrip(list);

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

  const note = document.createElement("div");
  note.className = "extras";
  note.innerHTML =
    "Six-a-side points do not feed the weekly league yet - that " +
    "waits on the scoring rules and the player list.";
  list.appendChild(note);
}


// ---- Where your XP actually came from ----
// Five named sources, plus a catch-all so the parts always add up
// to the total on the card.
const XP_SPLIT = [
  ["challenges", "Challenges", "&#127919;"],
  ["matches",    "Watching matches", "&#9917;"],
  ["sixaside",   "Your 6-a-side team", "&#128085;"],
  ["spin",       "Daily spin", "&#127920;"],
  ["favourites", "Your favourite teams", "&#11088;"],
];

function drawXpSplit(list) {
  const head = document.createElement("div");
  head.className = "boxHead";
  head.textContent = "Where your XP came from";
  list.appendChild(head);

  const rows = XP_SPLIT.map(function (entry) {
    return {
      key: entry[0], label: entry[1], icon: entry[2],
      amount: Number(xpSources[entry[0]]) || 0,
    };
  });

  const leftover = Number(xpSources.other) || 0;
  if (leftover > 0) {
    rows.push({
      key: "other", label: "Everything else", icon: "&#128241;",
      amount: leftover,
    });
  }

  const total = rows.reduce(function (sum, row) { return sum + row.amount; }, 0);

  const box = document.createElement("div");
  box.className = "listBox";

  box.innerHTML = rows.map(function (row) {
    const share = total === 0 ? 0 : (row.amount / total) * 100;
    return '<div class="splitRow">' +
      '<span class="earnIcon">' + row.icon + '</span>' +
      '<span class="splitBody">' +
        '<span class="splitTop">' +
          '<span class="splitLabel">' + row.label + '</span>' +
          '<span class="splitXp">' + row.amount.toLocaleString() + '</span>' +
        '</span>' +
        '<span class="splitBar">' +
          '<span class="splitFill" style="width:' + share.toFixed(1) + '%"></span>' +
        '</span>' +
      '</span>' +
    '</div>';
  }).join("") +
  '<div class="splitTotal">' +
    '<span>Total</span><span>' + total.toLocaleString() + ' XP</span>' +
  '</div>';

  list.appendChild(box);

  // The squad is worth something, but nothing has been paid out
  // for it yet, so say so rather than showing a bare zero.
  const pending = fiveASidePoints();
  if (pending > 0 && (Number(xpSources.sixaside) || 0) === 0) {
    const waiting = document.createElement("div");
    waiting.className = "extras";
    waiting.innerHTML =
      "Your 6-a-side squad is worth " + pending.toLocaleString() +
      " points, but none of it has been paid into your XP yet.";
    list.appendChild(waiting);
  }
}

// Awards 6-a-side points into the XP total. Nothing calls this
// yet - wire it up once the scoring rules are settled and the
// breakdown above starts filling in on its own.
function awardSixASide(points) {
  const given = creditXp("sixaside", Number(points) || 0);
  if (given > 0) saveXpState();
  return given;
}


// ---- The league table, and nothing else ----
function drawXpLeagueTab(list) {
  if (!signedIn()) {
    list.innerHTML =
      '<div class="empty">Sign in to join a weekly league.<br><br>' +
      'The sign-in form is on the XP page - tap the back arrow.</div>';
    drawXpSplit(list);
    return;
  }

  // ---- This week's league ----
  {
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

      // A malformed answer should not take the whole screen down.
      if (data.error || !Array.isArray(data.table)) {
        leagueBox.innerHTML = '<div class="boxHead">This week</div>' +
          '<div class="colEmpty">' +
            (data.error || "Could not load the league.") + '</div>';
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

  drawXpSplit(list);
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
    monthCounts: monthCounts,
    seasonCounts: seasonCounts,
    fiveASide: fiveASide,
    claimed: claimed,
    lastOpen: localStorage.getItem("lastOpen") || "",
    lastSpin: localStorage.getItem("lastSpin") || "",
    xpHistory: xpHistory,
    xpSources: xpSources,
    squadHistory: squadHistory,
    paidEvents: paidEvents,
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
    if (data.monthCounts && data.monthCounts.month === thisMonth) {
      monthCounts = data.monthCounts;
    }
    if (data.fiveASide) {
      fiveASide = data.fiveASide;
      localStorage.setItem("fiveASide", JSON.stringify(fiveASide));
    }
    if (data.squadHistory) squadHistory = data.squadHistory;
    if (Array.isArray(data.paidEvents)) paidEvents = data.paidEvents;
    if (data.seasonCounts && data.seasonCounts.season === thisSeason) {
      seasonCounts = data.seasonCounts;
    }
    if (data.lastOpen) localStorage.setItem("lastOpen", data.lastOpen);
    if (data.lastSpin) localStorage.setItem("lastSpin", data.lastSpin);
    if (Array.isArray(data.xpHistory)) xpHistory = data.xpHistory;
    if (data.xpSources) {
      xpSources = data.xpSources;
      localStorage.setItem("xpSources", JSON.stringify(xpSources));
    }
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

  // Kickoff times are converted on the device, so it helps to be
  // able to see what the device believes.
  const zone = (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || "unknown";
  row("Your timezone", zone);
  row("Your clock", new Date().toLocaleString([], {
    hour: "2-digit", minute: "2-digit", day: "numeric", month: "short",
  }));
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
  // ---- Every day. Small, quick, all of them doable in a sitting.
  { id: "d1", group: "daily", text: "Open the app",
    target: 1,  xp: 10, read: function () { return dailyCounts.daily || 0; } },
  { id: "d2", group: "daily", text: "Take your daily spin",
    target: 1,  xp: 15, read: function () { return dailyCounts.spin || 0; } },
  { id: "d3", group: "daily", text: "Check one of your clubs",
    target: 1,  xp: 15, read: function () { return dailyCounts.club || 0; } },
  { id: "d4", group: "daily", text: "Read the news",
    target: 1,  xp: 15, read: function () { return dailyCounts.news || 0; } },
  { id: "d5", group: "daily", text: "Star a match to follow",
    target: 1,  xp: 15, read: function () { return dailyCounts.star || 0; } },
  { id: "d6", group: "daily", text: "Look at 3 match centres",
    target: 3,  xp: 20, read: function () { return dailyCounts.match || 0; } },
  { id: "d7", group: "daily", text: "Look at 2 league tables",
    target: 2,  xp: 20, read: function () { return dailyCounts.table || 0; } },
  { id: "d8", group: "daily", text: "Open a commentary feed",
    target: 1,  xp: 20, read: function () { return dailyCounts.comm || 0; } },
  { id: "d9", group: "daily", text: "Study 2 line-ups",
    target: 2,  xp: 25, read: function () { return dailyCounts.lineup || 0; } },
  { id: "d10", group: "daily", text: "Look at 8 match centres",
    target: 8,  xp: 40, read: function () { return dailyCounts.match || 0; } },

  // ---- This week, the gentle ones.
  { id: "we1", group: "weekEasy", text: "Visit on 3 different days",
    target: 3,  xp: 60, read: function () { return (weekCounts.days || []).length; } },
  { id: "we2", group: "weekEasy", text: "Look at 15 match centres",
    target: 15, xp: 60, read: function () { return weekCounts.match || 0; } },
  { id: "we3", group: "weekEasy", text: "Star 3 matches to follow",
    target: 3,  xp: 50, read: function () { return weekCounts.star || 0; } },
  { id: "we4", group: "weekEasy", text: "Look at 5 league tables",
    target: 5,  xp: 50, read: function () { return weekCounts.table || 0; } },
  { id: "we5", group: "weekEasy", text: "Check your clubs 5 times",
    target: 5,  xp: 50, read: function () { return weekCounts.club || 0; } },
  { id: "we6", group: "weekEasy", text: "Take 3 daily spins",
    target: 3,  xp: 50, read: function () { return weekCounts.spin || 0; } },
  { id: "we7", group: "weekEasy", text: "Open the news 5 times",
    target: 5,  xp: 40, read: function () { return weekCounts.news || 0; } },
  { id: "we8", group: "weekEasy", text: "Study 5 line-ups",
    target: 5,  xp: 55, read: function () { return weekCounts.lineup || 0; } },
  { id: "we9", group: "weekEasy", text: "Follow 3 commentary feeds",
    target: 3,  xp: 50, read: function () { return weekCounts.comm || 0; } },
  { id: "we10", group: "weekEasy", text: "Open the featured match 5 times",
    target: 5,  xp: 40, read: function () { return weekCounts.feature || 0; } },

  // ---- This week, the ones that take real effort.
  { id: "wh1", group: "weekHard", text: "Visit every day this week",
    target: 7,   xp: 220, read: function () { return (weekCounts.days || []).length; } },
  { id: "wh2", group: "weekHard", text: "Look at 60 match centres",
    target: 60,  xp: 200, read: function () { return weekCounts.match || 0; } },
  { id: "wh3", group: "weekHard", text: "Check your clubs 20 times",
    target: 20,  xp: 175, read: function () { return weekCounts.club || 0; } },
  { id: "wh4", group: "weekHard", text: "Look at 25 league tables",
    target: 25,  xp: 175, read: function () { return weekCounts.table || 0; } },
  { id: "wh5", group: "weekHard", text: "Star 15 matches",
    target: 15,  xp: 175, read: function () { return weekCounts.star || 0; } },
  { id: "wh6", group: "weekHard", text: "Spin every day this week",
    target: 7,   xp: 200, read: function () { return weekCounts.spin || 0; } },
  { id: "wh7", group: "weekHard", text: "Study 30 line-ups",
    target: 30,  xp: 200, read: function () { return weekCounts.lineup || 0; } },
  { id: "wh8", group: "weekHard", text: "Read 25 sets of match stats",
    target: 25,  xp: 175, read: function () { return weekCounts.mstats || 0; } },
  { id: "wh9", group: "weekHard", text: "Follow 20 commentary feeds",
    target: 20,  xp: 200, read: function () { return weekCounts.comm || 0; } },
  { id: "wh10", group: "weekHard", text: "Look at 10 top scorer lists",
    target: 10,  xp: 150, read: function () { return weekCounts.scorers || 0; } },

  // ---- The month. Long enough that these need keeping up with.
  { id: "m1", group: "month", text: "Visit on 20 days",
    target: 20,  xp: 500, read: function () { return (monthCounts.days || []).length; } },
  { id: "m2", group: "month", text: "Look at 250 match centres",
    target: 250, xp: 600, read: function () { return monthCounts.match || 0; } },
  { id: "m3", group: "month", text: "Star 60 matches",
    target: 60,  xp: 450, read: function () { return monthCounts.star || 0; } },
  { id: "m4", group: "month", text: "Take 25 daily spins",
    target: 25,  xp: 400, read: function () { return monthCounts.spin || 0; } },
  { id: "m5", group: "month", text: "Look at 100 league tables",
    target: 100, xp: 450, read: function () { return monthCounts.table || 0; } },
  { id: "m6", group: "month", text: "Check your clubs 80 times",
    target: 80,  xp: 400, read: function () { return monthCounts.club || 0; } },
  { id: "m7", group: "month", text: "Study 120 line-ups",
    target: 120, xp: 500, read: function () { return monthCounts.lineup || 0; } },
  { id: "m8", group: "month", text: "Open the news 40 times",
    target: 40,  xp: 300, read: function () { return monthCounts.news || 0; } },
  { id: "m9", group: "month", text: "Follow 80 commentary feeds",
    target: 80,  xp: 500, read: function () { return monthCounts.comm || 0; } },
  { id: "m10", group: "month", text: "Reach a 20 day streak",
    target: 20,  xp: 700, read: function () { return streak; } },

  // ---- The whole season.
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
  { id: "s7", group: "season", text: "Study 500 line-ups",
    target: 500,  xp: 2500, read: function () { return seasonCounts.lineup || 0; } },
  { id: "s8", group: "season", text: "Read 400 sets of match stats",
    target: 400,  xp: 2200, read: function () { return seasonCounts.mstats || 0; } },
  { id: "s9", group: "season", text: "Follow 300 commentary feeds",
    target: 300,  xp: 2500, read: function () { return seasonCounts.comm || 0; } },
  { id: "s10", group: "season", text: "Reach level 60",
    target: 60,   xp: 4000, read: function () { return levelNow(); } },
];

// A symbol for each challenge, so the list is easier to scan.
const CHALLENGE_ICONS = {
  d1: "&#128241;", d2: "&#127920;", d3: "&#128085;", d4: "&#128240;",
  d5: "&#9733;", d6: "&#9917;", d7: "&#9776;", d8: "&#128172;",
  d9: "&#128101;", d10: "&#9917;",

  we1: "&#128197;", we2: "&#9917;", we3: "&#9733;", we4: "&#9776;",
  we5: "&#128085;", we6: "&#127920;", we7: "&#128240;", we8: "&#128101;",
  we9: "&#128172;", we10: "&#11088;",

  wh1: "&#128197;", wh2: "&#9917;", wh3: "&#128085;", wh4: "&#9776;",
  wh5: "&#9733;", wh6: "&#127920;", wh7: "&#128101;", wh8: "&#128200;",
  wh9: "&#128172;", wh10: "&#127942;",

  m1: "&#128197;", m2: "&#9917;", m3: "&#9733;", m4: "&#127920;",
  m5: "&#9776;", m6: "&#128085;", m7: "&#128101;", m8: "&#128240;",
  m9: "&#128172;", m10: "&#128293;",

  s1: "&#128197;", s2: "&#9917;", s3: "&#128293;", s4: "&#9733;",
  s5: "&#9889;", s6: "&#127920;", s7: "&#128101;", s8: "&#128200;",
  s9: "&#128172;", s10: "&#128142;",
};

// The period a challenge belongs to, so dailies can come round again.
function periodOf(group) {
  if (group === "daily") return todayKey;
  if (group === "month") return thisMonth;
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
  creditXp("challenges", challenge.xp * currentMultiplier());
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
    ["month",    "This month",       "Resets on the 1st"],
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
  document.getElementById("tabComm").onclick = function () {
    matchTab = "comm"; tally("comm"); drawMatch(match);
  };
  document.getElementById("tabPitch").onclick = function () {
    matchTab = "pitch"; tally("lineup"); drawMatch(match);
  };
  document.getElementById("tabStats").onclick = function () {
    matchTab = "stats"; tally("mstats"); drawMatch(match);
  };

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

// Freeze this week's squad before anything else touches it, then
// fetch the players and pay out any gameweek that has finished.
ensureSquadLocked();
loadFplPlayers()
  .then(settleGameweeks)
  .then(function () {
    drawProgress();
    refreshXpIfShowing();
  });

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
        homeId: m.teams.home.id,
        awayId: m.teams.away.id,
        homeLogo: m.teams.home.logo,
        awayLogo: m.teams.away.logo,
        hg: m.goals.home,
        ag: m.goals.away,
        minute: m.fixture.status.elapsed,
        short: m.fixture.status.short,
        league: m.league.name,
        leagueId: m.league.id,
        country: m.league.country,
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

    // A file on disk beats the built-in one, so the badge can be
    // changed without editing this script.
    fs.readFile(file, function (error, data) {
      response.writeHead(200, {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400",
      });
      response.end(error ? LOGO_BYTES : data);
    });
    return;
  }

  if (address.pathname === "/api/fpl-players") {
    const data = await getFplPlayers();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(data));
    return;
  }

  if (address.pathname === "/api/fpl-event") {
    const eventId = Number(address.searchParams.get("id"));
    if (!eventId) {
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end("null");
      return;
    }
    const data = await getFplEvent(eventId);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(data));
    return;
  }

  // Shows what FPL really sent, for when a field has been renamed
  // or the whole thing is being refused.
  if (address.pathname === "/api/fpl-raw") {
    const boot = await getFplBootstrap();

    if (!boot) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        error: "Nothing came back from fantasy.premierleague.com",
        hint: "A 403 in the logs means the request was refused. " +
              "A network error means the host is unreachable from here.",
      }, null, 2));
      return;
    }

    const first = (boot.elements || [])[0] || null;

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      element_count: (boot.elements || []).length,
      team_count: (boot.teams || []).length,
      element_types: (boot.element_types || []).map(function (t) {
        return { id: t.id, name: t.singular_name_short };
      }),
      events: (boot.events || []).filter(function (e) {
        return e.is_previous || e.is_current || e.is_next;
      }).map(function (e) {
        return {
          id: e.id, name: e.name, deadline_time: e.deadline_time,
          finished: e.finished, data_checked: e.data_checked,
          is_previous: e.is_previous, is_current: e.is_current, is_next: e.is_next,
        };
      }),
      first_element_fields: first ? Object.keys(first) : [],
      first_element: first,
    }, null, 2));
    return;
  }

  if (address.pathname === "/api/news") {
    const items = await getNews();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(items));
    return;
  }

  // Lays out exactly what the API sent and what we made of it, so
  // a wrong kickoff time can be diagnosed rather than guessed at.
  // Open /api/tzcheck on the deployed app.
  if (address.pathname === "/api/tzcheck") {
    const date = address.searchParams.get("date") || isoToday();

    // Same request twice: once asking for UTC, once asking for
    // nothing at all. If the two disagree, the provider honours
    // the timezone parameter. If they match, it is ignoring it.
    const url = BASE + "?action=get_events&from=" + date + "&to=" + date +
      "&timezone=UTC&APIkey=" + API_KEY;
    const bare = BASE + "?action=get_events&from=" + date + "&to=" + date +
      "&APIkey=" + API_KEY;

    const grab = async function (target) {
      try {
        const answer = await fetch(target);
        const rows = await answer.json();
        if (!Array.isArray(rows) || rows.length === 0) return null;
        return rows[0];
      } catch (error) {
        return null;
      }
    };

    const asked = await grab(url);
    const notAsked = await grab(bare);

    const sample = asked || notAsked;
    const now = new Date();

    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      note: "If askedForUtc and askedForNothing show the same time, " +
            "the provider is ignoring the timezone parameter. Set " +
            "APIFOOTBALL_TZ to the zone it really uses - most " +
            "likely Europe/Berlin - and redeploy.",
      configured_API_TZ: API_TZ,
      server_utc_now: now.toISOString(),
      askedForUtc: asked && {
        match: asked.match_hometeam_name + " v " + asked.match_awayteam_name,
        match_date: asked.match_date,
        match_time: asked.match_time,
      },
      askedForNothing: notAsked && {
        match: notAsked.match_hometeam_name + " v " + notAsked.match_awayteam_name,
        match_date: notAsked.match_date,
        match_time: notAsked.match_time,
      },
      whatWeStore: sample
        ? toUtcIso(sample.match_date, sample.match_time || "00:00")
        : null,
      soAPhoneWouldShow: sample
        ? {
            in_Perth: new Date(toUtcIso(sample.match_date, sample.match_time || "00:00"))
              .toLocaleString("en-GB", { timeZone: "Australia/Perth" }),
            in_London: new Date(toUtcIso(sample.match_date, sample.match_time || "00:00"))
              .toLocaleString("en-GB", { timeZone: "Europe/London" }),
          }
        : null,
    }, null, 2));
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
  console.log("  Kickoff times read as " + API_TZ + " and converted to UTC");
  console.log("  On your own PC:  http://localhost:" + PORT);
  console.log("");
});
