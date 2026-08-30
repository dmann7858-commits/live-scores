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


// Same as askApi, but accepts an object rather than a list.
// The live comments endpoint answers with match ids as keys.
async function askApiObject(action, extra) {
  if (!API_KEY || API_KEY === "PASTE_YOUR_KEY_HERE") return null;

  const url = BASE + "?action=" + action + (extra || "") + "&APIkey=" + API_KEY;
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
    max-width: 82vw; background: #EF9F27; z-index: 50;
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
  /* Dark brown reads well on the yellow and matches the level badge. */
  .drawerHint {
    padding: 8px 16px; background: #C97F14;
    font-size: 11px; color: #2B1700; text-transform: uppercase;
    letter-spacing: 0.4px; font-weight: 700;
  }
  .countryItem {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 16px; cursor: pointer;
    border-bottom: 1px solid rgba(43, 23, 0, 0.18);
  }
  .countryItem img {
    width: 18px; height: 18px; object-fit: contain;
    flex-shrink: 0; border-radius: 2px;
  }
  .countryItem .cname {
    flex: 1; font-size: 14px; color: #2B1700; font-weight: 600;
  }
  .countryItem .arrow { font-size: 11px; color: #5C3300; }
  .countryItem:hover { background: #E8940F; }
  .leagueChild {
    padding: 10px 16px 10px 44px; font-size: 13px;
    color: #2B1700; font-weight: 500;
    cursor: pointer; background: #DE9220;
    border-bottom: 1px solid rgba(43, 23, 0, 0.16);
  }
  .leagueChild:hover { background: #C97F14; }

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
    padding: 10px 16px 8px; font-size: 12px;
    color: #666; font-weight: 600;
  }
  .slotRow {
    display: grid; grid-template-columns: repeat(5, 1fr);
    gap: 8px; padding: 0 12px 14px;
  }
  .slot {
    aspect-ratio: 1; border-radius: 12px; background: #F4F4F2;
    display: flex; align-items: center; justify-content: center;
    cursor: pointer; overflow: hidden;
  }
  .slot img {
    width: 74%; height: 74%; object-fit: contain;
  }
  .slot:active { background: #E8E8E4; }
  .slotEmpty {
    border: 1.5px dashed #CFCFC9; background: transparent;
    color: #BBB; font-size: 22px;
  }

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
      <div class="title" id="screenTitle">Live scores</div>
    </div>
    <div class="ticker" id="ticker">
      <div class="tickerInner" id="tickerInner">
        <span class="tickerQuiet">&nbsp;</span>
      </div>
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
  document.getElementById("pickerBox").style.display = "none";
  document.getElementById("searchArea").style.display = "none";

  const titles = {
    favourites: "Favourites", fixtures: "Fixtures", home: "Home",
    xp: "XP League", challenges: "Challenges",
  };
  document.getElementById("screenTitle").textContent = titles[name] || "Live scores";

  refresh();
}

document.getElementById("navFavourites").onclick = function () { favView = "countries"; goTo("favourites"); };
document.getElementById("navFixtures").onclick = function () { goTo("fixtures"); };
document.getElementById("navHome").onclick = function () { goTo("home"); };
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
      const kickoff = new Date(match.fixture.date);
      when = isNaN(kickoff) ? "--:--"
        : kickoff.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      whenClass = "when grey";
    }

    const homeGoals = match.goals.home === null ? "-" : match.goals.home;
    const awayGoals = match.goals.away === null ? "-" : match.goals.away;
    const isOn = alerts.includes(match.fixture.id);

    const row = document.createElement("div");
    row.className = "match";
    row.setAttribute("data-id", match.fixture.id);
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
// FAVOURITES
//
// Two lists: leagues the person follows, and clubs they follow.
// Both are saved on the device and feed the Home screen.
// ---------------------------------------------------------------
let favLeagues = JSON.parse(localStorage.getItem("favLeagues") || "[]");
let favTeams = JSON.parse(localStorage.getItem("favTeams") || "[]");

function saveFavourites() {
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
      '<span class="bell miniBell' + (isOn ? " on" : "") + '">&#128276;</span>' +
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

async function drawHome() {
  const list = document.getElementById("list");
  const updated = document.getElementById("updated");
  list.innerHTML = "";
  updated.textContent = "";

  // Five slots each. Badges only, no names, so nothing collides.
  const slots = function (items, kind) {
    let html = '<div class="slotRow">';
    for (let i = 0; i < 5; i++) {
      const item = items[i];
      if (item) {
        html += '<div class="slot" data-kind="' + kind + '" data-id="' + item.id + '">' +
          '<img src="' + item.logo + '" alt="' + item.name + '">' +
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
}


// ---------------------------------------------------------------
// THE CLUB SCREEN
// Fixtures, table and player stats for one club.
// ---------------------------------------------------------------
let openClubInfo = null;
let clubTab = "fixtures";

function openClub(club) {
  openClubInfo = club;
  clubTab = "fixtures";
  screen = "club";
  document.getElementById("mainHeader").style.display = "none";
  document.getElementById("leagueHead").innerHTML = "";
  refresh();
}

function closeClub() {
  openClubInfo = null;
  document.getElementById("leagueHead").innerHTML = "";
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
      '<div class="tab' + (matchTab === "comm" ? " on" : "") + '" id="tabComm">Commentary</div>' +
      '<div class="tab' + (matchTab === "pitch" ? " on" : "") + '" id="tabPitch">Line-ups</div>' +
      '<div class="tab' + (matchTab === "stats" ? " on" : "") + '" id="tabStats">Stats</div>' +
    '</div>';

  document.getElementById("backBtn").onclick = closeMatch;
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
    list.innerHTML =
      '<div class="empty">XP League<br><br>Coming soon.</div>';
    return;
  }

  if (screen === "challenges") {
    updated.textContent = "";
    list.innerHTML =
      '<div class="empty">Challenges<br><br>' +
      'Daily, weekly and season goals.<br>Coming soon.</div>';
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
      // One league, the whole week.
      const later = new Date(chosenDate);
      later.setDate(later.getDate() + 7);
      matches = await (await fetch(
        "/api/league-fixtures?league=" + fixtureFilter.league.id +
        "&from=" + chosenDate + "&to=" + isoDate(later))).json();
    } else {
      // Everywhere, just the chosen day.
      matches = await (await fetch(
        "/api/fixtures?date=" + chosenDate + "&all=1")).json();
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
      };
    });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(small));
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
