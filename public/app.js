const socket = io();
const $ = (id) => document.getElementById(id);

let roomCode = "";
let lastFlashId = null;
let flashTimer = null;

$("create").onclick = () => {
  const name = $("name").value.trim() || "Admin";
  roomCode = $("room").value.trim().toUpperCase();
  socket.emit("room:create", { roomCode, name });
};

$("join").onclick = () => {
  const name = $("name").value.trim() || "Spieler";
  roomCode = $("room").value.trim().toUpperCase();
  socket.emit("room:join", { roomCode, name });
};

$("loadFromLink").onclick = () => {
  const link = $("pubLink").value.trim();
  const targetWinners = $("targetWinners").value;
  socket.emit("admin:loadFromLink", { roomCode, link, targetWinners });
};

$("voteA").onclick = () => socket.emit("vote", { roomCode, pick: "A" });
$("voteB").onclick = () => socket.emit("vote", { roomCode, pick: "B" });

socket.on("errorMsg", (t) => $("msg").textContent = t);

socket.on("room:update", (state) => {
  $("msg").textContent = `Room: ${roomCode || ""}`;

  const isAdmin = state.adminId && state.adminId === socket.id;
  $("adminPanel").style.display = isAdmin ? "block" : "none";

  $("status").style.display = "block";
  $("selectedCard").style.display = "block";

  const target = state.targetWinners || 5;
  const selected = state.selectedCount || 0;

  $("progress").textContent =
    `Ausgewählt: ${selected}/${target}  |  Rest im Pool: ${state.poolCount}`;

  $("players").textContent = `Spieler: ${state.players.map(p => p.name).join(", ")}`;

  if (state.tournament) {
    $("roundInfo").textContent =
      `Runde ${state.tournament.round} • Match ${state.tournament.matchNumber}/${state.tournament.matchTotal}`;
  } else {
    $("roundInfo").textContent = `Kein aktuelles Turnier`;
  }

  renderSelected(state.selected || []);

  // ✅ Flash for tie
  showFlash(state.flash);

  if (state.tournament && state.tournament.currentMatch && state.tournament.currentA && state.tournament.currentB) {
    $("matchCard").style.display = "block";

    renderTeam("teamA", "A", state.tournament.currentA);
    renderTeam("teamB", "B", state.tournament.currentB);

    const vc = state.tournament.voteCounts || { A: 0, B: 0 };
    $("countA").textContent = vc.A ?? 0;
    $("countB").textContent = vc.B ?? 0;

    renderVoteStatus(state.tournament.voteStatus || []);

    $("matchHint").textContent = `Wählt A oder B. Bei Gleichstand entscheidet Kopf/Zahl (wird eingeblendet).`;
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

function showFlash(flash) {
  const box = $("flash");
  if (!flash || !flash.id || !flash.text) return;

  // nur neu anzeigen, wenn neue ID
  if (flash.id === lastFlashId) return;
  lastFlashId = flash.id;

  box.textContent = flash.text;
  box.style.display = "block";
  box.classList.remove("flashIn");
  void box.offsetWidth; // reflow for animation
  box.classList.add("flashIn");

  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    box.style.display = "none";
  }, 4200);
}

function renderVoteStatus(list) {
  const box = $("voteStatus");
  if (!list.length) {
    box.innerHTML = "";
    return;
  }
  box.innerHTML = list.map(p => {
    const cls = p.pick ? "voted" : "pending";
    const label = p.pick === "A" ? "✅ A" : p.pick === "B" ? "✅ B" : "⏳";
    return `<div class="pill ${cls}">${escapeHtml(p.name)} <span class="pillPick">${label}</span></div>`;
  }).join("");
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

  el.innerHTML = `
    <div class="tag">${label}</div>
    ${img}
    <div class="name">${escapeHtml(g.name || "")}</div>
    ${formatPrice(g)}
  `;
}

function renderSelected(list) {
  const box = $("selectedList");
  if (!list.length) {
    box.innerHTML = `<div class="hint">Noch keine Gewinner ausgewählt…</div>`;
    return;
  }
  box.innerHTML = list.map((g, idx) => {
    const img = g.imageUrl
      ? `<img class="thumb" src="/img?url=${encodeURIComponent(g.imageUrl)}" alt="" />`
      : `<div class="thumb placeholder">No Image</div>`;

    return `
      <div class="selItem">
        <div class="rank">#${idx + 1}</div>
        ${img}
        <div class="selText">
          <div class="selName">${escapeHtml(g.name || "")}</div>
          ${formatPrice(g)}
        </div>
      </div>
    `;
  }).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
  }[c]));
}
