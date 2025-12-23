const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { nanoid } = require("nanoid");

// fetch kompatibel Node 18+ oder fallback auf node-fetch (ESM)
const fetchFn =
  typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : (...args) => import("node-fetch").then(({ default: fetch }) => fetch(...args));

const app = express();
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

const rooms = {};

// ----------------- PARSING (Google Doc table) -----------------
function stripHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/li>/gi, "\n")
    .replace(/<li>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function extractPricesFromText(text) {
  const t = String(text || "");
  const matches = t.match(/\d{1,4}[.,]\d{2}/g) || [];
  return matches
    .map(m => parseFloat(m.replace(",", ".")))
    .filter(n => Number.isFinite(n));
}

function parseGoogleDocTableToGames(html) {
  const rows = String(html || "").match(/<tr[\s\S]*?<\/tr>/gi) || [];
  const games = [];

  for (const rowHtml of rows) {
    const cells = [...rowHtml.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map(m => stripHtml(m[1]));

    if (!cells.length) continue;

    const name = (cells[0] || "").trim();
    if (!name) continue;

    const upper = name.toUpperCase();
    if (upper === "NAME" || upper.includes("LAN PARTY") || upper.includes("SPIELE")) continue;

    const priceCell = (cells[1] || "").trim();
    const prices = extractPricesFromText(priceCell);

    let normalPrice = null;
    let salePrice = null;

    if (prices.length >= 1) {
      normalPrice = Math.max(...prices);
      salePrice = prices.length >= 2 ? Math.min(...prices) : null;
      if (salePrice !== null && salePrice === normalPrice) salePrice = null;
    }

    games.push({
      id: nanoid(8),
      name,
      imageUrl: "",
      normalPrice,
      salePrice
    });
  }

  const seen = new Set();
  return games.filter(g => {
    const k = g.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function isGoogleDocAnyLink(link) {
  return /https?:\/\/docs\.google\.com\/document\//i.test(String(link || ""));
}

function normalizeGoogleDocToHtmlUrl(link) {
  const s = String(link || "").trim();
  if (/\/document\/d\/e\//i.test(s) && /\/pub/i.test(s)) return s;

  const m = s.match(/\/document\/d\/([a-zA-Z0-9_-]+)/i);
  if (m) {
    const docId = m[1];
    return `https://docs.google.com/document/d/${docId}/export?format=html`;
  }
  return s;
}

async function loadGamesFromDocLink(link) {
  const url = String(link || "").trim();
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    throw new Error("Link muss mit http(s) starten");
  }
  if (!isGoogleDocAnyLink(url)) {
    throw new Error("Bitte einen Google-Doc Link einfügen");
  }

  const htmlUrl = normalizeGoogleDocToHtmlUrl(url);
  const r = await fetchFn(htmlUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error("Doc konnte nicht geladen werden (Freigabe prüfen).");

  const html = await r.text();
  const games = parseGoogleDocTableToGames(html);
  if (games.length < 2) throw new Error("Zu wenig Spiele erkannt (Tabelle: NAME + PREIS).");
  return games;
}

// ----------------- STEAM AUTO COVER (NO API KEY) -----------------
const steamCoverCache = new Map();

function normalizeForSteamSearch(name) {
  return String(name || "")
    .replace(/[:™®©]/g, "")
    .replace(/\b(definitive|ultimate|complete|edition|goty)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchSteamCover(gameName) {
  const key = String(gameName || "").toLowerCase();
  if (steamCoverCache.has(key)) return steamCoverCache.get(key);

  try {
    const q = encodeURIComponent(normalizeForSteamSearch(gameName));
    const searchUrl = `https://store.steampowered.com/search/?term=${q}`;

    const r = await fetchFn(searchUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) {
      steamCoverCache.set(key, "");
      return "";
    }

    const html = await r.text();
    const match = html.match(/data-ds-appid="(\d+)"/);
    if (!match) {
      steamCoverCache.set(key, "");
      return "";
    }

    const appId = match[1];
    const img = `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`;
    steamCoverCache.set(key, img);
    return img;
  } catch {
    steamCoverCache.set(key, "");
    return "";
  }
}

async function enrichGamesWithSteamCovers(games) {
  const out = [];
  for (let i = 0; i < games.length; i += 4) {
    const chunk = games.slice(i, i + 4);
    const enriched = await Promise.all(chunk.map(async g => {
      if (g.imageUrl) return g;
      const img = await fetchSteamCover(g.name);
      return { ...g, imageUrl: img || "" };
    }));
    out.push(...enriched);
  }
  return out;
}

// ----------------- TOURNAMENT (1v1 sequential) -----------------
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

function buildRoundMatchesFromIds(ids, round) {
  const list = [...ids];
  shuffleInPlace(list);
  if (list.length % 2 === 1) list.push("BYE");

  const matches = [];
  for (let i = 0; i < list.length; i += 2) {
    const aId = list[i];
    const bId = list[i + 1];
    const id = `R${round}-M${i / 2 + 1}`;

    if (bId === "BYE") {
      matches.push({ id, aId, bId, votes: {}, winnerId: aId, note: "Freilos (BYE)" });
    } else {
      matches.push({ id, aId, bId, votes: {}, winnerId: null, note: "" });
    }
  }
  return matches;
}

function startNewTournament(room) {
  if (room.pool.length < 2) {
    room.tournament = null;
    return;
  }

  const ids = room.pool.map(g => g.id);
  room.tournament = {
    round: 1,
    matches: buildRoundMatchesFromIds(ids, 1),
    currentMatchIdx: 0
  };

  advanceToNextUndecidedMatch(room);
}

function advanceToNextUndecidedMatch(room) {
  const t = room.tournament;
  if (!t) return;
  while (t.currentMatchIdx < t.matches.length && t.matches[t.currentMatchIdx].winnerId) {
    t.currentMatchIdx++;
  }
}

function allPlayersVoted(room, match) {
  const ids = Object.keys(room.players);
  if (!ids.length) return false;
  return ids.every(pid => match.votes[pid] === "A" || match.votes[pid] === "B");
}

function decideMatchWinner(room, match) {
  const votes = Object.values(match.votes);
  const a = votes.filter(v => v === "A").length;
  const b = votes.filter(v => v === "B").length;

  match.note = `Votes A:${a} / B:${b}`;

  if (a > b) {
    match.winnerId = match.aId;
    return { tie: false, coin: null };
  }
  if (b > a) {
    match.winnerId = match.bId;
    return { tie: false, coin: null };
  }

  const coin = Math.random() < 0.5 ? "Kopf" : "Zahl";
  match.winnerId = coin === "Kopf" ? match.aId : match.bId;

  // ✅ Flash message for UI
  const winnerGame = getGameById(room, match.winnerId);
  room.flash = {
    id: nanoid(8),
    text: `Unentschieden → ${coin}: Gewinner ist ${winnerGame ? winnerGame.name : "?"}`,
    ts: Date.now()
  };

  match.note += ` | Unentschieden -> ${coin}`;
  return { tie: true, coin };
}

function finishRoundIfDone(room) {
  const t = room.tournament;
  if (!t) return;

  if (!t.matches.every(m => m.winnerId)) return;

  const winners = t.matches.map(m => m.winnerId).filter(id => id && id !== "BYE");

  // Champion gefunden
  if (winners.length === 1) {
    const champId = winners[0];
    const champ = room.pool.find(g => g.id === champId);
    if (champ) {
      room.selected.push(champ);
      room.pool = room.pool.filter(g => g.id !== champId);
    }

    room.tournament = null;

    if (room.selected.length < room.targetWinners && room.pool.length >= 2) {
      startNewTournament(room);
    }
    return;
  }

  // nächste Runde
  t.round += 1;
  t.matches = buildRoundMatchesFromIds(winners, t.round);
  t.currentMatchIdx = 0;
  advanceToNextUndecidedMatch(room);
}

// ----------------- IMAGE PROXY -----------------
app.get("/img", async (req, res) => {
  try {
    const url = String(req.query.url || "");
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      return res.status(400).send("Bad url");
    }

    const r = await fetchFn(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
      }
    });

    if (!r.ok) return res.status(r.status).send("Fetch failed");

    res.setHeader("Content-Type", r.headers.get("content-type") || "image/jpeg");
    res.setHeader("Cache-Control", "public, max-age=86400");

    const buf = Buffer.from(await r.arrayBuffer());
    res.send(buf);
  } catch {
    res.status(500).send("Proxy error");
  }
});

// ----------------- STATE TO CLIENT (send current games + live vote status + flash) -----------------
function getGameById(room, id) {
  return room.pool.find(g => g.id === id) || room.selected.find(g => g.id === id) || null;
}

function publicRoomState(room) {
  const t = room.tournament;

  let currentMatch = null;
  let currentA = null;
  let currentB = null;
  let voteStatus = [];
  let voteCounts = { A: 0, B: 0 };

  if (t && t.currentMatchIdx < t.matches.length) {
    const m = t.matches[t.currentMatchIdx];
    if (m && !m.winnerId) {
      currentMatch = { id: m.id, note: m.note || "" };
      currentA = getGameById(room, m.aId);
      currentB = getGameById(room, m.bId);

      const players = Object.entries(room.players).map(([pid, p]) => ({
        pid,
        name: p.name || "Spieler"
      }));

      voteStatus = players.map(p => ({
        name: p.name,
        pick: m.votes[p.pid] || null
      }));

      const picks = Object.values(m.votes);
      voteCounts = {
        A: picks.filter(x => x === "A").length,
        B: picks.filter(x => x === "B").length
      };
    }
  }

  // ✅ flash for ~5 seconds
  const flash = room.flash && (Date.now() - room.flash.ts < 5000)
    ? room.flash
    : null;

  return {
    adminId: room.adminId,
    players: Object.values(room.players).map(p => ({ name: p.name })),
    targetWinners: room.targetWinners,
    selectedCount: room.selected.length,
    poolCount: room.pool.length,
    selected: room.selected,
    flash,
    tournament: t ? {
      round: t.round,
      matchNumber: Math.min(t.currentMatchIdx + 1, t.matches.length),
      matchTotal: t.matches.length,
      currentMatch,
      currentA,
      currentB,
      voteStatus,
      voteCounts
    } : null,
    done: room.selected.length >= room.targetWinners || room.pool.length < 2
  };
}

// ----------------- SOCKET.IO -----------------
io.on("connection", (socket) => {
  socket.on("room:create", ({ roomCode, name }) => {
    const code = (roomCode || "").trim().toUpperCase();
    if (!code) return socket.emit("errorMsg", "Room-Code fehlt.");

    rooms[code] = {
      adminId: socket.id,
      players: { [socket.id]: { name: name || "Admin" } },
      link: "",
      targetWinners: 5,
      pool: [],
      selected: [],
      tournament: null,
      flash: null
    };

    socket.join(code);
    io.to(code).emit("room:update", publicRoomState(rooms[code]));
  });

  socket.on("room:join", ({ roomCode, name }) => {
    const code = (roomCode || "").trim().toUpperCase();
    const room = rooms[code];
    if (!room) return socket.emit("errorMsg", "Room nicht gefunden.");

    room.players[socket.id] = { name: name || "Spieler" };
    socket.join(code);
    io.to(code).emit("room:update", publicRoomState(room));
  });

  socket.on("admin:loadFromLink", async ({ roomCode, link, targetWinners }) => {
    try {
      const code = (roomCode || "").trim().toUpperCase();
      const room = rooms[code];
      if (!room) return;
      if (room.adminId !== socket.id) return socket.emit("errorMsg", "Nur Admin darf das.");

      const target = parseInt(targetWinners, 10);
      room.targetWinners = Number.isFinite(target) && target > 0 ? target : 5;

      room.link = String(link || "").trim();

      let games = await loadGamesFromDocLink(room.link);
      games = await enrichGamesWithSteamCovers(games);

      room.selected = [];
      room.pool = games;
      room.tournament = null;
      room.flash = null;

      startNewTournament(room);

      io.to(code).emit("room:update", publicRoomState(room));
    } catch (e) {
      socket.emit("errorMsg", "Fehler beim Import: " + e.message);
    }
  });

  socket.on("vote", ({ roomCode, pick }) => {
    const code = (roomCode || "").trim().toUpperCase();
    const room = rooms[code];
    if (!room || !room.tournament) return;

    const t = room.tournament;
    const match = t.matches[t.currentMatchIdx];
    if (!match || match.winnerId) return;

    if (!room.players[socket.id]) return;
    if (pick !== "A" && pick !== "B") return;

    match.votes[socket.id] = pick;

    if (allPlayersVoted(room, match)) {
      decideMatchWinner(room, match);
      t.currentMatchIdx += 1;
      advanceToNextUndecidedMatch(room);
      finishRoundIfDone(room);
    }

    io.to(code).emit("room:update", publicRoomState(room));
  });

  socket.on("disconnect", () => {
    for (const [code, room] of Object.entries(rooms)) {
      if (room.players[socket.id]) {
        delete room.players[socket.id];
        if (room.adminId === socket.id) {
          const first = Object.keys(room.players)[0];
          room.adminId = first || null;
        }
        io.to(code).emit("room:update", publicRoomState(room));
      }
    }
  });
});

server.listen(PORT, () => console.log("Server läuft auf Port", PORT));
