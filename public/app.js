const socket = io();
const $ = (id) => document.getElementById(id);

let roomCode = "";
let lastFlashId = null;
let flashTimer = null;

$("create").onclick = () => {
  const name = $("name").value.trim() || "Admin";
  roomCode = $("room").value.trim().toUpperCase();
  const roomName = $("roomName").value.trim();
  const password = $("roomPw").value;
  socket.emit("room:create", { roomCode, roomName, name, password });
};

$("join").onclick = () => {
  const name = $("name").value.trim() || "Spieler";
  roomCode = $("room").value.trim().toUpperCase();
  const password = $("roomPw").value;
  socket.emit("room:join", { roomCode, name, password });
};

$("refreshRooms").onclick = () => socket.emit("rooms:get");

$("loadFromLink").onclick = () => {
  const link = $("pubLink").value.trim();
  const targetWinners = $("targetWinners").value;
  socket.emit("admin:loadFromLink", { roomCode, link, targetWinners });
};

$("voteA").onclick = () => socket.emit("vote", { roomCode, pick: "A" });
$("voteB").onclick = () => socket.emit("vote", { roomCode, pick: "B" });

socket.on("errorMsg", (t) => ($("msg").textContent = t));

socket.on("rooms:list", (rooms) => {
  renderRoomsList(rooms || []);
});

socket.on("room:update", (state) => {
  $("msg").textContent = `Im Room: ${roomCode || ""} ${state.locked ? "🔒" : ""}`;

  const isAdmin = state.adminId && state.adminId === socket.id;
  $("adminPanel").style.display = isAdmin ? "block" : "none";

  $("status").style.display = "block";
  $("selectedCard").style.display = "block";

  const target = state.targetWinners || 5;
  const selected = state.selectedCount || 0;

  $("progress").textContent = `Ausgewählt: ${selected}/${target}  |  Rest im Pool: ${state.poolCount}`;
  $("players").textContent = `Spieler: ${state.players.map((p) => p.name).join(", ")}`;

  if (state.tournament) {
    $("roundInfo").textContent = `Runde ${state.tournament.round} • Match ${state.tournament.matchNumber}/${state.tournament.matchTotal}`;
  } else {
    $("roundInfo").textContent = `Kein aktuelles Turnier`;
  }

  renderSelected(state.selected || []);
  showFlash(state.flash);

  if (state.tournament && state.tournament.currentMatch && state.tournament.currentA && state.tournament.currentB) {
    $("matchCard").style.display = "block";
    renderTeam("teamA", "A", state.tournament.currentA);
    renderTeam("teamB", "B", state.tournament.currentB);
    renderVoteStatus(state.tournament.voteStatus || []);
    $("matchHint").textContent = `Voten ist anonym (man sieht nur ✅/⏳). Trailer/Steam öffnen neuen Tab.`;
    $("voteA").disabled = false;
    $("voteB").disabled = false;
  } else {
    $("matchCard").style.display = "none";
    $("voteA").disabled = true;
    $("voteB").disabled = true;
  }

  $("doneHint").textContent = state.done
    ? "Fertig. Ziel erreicht (oder nicht genug Spiele übrig)."
    : "Läuft… Gewinner werden automatisch gesammelt (ohne Wiederholungen).";
});

function renderRoomsList(list) {
  const box = $("roomsList");
  if (!list.length) {
    box.innerHTML = `<div class="hint">Keine Rooms aktiv.</div>`;
    return;
  }

  box.innerHTML = list
    .map((r) => {
      const lock = r.locked ? "🔒" : "🔓";
      const names = (r.players || []).slice(0, 4).join(", ") + ((r.players || []).length > 4 ? "…" : "");
      return `
        <div class="roomRow">
          <div class="roomLeft">
            <div class="roomTitle">${escapeHtml(r.name || r.code)} <span class="roomCode">(${escapeHtml(r.code)})</span> ${lock}</div>
            <div class="roomMeta">${r.playerCount} Spieler • ${escapeHtml(names)}</div>
          </div>
          <div class="roomRight">
            <button class="joinBtn" data-code="${escapeHtml(r.code)}" data-locked="${r.locked ? "1" : "0"}">Join</button>
          </div>
        </div>
      `;
    })
    .join("");

  for (const btn of box.querySelectorAll(".joinBtn")) {
    btn.onclick = () => {
      const code = btn.getAttribute("data-code");
      const locked = btn.getAttribute("data-locked") === "1";
      roomCode = String(code || "").toUpperCase();
      $("room").value = roomCode;

      const name = $("name").value.trim() || "Spieler";
      const pw = $("roomPw").value;

      if (locked && !pw) {
        $("msg").textContent = "Dieser Room ist 🔒 — bitte Passwort oben eingeben, dann erneut Join drücken.";
        return;
      }
      socket.emit("room:join", { roomCode, name, password: pw });
    };
  }
}

function showFlash(flash) {
  const box = $("flash");
  if (!flash || !flash.id || !flash.text) return;
  if (flash.id === lastFlashId) return;
  lastFlashId = flash.id;

  box.textContent = flash.text;
  box.style.display = "block";
  box.classList.remove("flashIn");
  void box.offsetWidth;
  box.classList.add("flashIn");

  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => (box.style.display = "none"), 4200);
}

function renderVoteStatus(list) {
  const box = $("voteStatus");
  if (!list.length) return (box.innerHTML = "");
  box.innerHTML = list
    .map((p) => {
      const cls = p.voted ? "voted" : "pending";
      const label = p.voted ? "✅" : "⏳";
      return `<div class="pill ${cls}">${escapeHtml(p.name)} <span class="pillPick">${label}</span></div>`;
    })
    .join("");
}

// ✅ Link helpers (no API)
function youtubeTrailerUrl(gameName) {
  const q = encodeURIComponent(`${gameName} official trailer`);
  return `https://www.youtube.com/results?search_query=${q}`;
}
function steamStoreSearchUrl(gameName) {
  const q = encodeURIComponent(String(gameName || "").trim());
  return `https://store.steampowered.com/search/?term=${q}`;
}

function euro(x) {
  return `${x.toFixed(2).replace(".", ",")} €`;
}

function formatPrice(g) {
  const n = g.normalPrice;
  const s = g.salePrice;
  if (typeof n !== "number") return "";
  const nf = euro(n);
  if (typeof s === "number" && s < n) {
    return `<div class="price"><span class="normal">${nf}</span> <span class="sale">${euro(s)}</span></div>`;
  }
  return `<div class="price"><span class="only">${nf}</span></div>`;
}

function renderTeam(elId, label, g) {
  const el = $(elId);
  const img = g.imageUrl
    ? `<img class="cover" src="/img?url=${encodeURIComponent(g.imageUrl)}" alt="" />`
    : `<div class="cover placeholder">No Image</div>`;

  const yt = youtubeTrailerUrl(g.name || "");
  const steam = steamStoreSearchUrl(g.name || "");

  el.innerHTML = `
    <div class="tag">${label}</div>
    ${img}
    <div class="name">${escapeHtml(g.name || "")}</div>
    ${formatPrice(g)}
    <div class="cardActions">
      <a class="btnLink" href="${yt}" target="_blank" rel="noopener noreferrer">YouTube Trailer</a>
      <a class="btnLink" href="${steam}" target="_blank" rel="noopener noreferrer">Steam Store</a>
    </div>
  `;
}

function renderSelected(list) {
  const box = $("selectedList");
  if (!list.length) return (box.innerHTML = `<div class="hint">Noch keine Gewinner ausgewählt…</div>`);

  box.innerHTML = list
    .map((g, idx) => {
      const img = g.imageUrl
        ? `<img class="thumb" src="/img?url=${encodeURIComponent(g.imageUrl)}" alt="" />`
        : `<div class="thumb placeholder">No Image</div>`;

      const yt = youtubeTrailerUrl(g.name || "");
      const steam = steamStoreSearchUrl(g.name || "");

      return `
        <div class="selItem">
          <div class="rank">#${idx + 1}</div>
          ${img}
          <div class="selText">
            <div class="selName">${escapeHtml(g.name || "")}</div>
            ${formatPrice(g)}
            <div class="selActions">
              <a class="btnLink small" href="${yt}" target="_blank" rel="noopener noreferrer">YouTube Trailer</a>
              <a class="btnLink small" href="${steam}" target="_blank" rel="noopener noreferrer">Steam Store</a>
            </div>
          </div>
        </div>
      `;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[c]));
}
