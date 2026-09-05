// ============================================================================
//  Band Admin - hoofdapplicatie
//  Simpele SPA: view-switching, auth, dashboard, song view (met chord-rendering,
//  instrument-filter, notities en pageturner-support) en de song editor.
// ============================================================================

import { login, logout, watchAuth, friendlyAuthError } from "./auth.js";
import {
  getAllSongs,
  getSong,
  createSong,
  updateSong,
  deleteSong,
  setSongInPicker,
  addNote,
  removeNote,
  updateNote,
  saveContent,
  newId,
  getUserProfile,
  setUserProfile,
  getDrawing,
  saveDrawing,
  getAllSetlists,
  getSetlist,
  createSetlist,
  updateSetlist,
  deleteSetlist,
  getChord,
  getAllChords,
  setChord,
  deleteChord,
  getPianoChord,
  getAllPianoChords,
  setPianoChord,
  deletePianoChord,
  setPresence,
  clearPresence,
  watchPresence,
  setCurrentPractice,
  watchPractice,
  setRequiredMembers,
  watchRequiredMembers,
  startSession,
  updateSession,
  endSession,
  watchSession,
  createTodo,
  updateTodoDoc,
  deleteTodoDoc,
  watchTodos,
} from "./firestore.js";
import { parseSongText, serializeLines, renderLine, sectionLabel, transposeChordName } from "./song-format.js";
import { pdfToText } from "./pdf-import.js";
import { renderChordSVG, showChordModal, hideChordModal } from "./chord-diagram.js";
import { renderPianoChordSVG, chordToNotes, chordVoicing, pitchClassName } from "./piano-chord.js";
import { EXAMPLE_CHORDS } from "./seed-data.js";

// ---------------------------------------------------------------------------
//  Applicatiestatus
// ---------------------------------------------------------------------------
const state = {
  user: null,
  songs: [],          // dashboardcache
  currentSong: null,  // volledig geladen liedje in de song view
  instrument: "all",  // actief instrument-filter in de song view
  myInstrument: "general", // welk instrument deze gebruiker speelt (profiel)
  footswitch: false,  // voetschakelaar-modus aan/uit
  autoscroll: false,  // autoscroll-modus aan/uit (blauwe knop = start/stop)
  editingId: null,    // id van het liedje in de editor (null = nieuw)
  // Globale instellingen (uit userSettings/localStorage):
  settings: {
    readingMode: "footswitch", // "footswitch" | "autoscroll" — modus leespagina
    scrollButtonPosition: "left", // "left" | "right" — positie zwevende scrollknop
    enableDrawMode: true,      // canvas-tekenmodus aan/uit
    rehearsing: false,         // "ik ben aan het repeteren" → ontvang oefenkeuzes
    chordDisplay: "guitar",    // "guitar" | "piano" — wat toon je bij klik op een akkoord
    theme: "dark",             // "dark" (donker/goud) | "light" (origineel)
  },
  // Setlist management:
  currentSetlist: null,        // geladen setlist-document (id, name, date, songIds)
  setlists: [],                // alle setlists (gedeeld met de band)
  setlistSongIds: [],          // werk-kopie van de volgorde in de planner
  setlistDirty: false,         // niet-opgeslagen wijzigingen in de planner
  perform: null,               // { songIds:[...], index } bij navigeren vanuit een setlist
  atSongEnd: false,            // live-modus: einde liedje bereikt → volgende klik = volgend nummer
  chordCache: {},              // lokale cache van opgehaalde gitaargrepen (key = akkoordnaam)
  pianoChordCache: {},         // lokale cache van aangepaste piano-akkoorden (key = akkoordnaam)
  // Aanwezigheid & oefenkeuze (realtime):
  presenceList: [],            // laatste snapshot van presence-documenten
  presenceTimer: null,         // heartbeat-interval
  presenceUnsub: null,         // unsubscribe presence-listener
  practiceUnsub: null,         // unsubscribe practice-listener
  todosUnsub: null,            // unsubscribe todos-listener
  practiceSongs: [],           // liedjes waaruit de roulette kiest
  lastPracticeNonce: null,     // nonce van de laatst geziene/verzonden keuze
  requiredMembers: [],         // [{ uid, name }] bandleden die verplicht meedoen
  requiredUnsub: null,         // unsubscribe van de required-members-listener
  // Setlist-sessie (realtime afspelen, beheerd door alle deelnemers):
  session: null,               // actieve sessie-document of null
  sessionUnsub: null,          // unsubscribe van de session-listener
};

const INSTRUMENTS = [
  { key: "all", label: "Alle" },
  { key: "general", label: "Algemeen" },
  { key: "drums", label: "Drums" },
  { key: "guitar", label: "Gitaar 1" },
  { key: "guitar2", label: "Gitaar 2" },
  { key: "guitar3", label: "Gitaar 3" },
  { key: "bass", label: "Bas" },
  { key: "keys", label: "Toetsen" },
  { key: "vocals", label: "Zang" },
];

const $ = (sel) => document.querySelector(sel);

// ---------------------------------------------------------------------------
//  Netwerkstatus-indicator (Online / Offline modus)
// ---------------------------------------------------------------------------
function updateNetStatus() {
  const el = $("#netStatus");
  if (!el) return;
  if (navigator.onLine) {
    el.textContent = "● Online";
    el.className = "text-xs px-2 py-0.5 rounded-full whitespace-nowrap bg-green-100 text-green-700";
  } else {
    el.textContent = "● Offline modus";
    el.className = "text-xs px-2 py-0.5 rounded-full whitespace-nowrap bg-amber-100 text-amber-700";
  }
}
window.addEventListener("online", updateNetStatus);
window.addEventListener("offline", updateNetStatus);
updateNetStatus();

// ---------------------------------------------------------------------------
//  PWA: registreer de service worker (maakt de app installeerbaar + offline)
// ---------------------------------------------------------------------------
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/sw.js")
      .catch((e) => console.error("Service worker-registratie mislukt:", e));
  });

  // Zodra een nieuwe service worker het overneemt (na een deploy), herlaad de
  // pagina één keer automatisch, zodat je niet handmatig hoeft te verversen.
  let refreshing = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (refreshing) return;
    refreshing = true;
    window.location.reload();
  });
}

// ---------------------------------------------------------------------------
//  Router: toon één view en verberg de rest
// ---------------------------------------------------------------------------
function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $(`#view-${name}`).classList.add("active");
  // Topbar-knoppen per view
  $("#topSave").classList.toggle("hidden", name !== "editor" && name !== "setlist");
  $("#topCancelEdit").classList.toggle("hidden", name !== "editor" && name !== "song" && name !== "settings" && name !== "setlist" && name !== "todo" && name !== "chords" && name !== "piano-chords" && name !== "practice");
  $("#topFootswitch").classList.add("hidden");
  $("#topAutoscroll").classList.add("hidden");
  $("#netStatus").classList.toggle("hidden", name !== "dashboard");
  $("#userEmail").style.display = (name !== "dashboard") ? "none" : "";
  $("#logoutBtn").classList.toggle("hidden", name !== "dashboard");
  // Voetschakelaar/autoscroll alleen relevant in de song view.
  if (name !== "song") {
    disableFootswitch();
    stopAutoScroll();
    // Live-modus-context geldt alleen binnen de song view.
    state.perform = null;
    state.atSongEnd = false;
  }
  window.scrollTo({ top: 0 });
}

// ---------------------------------------------------------------------------
//  History-navigatie (Android/iOS terugknop)
//  Elke view-overgang wordt in de browsergeschiedenis vastgelegd, zodat de
//  terugknop naar de vorige pagina gaat in plaats van de app te sluiten.
// ---------------------------------------------------------------------------

/** Vooruit-navigeren: leg de overgang vast in de geschiedenis en open de view. */
function navigate(desc, open) {
  history.pushState(desc, "");
  return open();
}

/** Vervang de huidige geschiedenis-entry (voor "flow"-overgangen zoals opslaan
 *  of vorig/volgend binnen een setlist, die geen extra terugstap mogen maken). */
function replaceView(desc, open) {
  history.replaceState(desc, "");
  return open();
}

/** Heropen een view op basis van een geschiedenis-descriptor (terug-navigatie). */
function routeTo(desc) {
  if (!desc || !desc.view) return;
  // Beveiliging: geen app-views tonen als er niemand is ingelogd.
  if (!state.user && desc.view !== "login") {
    showView("login");
    return;
  }
  switch (desc.view) {
    case "dashboard": openDashboard(); break;
    case "song": openSong(desc.id, desc.perform); break;
    case "editor": openEditor(desc.id); break;
    case "settings": openSettings(); break;
    case "setlist": openSetlist(); break;
    case "todo": openTodo(); break;
    case "chords": openChords(); break;
    case "piano-chords": openPianoChords(); break;
    case "practice": openPractice(); break;
  }
}

// De Android/iOS-terugknop (of browser-terug) herstelt de vorige view.
window.addEventListener("popstate", (e) => routeTo(e.state));

// ===========================================================================
//  AUTHENTICATIE
// ===========================================================================
watchAuth(async (user) => {
  const prevUid = state.user?.uid;
  state.user = user;
  if (user) {
    $("#topbar").classList.remove("hidden");
    $("#userEmail").textContent = user.email;
    await loadMyInstrument(user.uid);
    await loadUserSettings(user.uid);
    startRealtime();  // presence-heartbeat + luisteren naar oefenkeuzes
    // Basis-entry van de geschiedenis vastleggen (geen extra terugstap).
    history.replaceState({ view: "dashboard" }, "");
    openDashboard();
  } else {
    $("#topbar").classList.add("hidden");
    teardownRealtime(prevUid);
    history.replaceState({ view: "login" }, "");
    showView("login");
  }
});

// Profiel van de ingelogde gebruiker: welk instrument speelt hij/zij?
async function loadMyInstrument(uid) {
  try {
    const profile = await getUserProfile(uid);
    if (profile?.instrument) state.myInstrument = profile.instrument;
  } catch (ex) {
    console.error(ex);
  }
  $("#myInstrument").value = state.myInstrument;
}

$("#myInstrument").addEventListener("change", async (e) => {
  state.myInstrument = e.target.value;
  try {
    await setUserProfile(state.user.uid, { instrument: state.myInstrument });
    const saved = $("#myInstrumentSaved");
    saved.classList.remove("hidden");
    setTimeout(() => saved.classList.add("hidden"), 1500);
  } catch (ex) {
    console.error(ex);
    alert("Kon je instrument niet opslaan.");
  }
});

$("#loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#loginError");
  err.classList.add("hidden");
  try {
    await login($("#loginEmail").value.trim(), $("#loginPassword").value);
    // watchAuth() regelt de navigatie na succesvol inloggen.
  } catch (ex) {
    err.textContent = friendlyAuthError(ex.code);
    err.classList.remove("hidden");
  }
});

$("#logoutBtn").addEventListener("click", () => logout());
$("#brand").addEventListener("click", () => navigate({ view: "dashboard" }, openDashboard));
$("#dashboardSetlistBtn").addEventListener("click", () => navigate({ view: "setlist" }, openSetlist));

// ===========================================================================
//  DASHBOARD
// ===========================================================================
async function openDashboard() {
  showView("dashboard");
  $("#songList").innerHTML = `<p class="text-gray-400 py-6">Laden…</p>`;
  try {
    state.songs = await getAllSongs();
    renderSongList(state.songs);
  } catch (ex) {
    console.error(ex);
    $("#songList").innerHTML =
      `<p class="text-red-600 py-6">Kon liedjes niet laden. Controleer je Firebase-configuratie en -regels.</p>`;
  }
}

function renderSongList(songs) {
  const list = $("#songList");
  const empty = $("#songListEmpty");
  list.innerHTML = "";
  if (!songs.length) {
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  for (const song of songs) {
    const card = document.createElement("div");
    card.className =
      "bg-white rounded-xl shadow-sm hover:shadow-md transition flex items-center";

    const picker = document.createElement("button");
    picker.type = "button";
    picker.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onTogglePicker(song, picker);
    });
    applyPickerState(picker, song.inPicker !== false);

    const open = document.createElement("button");
    open.className = "flex-1 text-left pl-2 pr-4 py-4 flex items-center justify-between min-w-0";
    open.innerHTML = `
      <div class="min-w-0">
        <div class="font-semibold truncate">${escapeHtml(song.title || "(zonder titel)")}</div>
        <div class="text-sm text-gray-500 truncate">${escapeHtml(song.artist || "")}</div>
      </div>
      <span class="text-gray-300 ml-2">&rsaquo;</span>`;
    open.addEventListener("click", () => navigate({ view: "song", id: song.id }, () => openSong(song.id)));

    const del = document.createElement("button");
    del.className = "shrink-0 px-4 py-4 text-gray-300 hover:text-red-600";
    del.textContent = "🗑";
    del.title = "Liedje verwijderen";
    del.addEventListener("click", () => onDeleteSongFromList(song));

    card.appendChild(picker);
    card.appendChild(open);
    card.appendChild(del);
    list.appendChild(card);
  }
}

/** Kleur/tooltip van de liedjeskiezer-knop bijwerken op basis van de staat. */
function applyPickerState(btn, inPicker) {
  btn.className =
    "shrink-0 pl-4 pr-2 py-4 text-sm leading-none transition " +
    (inPicker ? "text-amber-500 hover:text-amber-600" : "text-gray-400");
  if (inPicker) {
    btn.textContent = "🎲";
  } else {
    // Uit: gedimde dobbelsteen met een rood kruisje erdoorheen. Inline styles
    // zodat het niet afhangt van de (mogelijk gecachete) stylesheet.
    btn.innerHTML =
      '<span style="position:relative;display:inline-block;line-height:1">' +
      '<span style="opacity:0.35">🎲</span>' +
      '<span style="position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);' +
      'color:#ef4444;font-weight:700;font-size:1.3em;line-height:1">✕</span>' +
      "</span>";
  }
  btn.title = inPicker
    ? "In liedjeskiezer — klik om uit te zetten"
    : "Niet in liedjeskiezer — klik om aan te zetten";
  btn.setAttribute("aria-pressed", String(inPicker));
}

/** Zet subtiel aan/uit of dit liedje meedoet in de liedjeskiezer. */
async function onTogglePicker(song, btn) {
  const next = song.inPicker === false; // false → aanzetten, anders uitzetten
  song.inPicker = next;
  applyPickerState(btn, next);
  try {
    await setSongInPicker(song.id, next);
  } catch (ex) {
    console.error(ex);
    alert("Wijzigen mislukt.");
    song.inPicker = !next;
    applyPickerState(btn, !next);
  }
}

async function onDeleteSongFromList(song) {
  if (!confirm(`"${song.title || "dit liedje"}" definitief verwijderen?`)) return;
  try {
    await deleteSong(song.id);
    state.songs = state.songs.filter((s) => s.id !== song.id);
    // Herteken met het huidige zoekfilter toegepast.
    const term = $("#songSearch").value.toLowerCase().trim();
    renderSongList(
      state.songs.filter(
        (s) =>
          (s.title || "").toLowerCase().includes(term) ||
          (s.artist || "").toLowerCase().includes(term)
      )
    );
  } catch (ex) {
    console.error(ex);
    alert("Verwijderen mislukt.");
  }
}

$("#songSearch").addEventListener("input", (e) => {
  const term = e.target.value.toLowerCase().trim();
  const filtered = state.songs.filter(
    (s) =>
      (s.title || "").toLowerCase().includes(term) ||
      (s.artist || "").toLowerCase().includes(term)
  );
  renderSongList(filtered);
});

$("#newSongBtn").addEventListener("click", () => navigate({ view: "editor", id: null }, () => openEditor(null)));

// ===========================================================================
//  SONG VIEW
// ===========================================================================

/**
 * Geef de muzieklink van een liedje. Oudere documenten bewaarden de link nog
 * onder het veld `youtubeUrl` (of `youtube`); die lezen we hier ook mee, zodat
 * bestaande liedjes hun link niet kwijtraken na de omschakeling naar Spotify.
 */
function songLink(song) {
  return song.spotifyUrl || song.youtubeUrl || song.youtube || "";
}

async function openSong(id, perform = null) {
  showView("song");
  state.perform = perform;  // setlist-context (null = normaal geopend liedje)
  state.atSongEnd = false;  // nieuw liedje: nog niet aan het einde
  updateSetlistNav();
  resetDrawing();   // begin met een schone tekenlaag
  stopAutoScroll(); // eventueel lopend autoscroll stoppen; knop bijwerken
  autoIntroDone = false; // nieuw liedje: bij de eerste start weer snelle voorscroll
  $("#songBody").innerHTML = `<p class="text-gray-400">Laden…</p>`;
  const song = await getSong(id);
  if (!song) {
    $("#songBody").innerHTML = `<p class="text-red-600">Liedje niet gevonden.</p>`;
    return;
  }

  // Zorg dat elke sectie een stabiel id heeft (nodig om opmerkingen te koppelen).
  // Niet awaiten: offline zou dat blijven hangen; de sync gebeurt op de achtergrond.
  if (ensureSectionIds(song)) {
    saveContent(song.id, song.content).catch((ex) => console.error(ex));
  }

  state.currentSong = song;
  state.instrument = state.myInstrument; // standaard filteren op eigen instrument
  highlightInstrument(state.instrument);
  $("#generalNoteForm").classList.add("hidden");

  // Lazy preload van gitaargrepen (fire-and-forget, niet blokkerend).
  preloadChords();

  $("#songTitle").textContent = song.title || "";
  $("#songArtist").textContent = song.artist || "";
  const meta = [];
  meta.push(song.capo ? `Capo: ${song.capo}` : "Geen capo");
  if (song.bpm) meta.push(`${song.bpm} BPM`);
  $("#songMeta").textContent = meta.join(" · ");

  // Spotify-link tonen/verbergen
  const sp = songLink(song);
  if (sp) {
    $("#topSpotify").href = sp;
    $("#topSpotify").classList.remove("hidden");
  } else {
    $("#topSpotify").classList.add("hidden");
  }

  refreshSongView();
  loadDrawing(); // laad de tekenlaag voor dit liedje + instrument

  // Stel leesmodus, scrollknop-positie en tekenmodus in volgens de user settings
  applySettingsToUI();

  // In live-modus: check na de layout of het liedje al helemaal past (korte
  // songs zijn dan direct "aan het einde", zodat de eerste pedaaltik doorschuift).
  setTimeout(updateEndArming, 250);
  setTimeout(updateEndArming, 600);
}

// Muzikant-kiezer dropdown in de topbar
function highlightInstrument(inst) {
  document.querySelectorAll("#topInstrumentMenu button").forEach((b) => {
    b.classList.toggle("bg-blue-50", b.dataset.inst === inst);
    b.classList.toggle("text-blue-700", b.dataset.inst === inst);
  });
}

$("#topInstrumentBtn").addEventListener("click", () => {
  const menu = $("#topInstrumentMenu");
  menu.classList.toggle("hidden");
});

$("#topInstrumentMenu").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-inst]");
  if (!btn) return;
  state.instrument = btn.dataset.inst;
  highlightInstrument(state.instrument);
  $("#topInstrumentMenu").classList.add("hidden");
  refreshSongView();
  loadDrawing();
});

// Sluit dropdown bij klik buiten het menu
document.addEventListener("click", (e) => {
  const menu = $("#topInstrumentMenu");
  if (!menu || menu.classList.contains("hidden")) return;
  if (!e.target.closest("#topInstrumentBtn") && !e.target.closest("#topInstrumentMenu")) {
    menu.classList.add("hidden");
  }
});

/** Ken ontbrekende section-ids toe. Retourneert of er iets is gewijzigd. */
function ensureSectionIds(song) {
  let changed = false;
  for (const s of song.content || []) {
    if (!s.id) { s.id = newId(); changed = true; }
  }
  return changed;
}

/** Herteken de algemene notities én de songtekst (met sectie-notities). */
function refreshSongView() {
  renderNotes();
  renderSongBody(state.currentSong);
}

$("#editSongBtn").addEventListener("click", () => {
  if (state.currentSong) navigate({ view: "editor", id: state.currentSong.id }, () => openEditor(state.currentSong.id));
});

// --- Songtekst renderen (akkoorden boven de tekst) -------------------------
function renderSongBody(song) {
  const body = $("#songBody");
  body.innerHTML = "";
  if (!song.content || !song.content.length) {
    body.innerHTML = `<p class="text-gray-400">Nog geen tekst voor dit liedje.</p>`;
    return;
  }
  for (const section of song.content) {
    body.appendChild(renderSection(section, { withNotes: true }));
  }
  invalidateSongLineCache(); // de .song-line-elementen zijn opnieuw opgebouwd
  scheduleFit();
}

// Meerdere pogingen: direct, volgende frame en na korte vertraging (voor het
// geval de layout of het monospace-font nét iets later klaar is).
function scheduleFit() {
  fitAndLayout();
  requestAnimationFrame(fitAndLayout);
  setTimeout(fitAndLayout, 150);
}

// Pas de tekst passend en herschaal daarna de tekenlaag mee.
function fitAndLayout() {
  fitSongBody();
  layoutCanvas();
}

// Schaal ALLE secties met hetzelfde lettertype zodat zelfs de breedste regel
// op de smalste sectie past. Alle letters in het liedje blijven zo even groot.
const BASE_FONT = 16; // px startgrootte
const MIN_FONT = 6;   // px ondergrens
function fitSongBody() {
  const body = $("#songBody");
  if (!body) return;
  const sections = body.querySelectorAll(".song-section");
  if (!sections.length) return;

  // Reset alle secties naar de basisgrootte om te meten.
  sections.forEach((s) => s.style.fontSize = BASE_FONT + "px");

  // Bepaal de slechtste verhouding over alle secties heen.
  let minRatio = 1;
  sections.forEach((section) => {
    section.querySelectorAll(".song-line").forEach((line) => {
      const avail = line.clientWidth;
      if (avail <= 0) return;
      line.querySelectorAll(".chords, .lyrics").forEach((el) => {
        const content = el.scrollWidth;
        if (content > avail) minRatio = Math.min(minRatio, avail / content);
      });
    });
  });

  // Pas dezelfde grootte toe op alle secties.
  if (minRatio < 1) {
    const fontSize = Math.max(MIN_FONT, Math.floor(BASE_FONT * minRatio * 10) / 10);
    sections.forEach((s) => s.style.fontSize = fontSize + "px");
  }
}

// Opnieuw passend maken bij draaien/resizen en zodra het monospace-font geladen is.
let fitTimer = null;
window.addEventListener("resize", () => {
  if (!$("#view-song").classList.contains("active")) return;
  clearTimeout(fitTimer);
  fitTimer = setTimeout(fitAndLayout, 120);
});
if (document.fonts?.ready) {
  document.fonts.ready.then(() => {
    if ($("#view-song").classList.contains("active")) fitAndLayout();
  });
}

// ===========================================================================
//  HANDGESCHREVEN TEKENLAAG (canvas-overlay per gebruiker + instrument)
// ===========================================================================
const drawState = {
  canvas: null,
  ctx: null,
  enabled: false,          // tekenmodus aan/uit
  mode: "pencil",          // "pencil" (potlood), "highlighter" (arceerstift) of "eraser" (gum)
  activeId: null,          // actieve pointer (palm-rejection: één tegelijk)
  last: null,              // laatst getekende punt
  strokePoints: [],        // punten van de huidige streek (voor highlighter)
  savedImageData: null,    // canvas snapshot vóór de huidige streek
  image: null,             // snapshot (HTMLImageElement) voor herschalen
  imageDataUrl: "",        // laatste opgeslagen data-URL
  dpr: 1,
  loadingKey: null,        // om verouderde laad-resultaten te negeren
  saveTimer: null,
};

// Het instrument waarvoor de tekenlaag geldt (bij "Alle" het eigen instrument).
function effectiveInstrument() {
  return state.instrument === "all" ? state.myInstrument : state.instrument;
}

// Stel de penstijl in op basis van de gekozen kleur/modus.
function applyStrokeStyle() {
  const ctx = drawState.ctx;
  if (!ctx) return;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (drawState.mode === "eraser") {
    // Gum: veeg bestaande pixels weg i.p.v. erover te tekenen.
    ctx.globalCompositeOperation = "destination-out";
    ctx.strokeStyle = "rgba(0, 0, 0, 1)"; // kleur maakt niet uit bij wissen
    ctx.lineWidth = 24;
  } else if (drawState.mode === "highlighter") {
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(250, 204, 21, 0.20)"; // felgeel, 20% opacity
    ctx.lineWidth = 16;
  } else {
    // Potlood: dunne, donkere lijn.
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = "rgba(31, 41, 55, 0.95)"; // donkergrijs
    ctx.lineWidth = 3;
  }
}

// Maak het canvas passend op de kaart (met devicePixelRatio) en herteken de
// opgeslagen tekening geschaald naar de huidige grootte.
function layoutCanvas() {
  const card = $("#songCard");
  const canvas = drawState.canvas;
  if (!card || !canvas) return;
  const w = card.clientWidth;
  const h = card.clientHeight;
  if (w === 0 || h === 0) return;

  const dpr = window.devicePixelRatio || 1;
  drawState.dpr = dpr;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  canvas.width = Math.round(w * dpr);   // reset + wist het canvas
  canvas.height = Math.round(h * dpr);

  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // tekenen in CSS-pixels
  drawState.ctx = ctx;

  if (drawState.image) {
    // Herteken het plaatje altijd normaal (niet in gum-modus).
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(drawState.image, 0, 0, w, h);
  }
  applyStrokeStyle(); // zet de penstijl (incl. gum) terug voor het volgende streekje
}

function pointerPos(e) {
  const rect = drawState.canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onPointerDown(e) {
  if (!drawState.enabled) return;
  if (drawState.activeId !== null) return; // palm-rejection: één pointer tegelijk
  drawState.activeId = e.pointerId;
  try { drawState.canvas.setPointerCapture(e.pointerId); } catch (_) {}
  const p = pointerPos(e);
  drawState.last = p;
  const ctx = drawState.ctx;

  if (drawState.mode === "highlighter") {
    // Bewaar de huidige canvas-status en start een nieuw pad
    drawState.savedImageData = ctx.getImageData(0, 0, drawState.canvas.width, drawState.canvas.height);
    drawState.strokePoints = [p];
    applyStrokeStyle();
    // Kleine stip zodat een enkele tik ook zichtbaar is
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.01, p.y + 0.01);
    ctx.stroke();
  } else {
    // Potlood/gum: direct tekenen per segment
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.01, p.y + 0.01);
    ctx.stroke();
  }
  e.preventDefault();
}

function onPointerMove(e) {
  if (!drawState.enabled || e.pointerId !== drawState.activeId) return;
  const ctx = drawState.ctx;
  const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];

  if (drawState.mode === "highlighter") {
    // Herstel canvas naar staat vóór de streek en teken het hele pad opnieuw
    if (drawState.savedImageData) {
      ctx.putImageData(drawState.savedImageData, 0, 0);
    }
    for (const ev of events) {
      const p = pointerPos(ev);
      drawState.strokePoints.push(p);
      drawState.last = p;
    }
    applyStrokeStyle();
    ctx.beginPath();
    ctx.moveTo(drawState.strokePoints[0].x, drawState.strokePoints[0].y);
    for (let i = 1; i < drawState.strokePoints.length; i++) {
      ctx.lineTo(drawState.strokePoints[i].x, drawState.strokePoints[i].y);
    }
    ctx.stroke();
  } else {
    // Potlood/gum: direct tekenen per segment
    ctx.beginPath();
    ctx.moveTo(drawState.last.x, drawState.last.y);
    for (const ev of events) {
      const p = pointerPos(ev);
      ctx.lineTo(p.x, p.y);
      drawState.last = p;
    }
    ctx.stroke();
  }
  e.preventDefault();
}

function onPointerUp(e) {
  if (e.pointerId !== drawState.activeId) return;
  drawState.activeId = null;
  drawState.last = null;
  drawState.strokePoints = [];
  drawState.savedImageData = null;
  try { drawState.canvas.releasePointerCapture(e.pointerId); } catch (_) {}
  scheduleDrawingSave();
  e.preventDefault();
}

function setDrawMode(on) {
  drawState.enabled = on;
  $("#songCard").classList.toggle("drawing", on);
  if (!on) {
    // Geen actief gereedschap meer: haal alle selectie-ringen weg.
    document.querySelectorAll("#drawToolbar .draw-tool").forEach((b) =>
      b.classList.remove("selected"),
    );
  }
}

function setDrawTool(mode) {
  // Nogmaals op het actieve gereedschap tikken zet de tekenmodus uit.
  if (drawState.enabled && drawState.mode === mode) {
    setDrawMode(false);
    return;
  }
  drawState.mode = mode;
  applyStrokeStyle();
  $("#drawEraser").classList.toggle("selected", mode === "eraser");
  $("#drawPencil").classList.toggle("selected", mode === "pencil");
  $("#drawHighlighter").classList.toggle("selected", mode === "highlighter");
  if (!drawState.enabled) setDrawMode(true); // gereedschap kiezen zet tekenmodus aan
}

function scheduleDrawingSave() {
  clearTimeout(drawState.saveTimer);
  drawState.saveTimer = setTimeout(saveCurrentDrawing, 600);
}

function saveCurrentDrawing() {
  const canvas = drawState.canvas;
  if (!canvas || !state.currentSong || !state.user) return;
  let dataUrl = "";
  try {
    dataUrl = canvas.toDataURL("image/webp", 0.7);
    if (!dataUrl.startsWith("data:image/webp")) dataUrl = canvas.toDataURL("image/png");
  } catch (ex) {
    console.error("Tekening exporteren mislukt:", ex);
    return;
  }
  // Bewaar een snapshot voor correct herschalen bij resize.
  const img = new Image();
  img.onload = () => { drawState.image = img; };
  img.src = dataUrl;
  drawState.imageDataUrl = dataUrl;
  saveDrawing(state.currentSong.id, state.user.uid, effectiveInstrument(), dataUrl);
}

function clearDrawing() {
  const ctx = drawState.ctx;
  if (ctx && drawState.canvas) {
    ctx.clearRect(0, 0, drawState.canvas.clientWidth, drawState.canvas.clientHeight);
  }
  drawState.image = null;
  drawState.imageDataUrl = "";
  if (state.currentSong && state.user) {
    saveDrawing(state.currentSong.id, state.user.uid, effectiveInstrument(), "");
  }
}

// Laad de juiste tekenlaag voor het huidige liedje + instrument.
async function loadDrawing() {
  if (!state.currentSong || !state.user) return;
  const inst = effectiveInstrument();
  const key = `${state.currentSong.id}__${inst}`;
  drawState.loadingKey = key;

  // Wis eerst de huidige laag terwijl we de nieuwe ophalen.
  drawState.image = null;
  drawState.imageDataUrl = "";
  layoutCanvas();

  let dataUrl = null;
  try {
    dataUrl = await getDrawing(state.currentSong.id, state.user.uid, inst);
  } catch (ex) {
    console.error("Tekening laden mislukt:", ex);
  }
  // Genegeerd als er ondertussen van liedje/instrument is gewisseld.
  if (drawState.loadingKey !== key) return;

  if (dataUrl) {
    const img = new Image();
    img.onload = () => {
      if (drawState.loadingKey !== key) return;
      drawState.image = img;
      drawState.imageDataUrl = dataUrl;
      layoutCanvas();
    };
    img.src = dataUrl;
  } else {
    layoutCanvas(); // niets: canvas blijft leeg
  }
}

// Reset de tekenlaag (bij openen van een ander liedje).
function resetDrawing() {
  drawState.activeId = null;
  drawState.last = null;
  drawState.image = null;
  drawState.imageDataUrl = "";
  setDrawMode(false);
  if (drawState.ctx && drawState.canvas) {
    drawState.ctx.clearRect(0, 0, drawState.canvas.width, drawState.canvas.height);
  }
}

// ===========================================================================
//  GEBRUIKERSINSTELLINGEN (Voetpedaal, Autoscroll, Tekenmodus)
// ===========================================================================
const SETTINGS_KEY = "userSettings";

/** Laad instellingen uit localStorage (snel) en Firestore (actueel). */
async function loadUserSettings(uid) {
  // Eerst uit localStorage (offline).
  const cached = localStorage.getItem(SETTINGS_KEY);
  if (cached) {
    try {
      state.settings = { ...state.settings, ...JSON.parse(cached) };
    } catch (ex) {
      console.error("Instellingen uit cache laden mislukt:", ex);
    }
  }
  // Dan uit Firestore (actueel).
  try {
    const profile = await getUserProfile(uid);
    if (profile?.settings) {
      state.settings = { ...state.settings, ...profile.settings };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    }
  } catch (ex) {
    console.error("Instellingen laden mislukt:", ex);
  }
  // Migreer oude instellingen (enableFootswitch/enableAutoscroll → readingMode)
  if (!state.settings.readingMode) {
    // Als er nog oude keys zijn, bepaal de readingMode daaruit.
    if (state.settings.enableAutoscroll && !state.settings.enableFootswitch) {
      state.settings.readingMode = "autoscroll";
    } else {
      state.settings.readingMode = "footswitch";
    }
    delete state.settings.enableFootswitch;
    delete state.settings.enableAutoscroll;
  }
  applySettingsToUI();
}

/** Pas instellingen toe op de huidige UI (voetpedaal/autoscroll-knoppen). */
function applySettingsToUI() {
  // Pas de leesmodus toe op de song view als die actief is.
  if ($("#view-song").classList.contains("active")) {
    if (state.settings.readingMode === "autoscroll") {
      disableFootswitch();
      state.autoscroll = true;
      $("#topAutoscrollState").textContent = "aan";
      $("#topAutoscroll").classList.add("footswitch-btn-on");
    } else {
      state.autoscroll = false;
      stopAutoScroll();
      enableFootswitch();
    }
  }
  applyScrollButtonPosition();
  updateScrollButton();
  // Teken-icoontjes verbergen/tonen op basis van instelling
  $("#drawToolbar").style.display = state.settings.enableDrawMode ? "" : "none";
  applyThemeSetting();
}

/** Zet het gekozen design aan/uit via de theme-bandadmin stylesheet. */
function applyThemeSetting() {
  const link = document.getElementById("themeBandAdmin");
  if (link) link.disabled = state.settings.theme !== "dark";
}

/** Zet de zwevende scrollknop links- of rechtsonder volgens de user settings. */
function applyScrollButtonPosition() {
  const songView = document.getElementById("view-song");
  if (!songView) return;
  songView.classList.toggle("scroll-btn-right", state.settings.scrollButtonPosition === "right");
}

/** Opslaan: formulier → state → Firestore + localStorage. */
async function saveUserSettings() {
  if (!state.user) return;
  const readingMode = document.querySelector('input[name="readingMode"]:checked')?.value || "footswitch";
  const scrollButtonPosition = document.querySelector('input[name="scrollButtonPosition"]:checked')?.value || "left";
  const chordDisplay = document.querySelector('input[name="chordDisplay"]:checked')?.value || "guitar";
  const theme = document.querySelector('input[name="theme"]:checked')?.value || "dark";
  const settings = {
    readingMode,
    scrollButtonPosition,
    enableDrawMode: $("#settingsDrawMode").checked,
    rehearsing: $("#settingsRehearsing").checked,
    chordDisplay,
    theme,
  };
  state.settings = settings;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  try {
    await setUserProfile(state.user.uid, { settings });
  } catch (ex) {
    console.error("Instellingen opslaan mislukt:", ex);
    return;
  }
  applySettingsToUI();
  refreshPresence(); // direct het rehearsing-vlagje doorgeven aan de band
}

/** Open de settings-view en laad huidige waarden. */
function openSettings() {
  showView("settings");
  const radio = document.querySelector(`input[name="readingMode"][value="${state.settings.readingMode || "footswitch"}"]`);
  if (radio) radio.checked = true;
  const posRadio = document.querySelector(`input[name="scrollButtonPosition"][value="${state.settings.scrollButtonPosition || "left"}"]`);
  if (posRadio) posRadio.checked = true;
  const chordRadio = document.querySelector(`input[name="chordDisplay"][value="${state.settings.chordDisplay || "guitar"}"]`);
  if (chordRadio) chordRadio.checked = true;
  const themeRadio = document.querySelector(`input[name="theme"][value="${state.settings.theme || "dark"}"]`);
  if (themeRadio) themeRadio.checked = true;
  $("#settingsDrawMode").checked = state.settings.enableDrawMode;
  $("#settingsRehearsing").checked = state.settings.rehearsing;
  $("#myInstrument").value = state.myInstrument;
}

// Settings-view handler
$("#topSettings").addEventListener("click", () => navigate({ view: "settings" }, openSettings));

// Setlist-view handler
$("#topSetlist").addEventListener("click", () => navigate({ view: "setlist" }, openSetlist));

// ===========================================================================
//  SETLIST MANAGER
// ===========================================================================

/** Open de setlist-view. Laad alle setlists en vul de UI. */
async function openSetlist() {
  showView("setlist");
  if (!state.user) return;

  // Zorg dat de liedjescache gevuld is (bijv. na een directe navigatie).
  if (!state.songs.length) {
    try { state.songs = await getAllSongs(); } catch (ex) { console.error(ex); }
  }

  try {
    state.setlists = await getAllSetlists();
  } catch (ex) {
    console.error("Setlists laden mislukt:", ex);
    state.setlists = [];
  }

  // Vul de setlist-selector; herstel de huidige selectie indien mogelijk.
  const selectEl = $("#setlistSelect");
  const keepId = state.currentSetlist?.id || "";
  selectEl.innerHTML = '<option value="">-- Selecteer een setlist --</option>';
  state.setlists.forEach((sl) => {
    const opt = document.createElement("option");
    opt.value = sl.id;
    const dateStr = sl.date ? new Date(toMillis(sl.date)).toLocaleDateString("nl-NL") : "";
    opt.textContent = `${sl.name}${dateStr ? " (" + dateStr + ")" : ""}`;
    selectEl.appendChild(opt);
  });

  renderSongBank();

  // Herstel de eerder geselecteerde setlist, of begin leeg.
  const stillExists = state.setlists.find((s) => s.id === keepId);
  if (stillExists) {
    selectEl.value = keepId;
    state.currentSetlist = stillExists;
    renderSetlistPlanner(state.setlistSongIds);
  } else {
    state.currentSetlist = null;
    state.setlistSongIds = [];
    renderSetlistPlanner([]);
  }
  markSetlistClean();
}

/** Vul de linkerkolom met alle liedjes: tik om toe te voegen, of sleep. */
function renderSongBank(filter = "") {
  const songBank = $("#songBank");
  songBank.innerHTML = "";
  const term = filter.toLowerCase().trim();

  const list = state.songs
    .filter((s) => !term ||
      (s.title || "").toLowerCase().includes(term) ||
      (s.artist || "").toLowerCase().includes(term))
    .slice()
    .sort((a, b) => (a.title || "").localeCompare(b.title || "", "nl"));

  if (!list.length) {
    songBank.innerHTML = '<p class="text-gray-400 text-sm italic">Geen liedjes gevonden.</p>';
    return;
  }

  list.forEach((song) => {
    const item = document.createElement("div");
    item.className =
      "setlist-song-item bg-blue-50 border border-blue-300 rounded px-3 py-2 text-sm cursor-pointer hover:bg-blue-100 flex justify-between items-center gap-2";
    item.draggable = true;
    item.dataset.songId = song.id;

    const label = document.createElement("span");
    label.className = "truncate";
    label.textContent = song.title || "(zonder titel)";
    item.appendChild(label);

    const addBtn = document.createElement("span");
    addBtn.className = "text-blue-600 font-bold shrink-0";
    addBtn.textContent = "+";
    item.appendChild(addBtn);

    // Tik/klik = toevoegen (werkt ook op touch, waar drag-and-drop faalt).
    item.addEventListener("click", () => addSongToSetlist(song.id));

    // Slepen op desktop blijft mogelijk.
    item.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "copy";
      e.dataTransfer.setData("text/plain", song.id);
    });

    songBank.appendChild(item);
  });
}

/** Voeg een liedje toe aan de huidige planner-volgorde. */
function addSongToSetlist(songId) {
  if (!state.currentSetlist) {
    alert("Kies of maak eerst een setlist voordat je liedjes toevoegt.");
    return;
  }
  // Een nummer mag vaker in een setlist staan (bijv. toegift), dus geen dedup.
  state.setlistSongIds.push(songId);
  markSetlistDirty();
  renderSetlistPlanner(state.setlistSongIds);
}

/** Verplaats een liedje binnen de planner van index `from` naar `to`. */
function moveSetlistSong(from, to) {
  const ids = state.setlistSongIds;
  if (to < 0 || to >= ids.length) return;
  const [moved] = ids.splice(from, 1);
  ids.splice(to, 0, moved);
  markSetlistDirty();
  renderSetlistPlanner(ids);
}

/** Render de geselecteerde setlist in de planner (rechterkolom). */
function renderSetlistPlanner(songIds) {
  const planner = $("#setlistSongs");
  planner.innerHTML = "";
  state.setlistSongIds = songIds || [];

  if (!state.currentSetlist) {
    planner.innerHTML =
      '<p class="text-gray-400 text-sm italic">Selecteer of maak een setlist om te beginnen.</p>';
    return;
  }
  if (state.setlistSongIds.length === 0) {
    planner.innerHTML =
      '<p class="text-gray-400 text-sm italic">Tik links op een liedje (of sleep het hierheen) om het toe te voegen.</p>';
    return;
  }

  state.setlistSongIds.forEach((songId, idx) => {
    const song = state.songs.find((s) => s.id === songId);

    const item = document.createElement("div");
    item.className =
      "setlist-planner-item bg-green-50 border border-green-300 rounded px-2 py-2 text-sm flex items-center gap-2";
    item.draggable = true;
    item.dataset.index = idx;

    // Volgnummer + titel: klik om af te spelen vanaf hier.
    const titleBtn = document.createElement("button");
    titleBtn.type = "button";
    titleBtn.className = "flex-1 min-w-0 text-left truncate hover:text-green-800";
    titleBtn.textContent = `${idx + 1}. ${song ? (song.title || "(zonder titel)") : "‹verwijderd liedje›"}`;
    if (song) titleBtn.addEventListener("click", () => playFromSetlist(idx));
    item.appendChild(titleBtn);

    // Omhoog / omlaag (werkt op elk apparaat).
    const upBtn = document.createElement("button");
    upBtn.type = "button";
    upBtn.className = "px-1.5 text-gray-500 hover:text-gray-800 disabled:opacity-30";
    upBtn.textContent = "▲";
    upBtn.disabled = idx === 0;
    upBtn.addEventListener("click", () => moveSetlistSong(idx, idx - 1));
    item.appendChild(upBtn);

    const downBtn = document.createElement("button");
    downBtn.type = "button";
    downBtn.className = "px-1.5 text-gray-500 hover:text-gray-800 disabled:opacity-30";
    downBtn.textContent = "▼";
    downBtn.disabled = idx === state.setlistSongIds.length - 1;
    downBtn.addEventListener("click", () => moveSetlistSong(idx, idx + 1));
    item.appendChild(downBtn);

    // Verwijderen.
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "px-1.5 text-red-500 hover:text-red-700 font-bold";
    delBtn.textContent = "✕";
    delBtn.addEventListener("click", () => {
      state.setlistSongIds.splice(idx, 1);
      markSetlistDirty();
      renderSetlistPlanner(state.setlistSongIds);
    });
    item.appendChild(delBtn);

    // Slepen op desktop om te herordenen.
    item.addEventListener("dragstart", (e) => {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", "planner:" + idx);
    });
    item.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      item.classList.add("border-blue-500", "bg-blue-50");
    });
    item.addEventListener("dragleave", () => {
      item.classList.remove("border-blue-500", "bg-blue-50");
    });
    item.addEventListener("drop", (e) => {
      e.preventDefault();
      item.classList.remove("border-blue-500", "bg-blue-50");
      const data = e.dataTransfer.getData("text/plain");
      if (!data.startsWith("planner:")) return;
      const from = parseInt(data.split(":")[1], 10);
      if (!Number.isNaN(from) && from !== idx) moveSetlistSong(from, idx);
    });

    planner.appendChild(item);
  });
}

/** Markeer de planner als gewijzigd / opgeslagen (voor de Save-indicatie). */
function markSetlistDirty() {
  state.setlistDirty = true;
  $("#setlistDirty")?.classList.remove("hidden");
}
function markSetlistClean() {
  state.setlistDirty = false;
  $("#setlistDirty")?.classList.add("hidden");
}

/** Open een liedje uit de setlist en onthoud de context voor vorig/volgend. */
function playFromSetlist(index) {
  const songIds = state.setlistSongIds.slice();
  const id = songIds[index];
  if (!id) return;
  navigate(
    { view: "song", id, perform: { songIds, index } },
    () => openSong(id, { songIds, index })
  );
  broadcastSessionSong(songIds, index);
}

// Setlist-view: Nieuwe setlist aanmaken
$("#newSetlistBtn").addEventListener("click", () => {
  $("#newSetlistModal").classList.remove("hidden");
  $("#newSetlistName").focus();
});

$("#cancelNewSetlistBtn").addEventListener("click", () => {
  $("#newSetlistModal").classList.add("hidden");
});

$("#createSetlistBtn").addEventListener("click", async () => {
  const name = $("#newSetlistName").value.trim();
  const dateStr = $("#newSetlistDate").value;

  if (!name) {
    alert("Geef de setlist een naam.");
    return;
  }

  try {
    const date = dateStr ? new Date(dateStr) : new Date();
    const newId = await createSetlist({ name, date, songIds: [] });
    $("#newSetlistModal").classList.add("hidden");
    $("#newSetlistName").value = "";
    $("#newSetlistDate").value = "";
    // Selecteer de nieuwe setlist meteen zodat je er liedjes in kunt slepen.
    state.currentSetlist = { id: newId, name, date, songIds: [] };
    state.setlistSongIds = [];
    await openSetlist();
  } catch (ex) {
    console.error("Setlist aanmaken mislukt:", ex);
    alert("Aanmaken mislukt. Controleer je verbinding.");
  }
});

// Setlist verwijderen
$("#deleteSetlistBtn").addEventListener("click", async () => {
  if (!state.currentSetlist?.id) {
    alert("Selecteer eerst een setlist.");
    return;
  }
  if (!confirm(`Setlist "${state.currentSetlist.name}" verwijderen?`)) return;
  try {
    await deleteSetlist(state.currentSetlist.id);
    state.currentSetlist = null;
    state.setlistSongIds = [];
    await openSetlist();
  } catch (ex) {
    console.error("Setlist verwijderen mislukt:", ex);
    alert("Verwijderen mislukt. Controleer je verbinding.");
  }
});

// Zoeken in de songbank
$("#songBankSearch")?.addEventListener("input", (e) => {
  renderSongBank(e.target.value);
});

// Setlist-selector: laad geselecteerde setlist
$("#setlistSelect").addEventListener("change", async (e) => {
  if (state.setlistDirty && !confirm("Je hebt niet-opgeslagen wijzigingen. Doorgaan en verwerpen?")) {
    e.target.value = state.currentSetlist?.id || "";
    return;
  }

  const setlistId = e.target.value;
  if (!setlistId) {
    state.currentSetlist = null;
    state.setlistSongIds = [];
    renderSetlistPlanner([]);
    markSetlistClean();
    return;
  }

  try {
    state.currentSetlist = await getSetlist(setlistId);
    state.setlistSongIds = (state.currentSetlist?.songIds || []).slice();
    renderSetlistPlanner(state.setlistSongIds);
    markSetlistClean();
  } catch (ex) {
    console.error("Setlist laden mislukt:", ex);
  }
});

// Dropzone voor de setlist-planner (desktop drag-and-drop)
const setlistDropzone = $("#setlistDropzone");
setlistDropzone.addEventListener("dragover", (e) => {
  e.preventDefault();
  setlistDropzone.classList.add("bg-blue-100");
});
setlistDropzone.addEventListener("dragleave", () => {
  setlistDropzone.classList.remove("bg-blue-100");
});
setlistDropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  setlistDropzone.classList.remove("bg-blue-100");
  const payload = e.dataTransfer.getData("text/plain");
  if (!payload) return;

  if (payload.startsWith("planner:")) {
    // Herordenen: verplaats het gesleepte item naar het einde.
    const from = Number(payload.slice("planner:".length));
    if (!Number.isNaN(from)) moveSetlistSong(from, state.setlistSongIds.length - 1);
  } else {
    // Toevoegen vanuit de songbank.
    addSongToSetlist(payload);
  }
});

// Save button: handler voor zowel de editor- als de setlist-view
$("#topSave").addEventListener("click", async () => {
  const view = document.querySelector(".view.active")?.id;
  if (view === "view-editor") {
    $("#songForm").dispatchEvent(new Event("submit", { bubbles: true }));
  } else if (view === "view-setlist") {
    if (!state.currentSetlist?.id) {
      alert("Selecteer eerst een setlist.");
      return;
    }
    try {
      await updateSetlist(state.currentSetlist.id, {
        name: state.currentSetlist.name,
        date: state.currentSetlist.date,
        songIds: state.setlistSongIds,
      });
      state.currentSetlist.songIds = state.setlistSongIds.slice();
      markSetlistClean();
      flashSetlistSaved();
    } catch (ex) {
      console.error("Setlist opslaan mislukt:", ex);
      alert("Opslaan mislukt. Controleer je verbinding.");
    }
  }
});

/** Korte visuele bevestiging na opslaan (zonder de view te resetten). */
function flashSetlistSaved() {
  const el = $("#setlistSaved");
  if (!el) return;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 1800);
}

// --- Live-navigatie in de song view (vorig/volgend binnen een setlist) ------

function updateSetlistNav() {
  const bar = $("#setlistNav");
  if (!bar) return;
  const p = state.perform;
  if (!p || !p.songIds || p.songIds.length < 1) {
    bar.classList.add("hidden");
    return;
  }
  bar.classList.remove("hidden");
  $("#setlistNavCounter").textContent = `${p.index + 1} / ${p.songIds.length}`;
  $("#setlistPrevBtn").disabled = p.index <= 0;
  $("#setlistNextBtn").disabled = p.index >= p.songIds.length - 1;
}

$("#setlistPrevBtn")?.addEventListener("click", () => {
  const p = state.perform;
  if (p && p.index > 0) playFromSetlistContext(p.index - 1);
});
$("#setlistNextBtn")?.addEventListener("click", () => {
  const p = state.perform;
  if (p && p.index < p.songIds.length - 1) playFromSetlistContext(p.index + 1);
});
$("#setlistBackBtn")?.addEventListener("click", () => history.back());

// --- Sessie-knoppen (starten/besturen/beëindigen) -----------------------------
$("#startSessionBtn").addEventListener("click", openSessionModal);
$("#cancelStartSessionBtn").addEventListener("click", closeSessionModal);
$("#confirmStartSessionBtn").addEventListener("click", confirmSessionStart);
$("#sessionPlayBtn").addEventListener("click", toggleSessionPlayback);
$("#sessionEndBtn").addEventListener("click", endCurrentSession);

function playFromSetlistContext(index) {
  const p = state.perform;
  if (!p) return;
  const id = p.songIds[index];
  if (!id) return;
  replaceView(
    { view: "song", id, perform: { songIds: p.songIds, index } },
    () => openSong(id, { songIds: p.songIds, index })
  );
  broadcastSessionSong(p.songIds, index);
}

// Auto-save bij elke wijziging in instellingen
document.querySelectorAll('input[name="readingMode"]').forEach((radio) => {
  radio.addEventListener("change", saveUserSettings);
});
document.querySelectorAll('input[name="scrollButtonPosition"]').forEach((radio) => {
  radio.addEventListener("change", saveUserSettings);
});
document.querySelectorAll('input[name="chordDisplay"]').forEach((radio) => {
  radio.addEventListener("change", saveUserSettings);
});
$("#settingsDrawMode").addEventListener("change", saveUserSettings);
$("#settingsRehearsing").addEventListener("change", saveUserSettings);

// Tekenmodus: kan alleen als ingesteld.
const originalSetDrawMode = setDrawMode;
setDrawMode = function(on) {
  if (on && !state.settings.enableDrawMode) {
    alert("Handgeschreven aantekeningen zijn uitgeschakeld in de instellingen.");
    return;
  }
  originalSetDrawMode(on);
};

function initDrawing() {
  const canvas = $("#drawCanvas");
  if (!canvas) return;
  drawState.canvas = canvas;
  drawState.ctx = canvas.getContext("2d");

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);

  $("#drawEraser").addEventListener("click", () => setDrawTool("eraser"));
  $("#drawPencil").addEventListener("click", () => setDrawTool("pencil"));
  $("#drawHighlighter").addEventListener("click", () => setDrawTool("highlighter"));
  $("#drawClear").addEventListener("click", () => {
    if (confirm("Tekening wissen?")) clearDrawing();
  });

  // Standaard: potlood als gereedschap, tekenmodus uit (nog geen selectie-ring).
  drawState.mode = "pencil";
}
initDrawing();

// ===========================================================================
//  GITAARGREPEN: klikbare akkoorden → Chordify-stijl popup met SVG-diagram
// ===========================================================================

/** Preload alle akkoorddata uit Firestore voor offline gebruik. */
async function preloadChords() {
  try {
    const all = await getAllChords();
    for (const ch of all) {
      state.chordCache[ch.id] = ch;
    }
  } catch (ex) {
    console.warn("Akkoorden preloaden mislukt (geen netwerk?):", ex.message);
  }
  try {
    const allPiano = await getAllPianoChords();
    for (const ch of allPiano) {
      state.pianoChordCache[ch.id] = ch;
    }
  } catch (ex) {
    console.warn("Piano-akkoorden preloaden mislukt (geen netwerk?):", ex.message);
  }
}

/** Event-delegatie: klik op een akkoord boven de songtekst. */
$("#songBody").addEventListener("click", async (e) => {
  const chordEl = e.target.closest(".chord-clickable");
  if (!chordEl) return;
  const chordName = chordEl.dataset.chord;
  if (!chordName) return;

  // Piano-weergave: toon een aangepast piano-akkoord uit de database als dat
  // bestaat; anders worden de noten lokaal uit de akkoordnaam berekend.
  if (state.settings.chordDisplay === "piano") {
    let pianoData = state.pianoChordCache[chordName];
    if (!pianoData) {
      try {
        pianoData = await getPianoChord(chordName);
        if (pianoData) state.pianoChordCache[chordName] = pianoData;
      } catch (ex) {
        console.error("Piano-akkoord ophalen mislukt:", ex);
      }
    }
    const custom = pianoData && Array.isArray(pianoData.notes) && pianoData.notes.length
      ? pianoData
      : null;
    showChordModal(renderPianoChordSVG(chordName, custom), { wide: true });
    return;
  }

  // Check cache
  let chordData = state.chordCache[chordName];

  // Als niet in cache: haal op uit Firestore
  if (!chordData) {
    try {
      chordData = await getChord(chordName);
      if (chordData) {
        state.chordCache[chordName] = chordData;
      }
    } catch (ex) {
      console.error("Akkoord ophalen mislukt:", ex);
    }
  }

  if (!chordData) {
    // Toon een basisdiagram zonder database-data (alleen met de akkoordnaam)
    chordData = {
      chordName,
      baseFret: 1,
      frets: [-1, -1, -1, -1, -1, -1],
      fingers: [0, 0, 0, 0, 0, 0],
    };
  }

  const svg = renderChordSVG(chordData);
  showChordModal(svg);
});

// Chord modal sluiten: overlay-klik
$("#chordModalOverlay").addEventListener("click", hideChordModal);

// Chord modal sluiten: X-knop
$("#chordModalClose").addEventListener("click", hideChordModal);

// Chord modal sluiten: Escape-toets
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    const modal = document.getElementById("chordModal");
    if (modal && !modal.classList.contains("hidden")) hideChordModal();
  }
});

// Seed-functie: schrijf alle voorbeeldakkoorden naar Firestore.
// Aanroepen in de browser console: seedChords()
window.seedChords = async () => {
  if (!state.user) {
    console.error("Je moet ingelogd zijn om akkoorden te seeden.");
    return;
  }
  console.log(`Bezig met seeden van ${EXAMPLE_CHORDS.length} akkoorden...`);
  for (const ch of EXAMPLE_CHORDS) {
    try {
      await setChord(ch.id, {
        chordName: ch.chordName,
        baseFret: ch.baseFret,
        frets: ch.frets,
        fingers: ch.fingers,
      });
      state.chordCache[ch.id] = ch;
      console.log(`✓ ${ch.id}`);
    } catch (ex) {
      console.error(`✗ ${ch.id}:`, ex.message);
    }
  }
  console.log("Klaar! Akkoorden staan in Firestore en lokale cache.");
};

// Preload akkoorden zodra de gebruiker is ingelogd (na auth-check).
// We wachten een klein moment zodat Firestore offline-cache klaar is.
setTimeout(() => { if (state.user) preloadChords(); }, 1500);

/** Render één sectie als gekleurd blok met badge-koptekst en '+' voor opmerkingen. */
function renderSection(section, { withNotes = false } = {}) {
  const wrap = document.createElement("div");
  const typeClass = ("sec-" + (section.type || "verse")).replace(/[^a-z0-9-]/gi, "-").toLowerCase();
  wrap.className = "song-section " + typeClass;

  // Header met badge en '+' knop (rechts)
  const headerRow = document.createElement("div");
  headerRow.style.display = "flex";
  headerRow.style.alignItems = "center";
  headerRow.style.justifyContent = "space-between";
  headerRow.style.marginBottom = "0.55rem";

  const badge = document.createElement("div");
  badge.className = "section-header";
  badge.style.margin = "0";
  badge.textContent = sectionLabel(section.type);
  headerRow.appendChild(badge);

  // '+' knop voor sectie-opmerkingen (alleen als notes actief zijn)
  let addBtn = null;
  if (withNotes) {
    addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "section-add";
    addBtn.textContent = "+";
    addBtn.title = "Opmerking bij deze sectie toevoegen";
    headerRow.appendChild(addBtn);
  }
  wrap.appendChild(headerRow);

  // Bestaande sectie-opmerkingen (altijd tonen)
  if (withNotes) {
    const notesList = renderSectionNotesList(section);
    wrap.appendChild(notesList);
  }

  // Verborgen formulier (tonen/verbergen via '+' knop)
  let form = null;
  if (withNotes) {
    form = document.createElement("form");
    form.className = "section-note-form";
    form.style.display = "none";
    const defaultInst = state.instrument !== "all" ? state.instrument : state.myInstrument;
    form.innerHTML = `
      <select class="sn-instrument">${instrumentOptions(defaultInst)}</select>
      <input class="sn-text" type="text" placeholder="Opmerking voor ${escapeHtml(sectionLabel(section.type).toLowerCase())}…" />
      <button type="submit" title="Toevoegen">+</button>`;
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const text = form.querySelector(".sn-text").value.trim();
      if (!text) return;
      const instrument = form.querySelector(".sn-instrument").value;
      createNote({ instrument, text, sectionId: section.id });
      form.style.display = "none";
      form.querySelector(".sn-text").value = "";
    });
    wrap.appendChild(form);

    // '+' knop toont/verbergt het formulier
    addBtn.addEventListener("click", () => {
      if (form.style.display === "none") {
        form.style.display = "flex";
        form.querySelector(".sn-text").focus();
      } else {
        form.style.display = "none";
      }
    });
  }

  (section.lines || []).forEach((line, idx) => {
    wrap.appendChild(withNotes ? renderLineWithNotes(section, line, idx) : renderLine(line));
  });
  return wrap;
}

/** Een regel + de bijbehorende regel-opmerkingen + een '+' om er een toe te voegen. */
function renderLineWithNotes(section, line, idx) {
  const block = document.createElement("div");
  block.className = "line-block";

  const row = document.createElement("div");
  row.className = "line-row";
  row.appendChild(renderLine(line));

  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "line-add";
  addBtn.textContent = "+";
  addBtn.title = "Opmerking bij deze regel";
  row.appendChild(addBtn);
  block.appendChild(row);

  // Bestaande regel-opmerkingen (gefilterd op muzikant; "Algemeen" altijd zichtbaar).
  const notesWrap = document.createElement("div");
  notesWrap.className = "line-notes";
  const notes = (state.currentSong.notes || [])
    .filter((n) => n.sectionId === section.id && n.lineIndex === idx)
    .filter((n) => state.instrument === "all" || n.instrument === state.instrument || n.instrument === "general")
    .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
  for (const note of notes) notesWrap.appendChild(noteElement(note));
  block.appendChild(notesWrap);

  // '+' toont/verbergt een inline formuliertje voor deze regel.
  addBtn.addEventListener("click", () => {
    const existing = block.querySelector(".line-note-form");
    if (existing) { existing.remove(); return; }
    const form = document.createElement("form");
    form.className = "line-note-form section-note-form";
    const defaultInst = state.instrument !== "all" ? state.instrument : state.myInstrument;
    form.innerHTML = `
      <select class="sn-instrument">${instrumentOptions(defaultInst)}</select>
      <input class="sn-text" type="text" placeholder="Opmerking bij deze regel…" />
      <button type="submit" title="Toevoegen">+</button>`;
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const text = form.querySelector(".sn-text").value.trim();
      if (!text) return;
      await createNote({
        instrument: form.querySelector(".sn-instrument").value,
        text,
        sectionId: section.id,
        lineIndex: idx,
      });
    });
    block.appendChild(form);
    form.querySelector(".sn-text").focus();
  });

  return block;
}

/** Rendert alleen de lijst met sectie-opmerkingen (gefilterd op instrument). */
function renderSectionNotesList(section) {
  const box = document.createElement("div");
  box.className = "section-notes";

  const notes = (state.currentSong.notes || [])
    .filter((n) => n.sectionId === section.id && n.lineIndex == null)
    .filter((n) => state.instrument === "all" || n.instrument === state.instrument || n.instrument === "general")
    .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));

  for (const note of notes) box.appendChild(noteElement(note));

  return box;
}

/** <option>-lijst voor instrumenten (zonder 'Alle'), met een geselecteerde waarde. */
function instrumentOptions(selected) {
  return INSTRUMENTS.filter((i) => i.key !== "all")
    .map((i) => `<option value="${i.key}"${i.key === selected ? " selected" : ""}>${i.label}</option>`)
    .join("");
}

/** Bouw een notitie-element: alles op één regel, zonder datum. */
function noteElement(note) {
  const el = document.createElement("div");
  el.className = "sn-item flex items-center justify-between gap-2";
  const canEdit = note.userId === state.user?.uid;
  el.innerHTML = `
    <div class="flex items-baseline gap-2 min-w-0 flex-1">
      <span class="shrink-0 text-xs font-semibold uppercase tracking-wide text-blue-600">
        ${escapeHtml(instrumentLabel(note.instrument))}
      </span>
      <span class="note-text text-sm truncate${canEdit ? " cursor-pointer hover:text-blue-600" : ""}"
        ${canEdit ? 'title="Klik om aan te passen"' : ""}>${escapeHtml(note.text)}</span>
    </div>`;
  if (canEdit) {
    el.querySelector(".note-text").addEventListener("click", () => startEditNote(el, note));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "text-gray-300 hover:text-red-600 text-sm shrink-0";
    del.textContent = "✕";
    del.title = "Verwijderen";
    del.addEventListener("click", () => onDeleteNote(note));
    el.appendChild(del);
  }
  return el;
}

/** Zet een notitie in bewerk-modus: invoerveld met Opslaan/Annuleren. */
function startEditNote(el, note) {
  el.innerHTML = `
    <input class="sn-edit-input flex-1 min-w-0 border border-gray-300 rounded px-2 py-1 text-sm"
      value="${escapeHtml(note.text)}" />
    <button type="button" class="sn-edit-save text-blue-600 text-sm px-1.5 shrink-0" title="Opslaan">✓</button>
    <button type="button" class="sn-edit-cancel text-gray-400 text-sm px-1.5 shrink-0" title="Annuleren">✕</button>`;

  const input = el.querySelector(".sn-edit-input");
  input.focus();
  input.select();

  let finished = false;
  const save = () => {
    if (finished) return;
    finished = true;
    const text = input.value.trim();
    if (text && text !== note.text) onUpdateNote(note, text);
    else el.replaceWith(noteElement(note));
  };
  const cancel = () => {
    if (finished) return;
    finished = true;
    el.replaceWith(noteElement(note));
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); save(); }
    else if (e.key === "Escape") cancel();
  });
  // Klikt de gebruiker weg zonder op te slaan, dan annuleren we de bewerking.
  input.addEventListener("blur", () => setTimeout(cancel, 0));
  el.querySelector(".sn-edit-save").addEventListener("click", save);
  el.querySelector(".sn-edit-cancel").addEventListener("click", cancel);
}

/** Werk de tekst van een notitie bij (optimistisch, sync op de achtergrond). */
function onUpdateNote(note, text) {
  const updated = { ...note, text };
  state.currentSong.notes = (state.currentSong.notes || []).map((n) =>
    n.id === note.id ? updated : n
  );
  refreshSongView();
  updateNote(state.currentSong.id, note, updated).catch((e) =>
    console.error("Notitie bijwerken synchroniseren mislukt:", e)
  );
}

// --- Algemene opmerkingen (niet aan een sectie gekoppeld) ------------------
function renderNotes() {
  const song = state.currentSong;
  const listEl = $("#generalNotesList");
  listEl.innerHTML = "";

  // Algemene opmerkingen zijn altijd zichtbaar voor iedereen (geen instrument-filter).
  let notes = (song.notes || []).filter((n) => !n.sectionId);
  notes = notes.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));

  for (const note of notes) listEl.appendChild(noteElement(note));
}

// '+' bij de titel: toon/verberg het formulier voor een algemene opmerking.
$("#addGeneralNoteBtn").addEventListener("click", () => {
  const form = $("#generalNoteForm");
  const willShow = form.classList.contains("hidden");
  form.classList.toggle("hidden", !willShow);
  if (willShow) {
    // Kies standaard het eigen instrument (of het actieve filter).
    $("#generalNoteInstrument").value = state.instrument !== "all" ? state.instrument : state.myInstrument;
    $("#generalNoteText").focus();
  }
});

$("#generalNoteForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const text = $("#generalNoteText").value.trim();
  if (!text) return;
  await createNote({ instrument: $("#generalNoteInstrument").value, text, sectionId: null });
  $("#generalNoteText").value = "";
  $("#generalNoteForm").classList.add("hidden");
});

// Gedeelde toevoeg-functie voor algemene, sectie- én regel-opmerkingen.
// Optimistisch: de UI werkt direct bij; de schrijfactie synct op de achtergrond
// (ook offline — dan gebeurt dat zodra de verbinding terug is).
function createNote({ instrument, text, sectionId = null, lineIndex = null }) {
  if (!state.currentSong) return;
  const note = addNote(state.currentSong.id, {
    userId: state.user.uid,
    instrument,
    text,
    sectionId,
    lineIndex,
  });
  state.currentSong.notes = [...(state.currentSong.notes || []), note];
  refreshSongView();
}

function onDeleteNote(note) {
  if (!confirm("Aantekening verwijderen?")) return;
  // Optimistisch verwijderen; synct op de achtergrond (ook offline).
  state.currentSong.notes = (state.currentSong.notes || []).filter((n) => n.id !== note.id);
  refreshSongView();
  removeNote(state.currentSong.id, note).catch((e) =>
    console.error("Verwijderen synchroniseren mislukt:", e)
  );
}

function instrumentLabel(key) {
  const found = INSTRUMENTS.find((i) => i.key === key);
  return found ? found.label : key;
}

// ===========================================================================
//  PAGETURNER / VOETSCHAKELAAR-MODUS
//  Externe bluetooth-pageturners sturen doorgaans standaard toetsaanslagen.
//  We luisteren globaal en scrollen soepel wanneer de modus actief is.
// ===========================================================================
const SCROLL_STEP = () => window.innerHeight * 0.8;

function handlePageturnerKey(e) {
  if (!state.footswitch) return;
  // Niet kapen wanneer de gebruiker in een invoerveld typt.
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) {
    return;
  }

  const forward = ["PageDown", "ArrowDown", "Space"]; // Space => e.code
  const backward = ["PageUp", "ArrowUp"];

  if (forward.includes(e.key) || forward.includes(e.code)) {
    e.preventDefault();
    scrollForwardStep();
  } else if (backward.includes(e.key) || backward.includes(e.code)) {
    e.preventDefault();
    scrollBackwardStep();
  }
}
window.addEventListener("keydown", handlePageturnerKey);

/** Schuif één schermstap naar beneden (of ga in live-modus aan het einde
 *  naar het volgende nummer). */
function scrollForwardStep() {
  // Live-modus: aan het einde van het liedje schuift een vooruit-input door
  // naar het volgende nummer i.p.v. verder te scrollen.
  if (isLiveMode() && state.atSongEnd) { advanceSetlist(); return; }
  window.scrollBy({ top: SCROLL_STEP(), behavior: "smooth" });
}

/** Schuif één schermstap naar boven. */
function scrollBackwardStep() {
  window.scrollBy({ top: -SCROLL_STEP(), behavior: "smooth" });
}

// ---------------------------------------------------------------------------
//  MEDIA-KNOPPEN VAN BLUETOOTH-PAGETURNERS (play/pauze/volgende/vorige)
//  Sommige pageturners sturen media-toetsen (Play/Pause/Next/Prev) in plaats
//  van PageDown/PageUp. We vangen die zowel via keydown als via de
//  Media Session API (hardware-mediaknoppen op tablets/telefoons).
// ---------------------------------------------------------------------------
const MEDIA_PLAY_KEYS = new Set(["MediaPlay", "MediaPlayPause", "AudioPlay"]);
const MEDIA_PAUSE_KEYS = new Set(["MediaPause", "MediaStop", "AudioPause", "AudioStop"]);
const MEDIA_NEXT_KEYS = new Set(["MediaTrackNext", "AudioNext"]);
const MEDIA_PREV_KEYS = new Set(["MediaTrackPrevious", "AudioPrev"]);
const MEDIA_PLAY_KEYCODES = new Set([179, 250]); // 179 = MediaPlayPause, 250 = Play (legacy)
const MEDIA_PAUSE_KEYCODES = new Set([178, 251]); // 178 = MediaStop, 251 = Pause (legacy)
const MEDIA_NEXT_KEYCODES = new Set([176]);
const MEDIA_PREV_KEYCODES = new Set([177]);

/** Alleen actief op de leespagina van een liedje. */
function isSongViewActive() {
  const songView = document.getElementById("view-song");
  return !!songView && songView.classList.contains("active") && !!state.currentSong;
}

function handleMediaControlKey(e) {
  if (!isSongViewActive()) return;
  const tag = (e.target.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select" || e.target.isContentEditable) {
    return;
  }

  const key = e.key || "";
  const keyCode = e.keyCode || e.which || 0;

  if (MEDIA_PLAY_KEYS.has(key) || MEDIA_PLAY_KEYCODES.has(keyCode)) {
    e.preventDefault();
    // Play/pauze-knop werkt als toggle: start of pauzeer het BPM-scrollen.
    if (autoScrolling) {
      stopAutoScroll();
    } else {
      startAutoScroll();
    }
  } else if (MEDIA_PAUSE_KEYS.has(key) || MEDIA_PAUSE_KEYCODES.has(keyCode)) {
    e.preventDefault();
    stopAutoScroll();
  } else if (MEDIA_NEXT_KEYS.has(key) || MEDIA_NEXT_KEYCODES.has(keyCode)) {
    e.preventDefault();
    scrollForwardStep();
  } else if (MEDIA_PREV_KEYS.has(key) || MEDIA_PREV_KEYCODES.has(keyCode)) {
    e.preventDefault();
    scrollBackwardStep();
  }
}
window.addEventListener("keydown", handleMediaControlKey);

/** Koppel hardware-mediaknoppen (bluetooth-afstandsbediening/pedaal) aan de app. */
function setupMediaSessionControls() {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.setActionHandler("play", () => {
      if (isSongViewActive() && !autoScrolling) startAutoScroll();
    });
    navigator.mediaSession.setActionHandler("pause", () => {
      if (isSongViewActive()) stopAutoScroll();
    });
    navigator.mediaSession.setActionHandler("stop", () => {
      if (isSongViewActive()) stopAutoScroll();
    });
    navigator.mediaSession.setActionHandler("nexttrack", () => {
      if (isSongViewActive()) scrollForwardStep();
    });
    navigator.mediaSession.setActionHandler("previoustrack", () => {
      if (isSongViewActive()) scrollBackwardStep();
    });
  } catch (ex) {
    console.error("Media Session-knoppen instellen mislukt:", ex);
  }
}
setupMediaSessionControls();

/** Houd de Media Session-status bij, zodat bluetooth-mediaknoppen de app
 *  als actieve 'speler' zien en play/pauze blijven werken. */
function setMediaSessionPlaybackState(playbackState) {
  if (!("mediaSession" in navigator)) return;
  try {
    navigator.mediaSession.playbackState = playbackState;
    if (playbackState === "playing" && !navigator.mediaSession.metadata) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: (state.currentSong && state.currentSong.title) || "Band Admin",
      });
    }
  } catch (ex) {
    // Niet elke browser ondersteunt MediaSession/Metadata.
  }
}

// Zwevende blauwe knop linksonder:
//  - live-modus aan het einde: ga naar het volgende nummer (of einde setlist);
//  - normaal: scroll soepel een stap naar beneden;
//  - in autoscroll-modus (of terwijl autoscroll loopt): start/stop het scrollen.
$("#scrollDownBtn").addEventListener("click", () => {
  if (isLiveMode() && state.atSongEnd) { advanceSetlist(); return; }
  if (autoScrolling) {
    stopAutoScroll();
  } else if (state.autoscroll) {
    startAutoScroll();
  } else {
    scrollForwardStep();
  }
});

// ---------------------------------------------------------------------------
//  LIVE-MODUS: naadloos doorschuiven binnen een setlist
// ---------------------------------------------------------------------------

/** Is dit liedje geopend vanuit een setlist (dan geldt de live-podiumflow)? */
function isLiveMode() {
  return !!(state.perform && Array.isArray(state.perform.songIds) && state.perform.songIds.length);
}

/** Heeft de gebruiker het einde van de pagina/songtekst bereikt? */
function isAtPageBottom() {
  const docHeight = Math.max(
    document.body.offsetHeight,
    document.documentElement.scrollHeight
  );
  return window.innerHeight + window.scrollY >= docHeight - 4;
}

/**
 * Bepaal of we "aan het einde" staan en werk de knop bij. Wordt aangeroepen
 * bij elke scroll en na het laden van een liedje. Alleen relevant in live-modus.
 *
 * `forceEnd` wordt gebruikt door de tijdgebaseerde einde-detectie van de
 * autoscroll: zodra de laatste regel op de focuspositie is geweest, geven we
 * het einde expliciet door. Een handmatige scroll omhoog zet `atSongEnd`
 * daarna weer terug naar `false`, precies zoals voorheen.
 */
function updateEndArming({ forceEnd = false } = {}) {
  const armed = isLiveMode() && (isAtPageBottom() || forceEnd);
  if (armed !== state.atSongEnd) {
    state.atSongEnd = armed;
    updateScrollButton();
  }
}
window.addEventListener("scroll", () => updateEndArming(), { passive: true });

/** Ga naar het volgende nummer in de setlist, of sluit de setlist af. */
function advanceSetlist() {
  const p = state.perform;
  if (!p) return;
  const isLast = p.index >= p.songIds.length - 1;
  if (isLast) {
    // Laatste nummer afgerond → terug naar het setlist-overzicht.
    state.atSongEnd = false;
    history.back();
    return;
  }
  const nextIndex = p.index + 1;
  replaceView(
    { view: "song", id: p.songIds[nextIndex], perform: { songIds: p.songIds, index: nextIndex } },
    () => openSong(p.songIds[nextIndex], { songIds: p.songIds, index: nextIndex })
  );
  broadcastSessionSong(p.songIds, nextIndex);
}

// ===========================================================================
//  SETLIST-SESSIE (realtime setlist afspelen, beheerd door álle deelnemers)
//  Ieder bandlid kan het nummer kiezen, het starten voor iedereen en de sessie
//  beëindigen. Na de start scrollt ieder zelf; bij een nieuw nummer worden de
//  anderen 'overruled' en openen ze het gekozen nummer.
// ===========================================================================

let sessionFollowSeq = 0; // om verouderde, nog lopende follow-acties te negeren

/** Ben ik deelnemer aan de actieve sessie? */
function isSessionMember() {
  return !!(
    state.session &&
    state.user &&
    (state.session.members || []).some((m) => m.uid === state.user.uid)
  );
}

// Ieder bandlid in een sessie heeft dezelfde functionaliteit: nummer starten,
// nummer wisselen en de sessie beëindigen. Scrollen doet ieder zelf.

/** Stop lokaal met volgen (autoscroll uit, setlist-context weg). */
function stopFollowingLocally() {
  stopAutoScroll();
  state.perform = null;
  state.atSongEnd = false;
  updateSetlistNav();
  updateScrollButton();
}

/** Verwerk een update van het actieve sessie-document. */
function handleSessionUpdate(session) {
  const prev = state.session;
  const wasMember =
    !!prev && !!state.user &&
    (prev.members || []).some((m) => m.uid === state.user.uid);

  state.session = session;
  renderSessionBar();

  if (!session) {
    if (wasMember) stopFollowingLocally();
    return;
  }

  const isMemberNow = (session.members || []).some((m) => m.uid === state.user?.uid);
  if (!isMemberNow) {
    if (wasMember) stopFollowingLocally();
    return;
  }

  // De uitvoerder van een sessie-actie heeft lokaal al gehandeld; alleen de
  // andere deelnemers volgen de update. Bij oudere sessies zonder actorUid
  // blijft de aanmaker (leaderUid) buiten de follow-loop.
  const actedByMe =
    (session.actorUid && session.actorUid === state.user?.uid) ||
    (!session.actorUid && session.leaderUid === state.user?.uid);
  if (actedByMe) return;

  sessionFollowSeq++;
  followSession(session, prev, sessionFollowSeq);
}

/** Als deelnemer: open het nummer van de sessie; start autoscroll alleen wanneer
 *  een bandlid het nummer voor iedereen heeft gestart. */
async function followSession(session, prev, seq) {
  const songIds = Array.isArray(session.songIds) ? session.songIds : [];
  const index = Math.max(0, Math.min(session.songIndex || 0, songIds.length - 1));
  const songId = songIds[index];
  if (!songId) return;

  const alreadyThere =
    isLiveMode() &&
    state.currentSong?.id === songId &&
    state.perform?.index === index;

  if (!alreadyThere) {
    const desc = { view: "song", id: songId, perform: { songIds, index } };
    if (prev) history.replaceState(desc, "");
    else history.pushState(desc, "");
    await openSong(songId, { songIds, index });
    // Als er tijdens het laden al een nieuwere sessie-update was: stop.
    if (seq !== sessionFollowSeq) return;
  }

  // Een bandlid start het liedje (playing=true) één keer voor alle deelnemers.
  // Daarna scrollt ieder zelf; een lokale pauze van een ander stopt niemand.
  const latest = state.session;
  if (latest?.playing) {
    state.autoscroll = true;
    if (!autoScrolling && autoScrollPxPerSec() > 0) startAutoScroll();
    updateScrollButton();
  }
}

/** Render de sessiebalk bovenaan de app (alle deelnemers krijgen de knoppen). */
function renderSessionBar() {
  const bar = $("#sessionBar");
  if (!bar) return;
  const s = state.session;
  if (!s) {
    bar.classList.add("hidden");
    return;
  }

  bar.classList.remove("hidden");
  $("#sessionBarName").textContent = s.setlistName || "Setlist";
  const creatorName = memberDisplayName(s.leaderName);
  const counter = `Nummer ${(s.songIndex ?? 0) + 1} / ${(s.songIds || []).length}`;
  const isMember = (s.members || []).some((m) => m.uid === state.user?.uid);
  $("#sessionBarSub").textContent =
    `Aangemaakt door ${creatorName} · ${counter}` +
    (isMember ? " · je doet mee" : " · je doet niet mee");

  const stateEl = $("#sessionBarState");
  const playBtn = $("#sessionPlayBtn");
  const endBtn = $("#sessionEndBtn");

  if (isMember) {
    endBtn.classList.remove("hidden");
    if (s.playing) {
      stateEl.textContent = "▶ gestart · ieder scrolt zelf";
      playBtn.classList.add("hidden");
    } else {
      stateEl.textContent = "⏸ nog niet gestart";
      playBtn.classList.remove("hidden");
      playBtn.textContent = "▶ Start liedje";
      playBtn.title = "Liedje starten (autoscroll) voor alle deelnemers";
    }
  } else {
    endBtn.classList.add("hidden");
    playBtn.classList.add("hidden");
    stateEl.textContent = "je doet niet mee";
  }
}

/** Vergelijk twee string-arrays op gelijke inhoud. */
function sameStringArray(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((v, i) => v === b[i]);
}

/** Broadcast als deelnemer: huidig nummer (en eventueel de volgorde) wijzigen. */
function broadcastSessionSong(songIds, index) {
  if (!isSessionMember() || !state.session) return;
  if (sameStringArray(state.session.songIds, songIds) && state.session.songIndex === index) return;
  state.session.songIds = (songIds || []).slice();
  state.session.songIndex = index;
  state.session.playing = false; // nieuw nummer: straks start iemand het opnieuw voor iedereen
  state.session.actorUid = state.user.uid;
  renderSessionBar();
  updateSession({
    songIds: state.session.songIds,
    songIndex: index,
    playing: false,
    actorUid: state.user.uid,
  }).catch((e) =>
    console.error("Sessie bijwerken mislukt:", e)
  );
}

/** Broadcast als deelnemer: het huidige liedje starten voor alle deelnemers. */
function broadcastSessionPlaying(playing) {
  if (!isSessionMember() || !state.session) return;
  if (state.session.playing === playing) return;
  state.session.playing = playing;
  state.session.actorUid = state.user.uid;
  renderSessionBar();
  updateSession({ playing, actorUid: state.user.uid }).catch((e) =>
    console.error("Sessie bijwerken mislukt:", e)
  );
}

/** Kandidaten voor de deelnemerslijst (alle bekende bandleden behalve ikzelf). */
function sessionMemberCandidates() {
  const now = Date.now();
  const seen = new Set();
  const list = [];
  for (const p of state.presenceList || []) {
    if (!p || p.id === state.user?.uid) continue;
    if (seen.has(p.id)) continue;
    seen.add(p.id);
    list.push({
      uid: p.id,
      name: p.name || "",
      online: now - toMillis(p.lastSeen) < PRESENCE_ONLINE_MS,
    });
  }
  list.sort((a, b) => (a.online === b.online ? 0 : a.online ? -1 : 1));
  return list;
}

/** Open de "start sessie"-modal en vul de deelnemerslijst. */
function openSessionModal() {
  if (!state.currentSetlist?.id) {
    alert("Selecteer eerst een setlist.");
    return;
  }
  if (!state.setlistSongIds.length) {
    alert("Voeg eerst liedjes toe aan de setlist.");
    return;
  }
  if (state.session) {
    if (!confirm(`Er loopt al een sessie (van ${memberDisplayName(state.session.leaderName)}). Een nieuwe sessie starten vervangt deze. Doorgaan?`)) {
      return;
    }
  }

  $("#sessionModalSetlist").textContent =
    `${state.currentSetlist.name || "Setlist"} · ${state.setlistSongIds.length} nummers`;

  const listEl = $("#sessionMembersList");
  listEl.innerHTML = "";
  const candidates = sessionMemberCandidates();
  if (!candidates.length) {
    listEl.innerHTML =
      '<p class="text-sm text-gray-400 italic">Geen andere bandleden bekend. De sessie start met jou alleen.</p>';
  } else {
    for (const m of candidates) {
      const row = document.createElement("label");
      row.className = "flex items-center gap-2 text-sm py-1 cursor-pointer select-none";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = m.online; // online leden staan standaard aangevinkt
      cb.className = "accent-green-600 shrink-0";
      cb.dataset.uid = m.uid;
      cb.dataset.name = m.name || "";
      const span = document.createElement("span");
      span.className = "truncate";
      span.textContent = memberDisplayName(m.name) + (m.online ? "" : " (offline)");
      row.appendChild(cb);
      row.appendChild(span);
      listEl.appendChild(row);
    }
  }

  $("#sessionModal").classList.remove("hidden");
}

/** Sluit de "start sessie"-modal. */
function closeSessionModal() {
  $("#sessionModal").classList.add("hidden");
}

/** Start de sessie daadwerkelijk (aanmaker + aangevinkte deelnemers). */
async function confirmSessionStart() {
  if (!state.currentSetlist?.id || !state.setlistSongIds.length) return;

  if (state.session) {
    if (!confirm(`Er loopt al een sessie (van ${memberDisplayName(state.session.leaderName)}). Een nieuwe sessie starten vervangt deze. Doorgaan?`)) {
      return;
    }
  }

  const members = [{ uid: state.user.uid, name: state.user.email || "" }];
  document.querySelectorAll("#sessionMembersList input[type=checkbox]:checked").forEach((cb) => {
    if (cb.dataset.uid && cb.dataset.uid !== state.user.uid) {
      members.push({ uid: cb.dataset.uid, name: cb.dataset.name || "" });
    }
  });

  const songIds = state.setlistSongIds.slice();
  const payload = {
    setlistId: state.currentSetlist.id,
    setlistName: state.currentSetlist.name || "",
    leaderUid: state.user.uid,
    leaderName: state.user.email || "",
    members,
    songIds,
    songIndex: 0,
    playing: false,
    actorUid: state.user.uid,
  };

  try {
    await startSession(payload);
    state.session = { id: "active", ...payload };
    renderSessionBar();
    closeSessionModal();
    // Open het eerste nummer; deelnemers volgen via de listener.
    const id = songIds[0];
    navigate(
      { view: "song", id, perform: { songIds, index: 0 } },
      () => openSong(id, { songIds, index: 0 })
    );
  } catch (ex) {
    console.error("Sessie starten mislukt:", ex);
    alert("Sessie starten mislukt. Controleer je verbinding.");
  }
}

/** Start het huidige liedje voor alle deelnemers (eenmalig per nummer). */
async function toggleSessionPlayback() {
  if (!isSessionMember() || !state.session) return;
  const s = state.session;

  // Al gestart? Dan scrollt ieder bandlid nu zelf; niemand stopt een ander.
  if (s.playing) return;

  const songIds = Array.isArray(s.songIds) ? s.songIds : [];
  const index = Math.max(0, Math.min(s.songIndex || 0, songIds.length - 1));
  const songId = songIds[index];
  if (!songId) {
    alert("Deze setlist heeft geen liedjes.");
    return;
  }

  // Zorg dat het huidige sessienummer op het scherm staat.
  if (!isLiveMode() || state.currentSong?.id !== songId || state.perform?.index !== index) {
    const desc = { view: "song", id: songId, perform: { songIds, index } };
    history.pushState(desc, "");
    await openSong(songId, { songIds, index });
  }
  state.autoscroll = true;
  if (startAutoScroll()) broadcastSessionPlaying(true);
}

/** Beëindig de sessie voor iedereen. */
async function endCurrentSession() {
  if (!isSessionMember()) return;
  if (!confirm("Sessie beëindigen? Alle deelnemers stoppen met volgen.")) return;
  try {
    await endSession();
    state.session = null;
    stopAutoScroll();
    state.perform = null;
    state.atSongEnd = false;
    renderSessionBar();
    updateSetlistNav();
    updateScrollButton();
    // Terug naar de setlistplanner, tenzij we daar al zijn.
    if ($("#view-setlist").classList.contains("active")) {
      openSetlist();
    } else {
      navigate({ view: "setlist" }, openSetlist);
    }
  } catch (ex) {
    console.error("Sessie beëindigen mislukt:", ex);
    alert("Sessie beëindigen mislukt. Controleer je verbinding.");
  }
}

function toggleFootswitch() {
  state.footswitch ? disableFootswitch() : enableFootswitch();
}
$("#topFootswitch").addEventListener("click", toggleFootswitch);

// ---------------------------------------------------------------------------
//  AUTOSCROLL op basis van BPM
//  Tijd per regel = BEATS_PER_LINE × 60/BPM seconden (× scrollSpeedFactor).
//  De actieve regel wordt tijdgebaseerd berekend en blijft via de generieke
//  scroll-focushelpers altijd op SCROLL_FOCUS_RATIO (50%) van de viewport.
// ---------------------------------------------------------------------------
const BEATS_PER_LINE = 4.7; // 15% langzamer dan 4
let autoScrolling = false;
let autoRaf = null;
let autoLastTs = null;
let autoPos = 0;
let autoElapsedMs = 0;      // verstreken liedtijd binnen de autoscroll
let autoIntroDone = false;  // eerste start van dit liedje → intro-scroll naar regel 1

// ---------------------------------------------------------------------------
//  SCROLL-FOCUS: één bron van waarheid voor "waar staat de actieve regel".
//  De actieve regel hoort op SCROLL_FOCUS_RATIO × viewport-hoogte onder de
//  topbar te staan. Wordt gebruikt door BPM-autoscroll, AI Follow en de
//  intro-scroll.
// ---------------------------------------------------------------------------
const SCROLL_FOCUS_RATIO = 0.25; // actieve regel op 25% van de viewport-hoogte

let songLineElsCache = null;

function invalidateSongLineCache() {
  songLineElsCache = null;
}

/** De .song-line-elementen in documentvolgorde (licht gecacht). */
function songLineEls() {
  if (!songLineElsCache) {
    songLineElsCache = Array.from(document.querySelectorAll("#songBody .song-line"));
  }
  return songLineElsCache;
}

/** Hoogte van de topbar, indien zichtbaar. */
function scrollTopbarOffset() {
  const topbar = document.getElementById("topbar");
  return topbar && !topbar.classList.contains("hidden") ? topbar.offsetHeight : 0;
}

/** Scherm-Y waarop de actieve regel moet staan. */
function scrollFocusScreenY() {
  return scrollTopbarOffset() + window.innerHeight * SCROLL_FOCUS_RATIO;
}

/** Maximale scroll-Y van de pagina. */
function maxScrollY() {
  const docHeight = Math.max(document.body.offsetHeight, document.documentElement.scrollHeight);
  return Math.max(0, docHeight - window.innerHeight);
}

/** Klem een scroll-Y binnen [0, maxScrollY] (randgevallen eerste/laatste regel). */
function clampScrollY(y) {
  return Math.max(0, Math.min(maxScrollY(), y));
}

/** Document-Y van de bovenkant van regel `lineIndex`. */
function lineDocY(lineIndex) {
  const lines = songLineEls();
  const el = lines[lineIndex];
  if (!el) return null;
  return window.scrollY + el.getBoundingClientRect().top;
}

/** Scroll-Y zodat regel `lineIndex` op de focuspositie (50%) staat. */
function scrollYForLine(lineIndex) {
  const docY = lineDocY(lineIndex);
  if (docY == null) return null;
  return clampScrollY(docY - scrollFocusScreenY());
}

/** Fractionele regelindex die hoort bij scroll-Y `y` (omgekeerde van hieronder). */
function fractionalLineIndexFromScrollY(y) {
  const lines = songLineEls();
  if (!lines.length) return 0;
  const focusDocY = y + scrollFocusScreenY();
  let i0 = -1;
  for (let i = 0; i < lines.length; i++) {
    const top = window.scrollY + lines[i].getBoundingClientRect().top;
    if (top <= focusDocY) i0 = i; else break;
  }
  if (i0 < 0) return 0;
  if (i0 >= lines.length - 1) return lines.length - 1;
  const y0 = window.scrollY + lines[i0].getBoundingClientRect().top;
  const y1 = window.scrollY + lines[i0 + 1].getBoundingClientRect().top;
  const span = y1 - y0;
  return span > 0 ? i0 + (focusDocY - y0) / span : i0;
}

/** Integer regelindex bij scroll-Y (voor debug en AI Follow-verwachting). */
function lineIndexFromScrollY(y) {
  return Math.floor(fractionalLineIndexFromScrollY(y));
}

/** Scroll-Y zodat fractionele regelpositie `f` op 50% staat (interpoleert). */
function scrollYForFractionalLine(f) {
  const lines = songLineEls();
  if (!lines.length) return 0;
  const last = lines.length - 1;
  const clamped = Math.max(0, Math.min(last, f));
  const i0 = Math.floor(clamped);
  const frac = clamped - i0;
  const y0 = window.scrollY + lines[i0].getBoundingClientRect().top;
  const y1 = i0 < last
    ? window.scrollY + lines[i0 + 1].getBoundingClientRect().top
    : y0 + avgLineHeight();
  const docY = y0 + (y1 - y0) * frac;
  return clampScrollY(docY - scrollFocusScreenY());
}

// Gemiddelde on-screen hoogte van een tekstregel (secties schalen verschillend).
function avgLineHeight() {
  const lines = songLineEls();
  if (!lines.length) return 0;
  let sum = 0, n = 0;
  lines.forEach((l) => {
    const h = l.offsetHeight;
    if (h > 0) { sum += h; n++; }
  });
  return n ? sum / n : 0;
}

/** Seconden per regel, gecorrigeerd met de per-liedje scrollfactor. */
function effectiveSecondsPerLine() {
  const bpm = Number(state.currentSong?.bpm) || 0;
  if (bpm <= 0) return Infinity;
  const factor = Number(state.currentSong?.scrollSpeedFactor) || 1.0;
  return (BEATS_PER_LINE * 60) / bpm / factor;
}

/** Benadering in px/s (wordt gebruikt als validatie en door andere callers). */
function autoScrollPxPerSec() {
  const bpm = Number(state.currentSong?.bpm) || 0;
  const lh = avgLineHeight();
  if (bpm <= 0 || lh <= 0) return 0;
  const secondsPerLine = (BEATS_PER_LINE * 60) / bpm;
  let speed = lh / secondsPerLine;
  const factor = Number(state.currentSong?.scrollSpeedFactor) || 1.0;
  speed *= factor;
  return speed;
}

function autoStep(ts) {
  if (autoLastTs == null) autoLastTs = ts;
  const dt = (ts - autoLastTs) / 1000;
  autoLastTs = ts;

  if (autoScrollPxPerSec() <= 0) { stopAutoScroll(); return; }

  const secPerLine = effectiveSecondsPerLine();
  if (!isFinite(secPerLine) || secPerLine <= 0) { stopAutoScroll(); return; }

  // Tijdgebaseerd regelanker: welke (fractionele) regel is nu actief?
  autoElapsedMs += dt * 1000;
  const activeLine = autoElapsedMs / 1000 / secPerLine;

  // Zet die regel op de focuspositie van de viewport.
  autoPos = scrollYForFractionalLine(activeLine);

  window.scrollTo(0, autoPos);

  // Einde liedje: de laatste regel is op de focuspositie geweest.
  if (activeLine >= songLineEls().length - 1) {
    stopAutoScroll();
    updateEndArming({ forceEnd: true });
    return;
  }

  // Vangnet: stop ook als de effectieve bodem bereikt is (de laatste regel
  // kan niet altijd gecentreerd worden; dan verzachten we richting de bodem).
  const max = maxScrollY();
  if (max > 1 && window.scrollY >= max - 1) {
    stopAutoScroll();
    updateEndArming();
    return;
  }

  autoRaf = requestAnimationFrame(autoStep);
}

function startAutoScroll() {
  if (autoScrollPxPerSec() <= 0) {
    alert("Stel eerst een BPM in voor dit liedje om autoscroll te gebruiken.");
    return false;
  }
  autoScrolling = true;
  setMediaSessionPlaybackState("playing");
  updateScrollButton();

  const secPerLine = effectiveSecondsPerLine();

  // Alleen bij de éérste start van dit liedje vloeiend naar de eerste regel
  // (op 50%). Bij hervatten reconstrueren we de verstreken tijd uit de
  // huidige scrollpositie, zodat er geen sprong is.
  if (!autoIntroDone) {
    autoIntroDone = true;
    const target = scrollYForLine(0);
    smoothScrollTo(target == null ? 0 : target, 450, () => {
      if (!autoScrolling) return; // gestopt tijdens de intro-scroll
      autoElapsedMs = 0;
      autoPos = window.scrollY;
      autoLastTs = null;
      autoRaf = requestAnimationFrame(autoStep);
    });
  } else {
    autoElapsedMs = fractionalLineIndexFromScrollY(window.scrollY) * secPerLine * 1000;
    autoPos = window.scrollY;
    autoLastTs = null;
    autoRaf = requestAnimationFrame(autoStep);
  }
  return true;
}

/** Vloeiende scroll-animatie naar `targetY` (gebruikt door de intro-scroll). */
function smoothScrollTo(targetY, durationMs, done) {
  const startY = window.scrollY;
  const dist = targetY - startY;
  if (Math.abs(dist) < 2) {
    done();
    return;
  }

  const startTs = performance.now();
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);

  function frame(ts) {
    if (!autoScrolling) return; // stopzetting tijdens de animatie
    const t = Math.min(1, (ts - startTs) / durationMs);
    window.scrollTo(0, startY + dist * ease(t));
    if (t < 1) {
      autoRaf = requestAnimationFrame(frame);
    } else {
      autoRaf = null;
      done();
    }
  }
  autoRaf = requestAnimationFrame(frame);
}

function stopAutoScroll() {
  autoScrolling = false;
  if (autoRaf) cancelAnimationFrame(autoRaf);
  autoRaf = null;
  setMediaSessionPlaybackState("paused");
  updateScrollButton();
}

// Werk het uiterlijk/functie van de blauwe knop bij aan de gekozen modus.
function updateScrollButton() {
  const btn = $("#scrollDownBtn");
  if (!btn) return;
  btn.style.display = "";

  // Live-modus én aan het einde: toon de "volgend nummer"-status.
  if (isLiveMode() && state.atSongEnd) {
    const p = state.perform;
    const isLast = p.index >= p.songIds.length - 1;
    if (isLast) {
      btn.innerHTML = '<span class="next-icon">&#10004;</span><span class="next-label">Einde setlist</span>';
      btn.title = "Terug naar het setlist-overzicht";
    } else {
      const next = state.songs.find((s) => s.id === p.songIds[p.index + 1]);
      const title = next ? (next.title || "volgend nummer") : "volgend nummer";
      btn.innerHTML =
        '<span class="next-icon">&#9193;</span>' +
        '<span class="next-label">Volgend:<br><b>' + escapeHtml(title) + "</b></span>";
      btn.title = "Naar het volgende nummer";
    }
    btn.classList.add("next-armed");
    return;
  }

  btn.classList.remove("next-armed");
  if (state.autoscroll || autoScrolling) {
    btn.innerHTML = autoScrolling ? "&#10073;&#10073;" : "&#9654;"; // pauze : play
    btn.title = autoScrolling ? "Autoscroll pauzeren" : "Autoscroll starten";
  } else {
    btn.innerHTML = "&#8595;";
    btn.title = "Naar beneden scrollen";
  }
}

function toggleAutoscrollMode() {
  state.autoscroll = !state.autoscroll;
  if (!state.autoscroll) stopAutoScroll();
  $("#topAutoscrollState").textContent = state.autoscroll ? "aan" : "uit";
  $("#topAutoscroll").classList.toggle("footswitch-btn-on", state.autoscroll);
  updateScrollButton();
}
$("#topAutoscroll").addEventListener("click", toggleAutoscrollMode);

function enableFootswitch() {
  state.footswitch = true;
  $("#topFootswitchState").textContent = "aan";
  $("#topFootswitch").classList.add("footswitch-btn-on");
  $("#view-song").classList.add("footswitch-on");
}
function disableFootswitch() {
  state.footswitch = false;
  $("#topFootswitchState").textContent = "uit";
  $("#topFootswitch").classList.remove("footswitch-btn-on");
  $("#view-song").classList.remove("footswitch-on");
}

// ===========================================================================
//  SONG EDITOR
// ===========================================================================
async function openEditor(id) {
  state.editingId = id;
  showView("editor");
  resetTranspose();  // transpositie-schuif terug naar 0
  $("#editorError").classList.add("hidden");
  $("#pdfStatus").className = "text-xs hidden";
  $("#fBulk").value = "";

  if (id) {
    $("#editorTitle").textContent = "Liedje bewerken";
    const song = state.currentSong?.id === id ? state.currentSong : await getSong(id);
    ensureSectionIds(song);
    $("#fTitle").value = song.title || "";
    $("#fArtist").value = song.artist || "";
    $("#fCapo").value = song.capo || 0;
    $("#fBpm").value = song.bpm || 0;
    $("#fScrollFactor").value = song.scrollSpeedFactor || 1.0;
    $("#fSpotify").value = songLink(song);
    renderSectionsEditor(song.content || []);
  } else {
    $("#editorTitle").textContent = "Nieuw liedje";
    $("#songForm").reset();
    $("#fCapo").value = 0;
    $("#fBpm").value = 0;
    $("#fScrollFactor").value = 1.0;
    renderSectionsEditor([]);
    addSection("verse"); // start met één leeg couplet
  }
}

// --- Sectiekaarten ---------------------------------------------------------
const SECTION_OPTIONS = [
  ["verse", "Couplet"], ["chorus", "Refrein"], ["solo", "Solo"], ["bridge", "Bridge"],
  ["intro", "Intro"], ["outro", "Outro"], ["interlude", "Tussenspel"], ["pre-chorus", "Pre-refrein"],
];

/** Vul de secties-lijst met kaarten op basis van content[]. */
function renderSectionsEditor(content) {
  const list = $("#sectionsList");
  list.innerHTML = "";
  for (const section of content) {
    list.appendChild(createSectionCard(section));
  }
  updateSectionsUi();
}

/** Laat een sectie-textarea meegroeien met de inhoud (volledig leesbaar). */
function autosizeTextarea(el) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

/** Maak één bewerkbare sectiekaart. */
function createSectionCard(section) {
  const card = document.createElement("div");
  card.className = "section-card";
  card.dataset.id = section.id || newId();

  const typeOpts = SECTION_OPTIONS.map(
    ([v, l]) => `<option value="${v}"${v === section.type ? " selected" : ""}>${l}</option>`
  ).join("");

  card.innerHTML = `
    <div class="section-card-head">
      <select class="sc-type">${typeOpts}</select>
      <div class="sc-actions">
        <button type="button" class="sc-up" title="Omhoog">↑</button>
        <button type="button" class="sc-down" title="Omlaag">↓</button>
        <button type="button" class="sc-del" title="Sectie verwijderen">🗑</button>
      </div>
    </div>
    <textarea class="sc-lines editor-line-mono" rows="4"
      placeholder="Em      A&#10;Tien tegen een dat ik mijn mond houd&#10;of inline: [Em]Tien tegen een dat ik mijn [A]mond houd"></textarea>`;

  const lines = card.querySelector(".sc-lines");
  lines.value = serializeLines(section.lines || []);
  // Laat het vak meegroeien met de inhoud, zodat de hele sectie leesbaar is.
  requestAnimationFrame(() => autosizeTextarea(lines));

  // Events
  card.querySelector(".sc-type").addEventListener("change", () => { renderEditorPreview(); });
  lines.addEventListener("input", () => {
    autosizeTextarea(lines);
    renderEditorPreview();
  });
  card.querySelector(".sc-del").addEventListener("click", () => {
    if (confirm("Deze sectie verwijderen?")) { card.remove(); updateSectionsUi(); renderEditorPreview(); }
  });
  card.querySelector(".sc-up").addEventListener("click", () => moveCard(card, -1));
  card.querySelector(".sc-down").addEventListener("click", () => moveCard(card, 1));

  return card;
}

/** Verplaats een kaart één plek omhoog (-1) of omlaag (1). */
function moveCard(card, dir) {
  if (dir < 0 && card.previousElementSibling) {
    card.parentNode.insertBefore(card, card.previousElementSibling);
  } else if (dir > 0 && card.nextElementSibling) {
    card.parentNode.insertBefore(card.nextElementSibling, card);
  }
  renderEditorPreview();
}

/** Voeg onderaan een nieuwe (lege) sectie toe van het gekozen type. */
function addSection(type) {
  const card = createSectionCard({ id: newId(), type, lines: [] });
  $("#sectionsList").appendChild(card);
  updateSectionsUi();
  renderEditorPreview();
  card.querySelector(".sc-lines").focus();
}

/** Toon/verberg de 'geen secties'-melding. */
function updateSectionsUi() {
  const has = $("#sectionsList").children.length > 0;
  $("#sectionsEmpty").classList.toggle("hidden", has);
}

/** Bouw content[] uit de huidige kaarten (volgorde = DOM-volgorde). */
function buildContentFromCards() {
  const cards = [...$("#sectionsList").children];
  return cards.map((card) => ({
    id: card.dataset.id,
    type: card.querySelector(".sc-type").value,
    lines: parseSongText(card.querySelector(".sc-lines").value).flatMap((s) => s.lines),
  }));
}

$("#addSectionBtn").addEventListener("click", () => addSection($("#newSectionType").value));

// Live voorbeeld op basis van de kaarten.
function renderEditorPreview() {
  const preview = $("#editorPreview");
  const content = buildContentFromCards();
  preview.innerHTML = "";
  const hasContent = content.some((s) => s.lines.length);
  if (!hasContent) {
    preview.innerHTML = `<p class="text-gray-400 text-sm">Nog geen inhoud…</p>`;
    return;
  }
  for (const section of content) {
    preview.appendChild(renderSection(section));
  }
}

// --- Transponeren van alle akkoorden ---------------------------------------

let transposePrev = 0;

/** Zet de transpositie-schuif terug naar 0 (bij openen/import van een liedje). */
function resetTranspose() {
  transposePrev = 0;
  const slider = $("#transposeSlider");
  if (slider) slider.value = 0;
  updateTransposeLabel(0);
}

/** Werk het getal naast de schuif bij (0, +2, -3, …). */
function updateTransposeLabel(value) {
  const el = $("#transposeValue");
  if (el) el.textContent = value > 0 ? `+${value}` : String(value);
}

/** Transponeer alle akkoorden in de gegeven (line-by-line) tekst. */
function transposeText(text, semitones) {
  const lines = parseSongText(text).flatMap((s) => s.lines);
  const transposed = lines.map((line) => ({
    ...line,
    chords: (line.chords || []).map((c) => ({ ...c, chord: transposeChordName(c.chord, semitones) })),
  }));
  return serializeLines(transposed);
}

/** Pas een transpositie-delta toe op alle sectie-vakken en de preview. */
function applyTranspose(delta) {
  if (!delta) return;
  document.querySelectorAll("#sectionsList .sc-lines").forEach((ta) => {
    ta.value = transposeText(ta.value, delta);
    autosizeTextarea(ta);
  });
  renderEditorPreview();
}

$("#transposeSlider").addEventListener("input", (e) => {
  const value = Number(e.target.value);
  const delta = value - transposePrev;
  transposePrev = value;
  updateTransposeLabel(value);
  if (delta) applyTranspose(delta);
});

// --- PDF import (drag & drop) ----------------------------------------------
const pdfDrop = $("#pdfDrop");
const pdfInput = $("#pdfInput");

// Let op: geen JS-click op de dropzone — die is een <label for="pdfInput">,
// waardoor het bestandsvenster nativef opent (voorkomt de klik-bubble-loop).
pdfInput.addEventListener("change", (e) => {
  if (e.target.files?.[0]) handlePdfFile(e.target.files[0]);
  pdfInput.value = ""; // sta hetzelfde bestand opnieuw kiezen toe
});

["dragenter", "dragover"].forEach((ev) =>
  pdfDrop.addEventListener(ev, (e) => {
    e.preventDefault();
    pdfDrop.classList.add("border-blue-500", "bg-blue-50");
  })
);
["dragleave", "drop"].forEach((ev) =>
  pdfDrop.addEventListener(ev, (e) => {
    e.preventDefault();
    pdfDrop.classList.remove("border-blue-500", "bg-blue-50");
  })
);
pdfDrop.addEventListener("drop", (e) => {
  const file = e.dataTransfer?.files?.[0];
  if (file) handlePdfFile(file);
});

async function handlePdfFile(file) {
  if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
    setPdfStatus("Kies een PDF-bestand.", "error");
    return;
  }
  setPdfStatus("📄 Bezig met inlezen van de PDF…", "info");
  try {
    const buffer = await file.arrayBuffer();
    const text = await pdfToText(buffer);
    if (!text.trim()) {
      setPdfStatus("Geen tekst gevonden in deze PDF (mogelijk een gescande afbeelding).", "error");
      return;
    }

    // Vul de titel automatisch uit de bestandsnaam als die nog leeg is.
    if (!$("#fTitle").value.trim()) {
      $("#fTitle").value = file.name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();
    }
    // Vul titel/artiest uit de eerste regels van de PDF-tekst
    const songText = applyHeaderMeta(text);

    const content = withSectionIds(parseSongText(songText));
    if (!importIntoSections(content)) {
      setPdfStatus("Import geannuleerd.", "info");
      return;
    }
    setPdfStatus(`✓ PDF geïmporteerd (${content.length} secties). Controleer en sla op.`, "ok");
  } catch (ex) {
    console.error(ex);
    setPdfStatus("Kon de PDF niet verwerken. Controleer je internetverbinding (PDF.js wordt via CDN geladen).", "error");
  }
}

/** Ken elke geparste sectie een id toe. */
function withSectionIds(content) {
  return content.map((s) => ({ ...s, id: s.id || newId() }));
}

/** Vervang de sectiekaarten door geïmporteerde content (met bevestiging). */
function importIntoSections(content) {
  if (!content.length) return false;
  if ($("#sectionsList").children.length && !confirm("Bestaande secties vervangen door de import?")) {
    return false;
  }
  renderSectionsEditor(content);
  resetTranspose();  // nieuwe inhoud → transpositie terug naar 0
  renderEditorPreview();
  return true;
}

// Bulk-tekst -> secties
$("#bulkToSections").addEventListener("click", () => {
  const raw = $("#fBulk").value;
  if (!raw.trim()) { setPdfStatus("Plak eerst wat tekst.", "error"); return; }
  const songText = applyHeaderMeta(raw);
  const content = withSectionIds(parseSongText(songText));
  if (importIntoSections(content)) {
    $("#fBulk").value = "";
    setPdfStatus(`✓ ${content.length} secties aangemaakt uit de geplakte tekst.`, "ok");
  }
});

/** Haal titel, artiest en capo uit regels vóór de eerste sectie-header, en
 *  retourneer de opgeschoonde tekst zonder deze kopregels. */
function stripHeaderFromText(raw) {
  const lines = (raw || "").replace(/\r\n/g, "\n").split("\n");
  const meta = { title: "", artist: "", capo: "" };
  let headerEnd = 0;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed === "") { headerEnd = i + 1; continue; }
    // Stop bij de eerste sectie-header zoals [Verse], [Chorus], etc.
    if (/^\[.+\]$/.test(trimmed)) break;
    // Herken Capo
    const capoMatch = trimmed.match(/^capo\s*:?\s*(\d+)$/i);
    if (capoMatch) {
      meta.capo = capoMatch[1];
      headerEnd = i + 1;
      continue;
    }
    // Negeer regels die alleen uit akkoorden bestaan
    if (/^[A-G](#|b)?(maj|min|m|dim|aug|sus|add|\+)?[0-9]*(?:\s|$)/.test(trimmed)) {
      headerEnd = i + 1;
      continue;
    }
    // Eerste niet-lege, niet-akkoord regel
    if (!meta.title) {
      // Als de regel een komma bevat: "Liedje, Artiest"
      const commaIdx = trimmed.indexOf(",");
      if (commaIdx > 0) {
        meta.title = trimmed.slice(0, commaIdx).trim();
        meta.artist = trimmed.slice(commaIdx + 1).trim();
      } else {
        meta.title = trimmed;
      }
    } else if (!meta.artist) {
      meta.artist = trimmed;
      headerEnd = i + 1;
      break;
    }
    headerEnd = i + 1;
  }

  const body = lines.slice(headerEnd).join("\n");
  return { ...meta, body };
}

/** Vul titel/artiest/capo in uit de kopregels, en retourneer opgeschoonde tekst. */
function applyHeaderMeta(raw) {
  const { title, artist, capo, body } = stripHeaderFromText(raw);
  if (title && !$("#fTitle").value.trim()) $("#fTitle").value = title;
  if (artist && !$("#fArtist").value.trim()) $("#fArtist").value = artist;
  if (capo && !$("#fCapo").value) $("#fCapo").value = capo;
  return body;
}

function setPdfStatus(msg, type) {
  const el = $("#pdfStatus");
  el.textContent = msg;
  el.className =
    "text-xs " +
    { ok: "text-green-600", error: "text-red-600", info: "text-gray-500" }[type];
}

// --- Spotify gegevens ophalen (titel + artiest) ------------------------------
// De Cloud Function `fetchSpotifySong` haalt titel + artiest server-side op,
// omdat Spotify's embed-pagina (waar de artiest in staat) geen CORS-headers
// meestuurt en dus niet rechtstreeks vanuit de browser te lezen is.
// Pas de regio aan als je de functie in een andere regio deployt.
const SPOTIFY_FUNCTION_URL =
  "https://us-central1-band-admin-76dad.cloudfunctions.net/fetchSpotifySong";

/** Extraheer de track-id uit een Spotify-tracklink (of null). */
function spotifyTrackId(url) {
  const m = /open\.spotify\.com\/track\/([A-Za-z0-9]+)/.exec(url || "");
  return m ? m[1] : null;
}

/** Toon/verberg de statusmelding onder het Spotify-veld. */
function setSpotifyStatus(msg, type) {
  const el = $("#spotifyStatus");
  if (!msg) {
    el.classList.add("hidden");
    return;
  }
  el.textContent = msg;
  el.className =
    "text-xs mt-1 " +
    { ok: "text-green-600", error: "text-red-600", info: "text-gray-500" }[type];
}

$("#fetchSpotifyBtn").addEventListener("click", async () => {
  const url = $("#fSpotify").value.trim();
  const btn = $("#fetchSpotifyBtn");
  setSpotifyStatus("", null);

  if (!url) {
    setSpotifyStatus("Voer eerst een Spotify-link in.", "error");
    return;
  }
  if (!spotifyTrackId(url)) {
    setSpotifyStatus("Dat is geen geldige Spotify-tracklink (open.spotify.com/track/…).", "error");
    return;
  }

  btn.disabled = true;
  setSpotifyStatus("Bezig met ophalen…", "info");
  try {
    const res = await fetch(`${SPOTIFY_FUNCTION_URL}?url=${encodeURIComponent(url)}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.title) {
      throw new Error(data.error || "Geen titel gevonden");
    }
    $("#fTitle").value = data.title;
    if (data.artist) $("#fArtist").value = data.artist;
    setSpotifyStatus("Gegevens opgehaald!", "ok");
  } catch (ex) {
    console.error(ex);
    setSpotifyStatus("Kon geen gegevens ophalen. Controleer de link of je verbinding.", "error");
  } finally {
    btn.disabled = false;
  }
});

$("#topCancelEdit").addEventListener("click", () => {
  // De annuleerknop gedraagt zich hetzelfde als de hardware-/browser-terugknop:
  // naar de vorige pagina. De popstate-handler herstelt dan de juiste view.
  history.back();
});

$("#songForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("#editorError");
  err.classList.add("hidden");

  const data = {
    title: $("#fTitle").value.trim(),
    artist: $("#fArtist").value.trim(),
    capo: Number($("#fCapo").value) || 0,
    bpm: Number($("#fBpm").value) || 0,
    scrollSpeedFactor: Math.max(0.1, Number($("#fScrollFactor").value) || 1.0),
    spotifyUrl: $("#fSpotify").value.trim(),
    content: buildContentFromCards(),
  };

  if (!data.title) {
    err.textContent = "Geef het liedje een titel.";
    err.classList.remove("hidden");
    return;
  }

  try {
    if (state.editingId) {
      await updateSong(state.editingId, data);
      history.replaceState({ view: "song", id: state.editingId }, "");
      await openSong(state.editingId);
    } else {
      const newId = await createSong(data);
      history.replaceState({ view: "song", id: newId }, "");
      await openSong(newId);
    }
  } catch (ex) {
    console.error(ex);
    err.textContent = "Opslaan mislukt. Controleer je verbinding en Firestore-regels.";
    err.classList.remove("hidden");
  }
});

// ===========================================================================
//  TODO / TAKENLIJST
// ===========================================================================

const TODO_STORAGE_KEY = "bandAdminTodos";         // oude localStorage-sleutel (voor migratie)
const TODO_MIGRATED_KEY = "bandAdminTodosMigrated"; // marker: migratie al uitgevoerd

const todoState = {
  items: [],      // { id, text, completed, createdAt } — bron: Firestore (gedeeld)
  filter: "all",  // "all" | "active" | "completed"
};

/** Eenmalig: zet oude localStorage-taken over naar de gedeelde Firestore-lijst. */
function migrateLocalTodos() {
  try {
    if (localStorage.getItem(TODO_MIGRATED_KEY)) return;
    localStorage.setItem(TODO_MIGRATED_KEY, "1");
    const raw = localStorage.getItem(TODO_STORAGE_KEY);
    if (!raw) return;
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) return;
    for (const t of items) {
      if (t && t.text) {
        createTodo(t.text, !!t.completed).catch((e) =>
          console.error("Taak migreren mislukt:", e)
        );
      }
    }
    localStorage.removeItem(TODO_STORAGE_KEY);
  } catch (ex) {
    console.error("Taken migreren mislukt:", ex);
  }
}

/** Voeg een nieuwe taak toe (gedeeld met de hele band). */
function addTodo(text) {
  createTodo(text).catch((e) => {
    console.error("Taak toevoegen mislukt:", e);
    alert("Taak toevoegen mislukt. Controleer je verbinding.");
  });
}

/** Toggle completed-status (optimistisch; de live-snapshot bevestigt het). */
function toggleTodo(id) {
  const item = todoState.items.find((t) => t.id === id);
  if (!item) return;
  item.completed = !item.completed;
  renderTodo();
  updateTodoDoc(id, { completed: item.completed }).catch((e) =>
    console.error("Taak bijwerken mislukt:", e)
  );
}

/** Verwijder een taak (optimistisch). */
function deleteTodo(id) {
  todoState.items = todoState.items.filter((t) => t.id !== id);
  renderTodo();
  deleteTodoDoc(id).catch((e) => console.error("Taak verwijderen mislukt:", e));
}

/** Verwijder alle voltooide taken (optimistisch). */
function clearCompleted() {
  const done = todoState.items.filter((t) => t.completed);
  todoState.items = todoState.items.filter((t) => !t.completed);
  renderTodo();
  for (const t of done) {
    deleteTodoDoc(t.id).catch((e) => console.error("Taak verwijderen mislukt:", e));
  }
}

/** Geef gefilterde todos terug op basis van het actieve filter. */
function filteredTodos() {
  if (todoState.filter === "active") return todoState.items.filter((t) => !t.completed);
  if (todoState.filter === "completed") return todoState.items.filter((t) => t.completed);
  return todoState.items;
}

/** Render de volledige todo-UI. */
function renderTodo() {
  const list = todoState.items;
  const filtered = filteredTodos();
  const remaining = list.filter((t) => !t.completed).length;

  // Teller
  $("#todoCounter").textContent =
    remaining === 0
      ? "Alle taken voltooid! 🎉"
      : `Nog ${remaining} ${remaining === 1 ? "taak" : "taken"} open`;

  // Filterknoppen
  document.querySelectorAll(".todo-filter-btn").forEach((btn) => {
    const isActive = btn.dataset.filter === todoState.filter;
    btn.classList.toggle("bg-blue-600", isActive);
    btn.classList.toggle("text-white", isActive);
    btn.classList.toggle("hover:bg-gray-50", !isActive);
  });

  // Lijst
  const listEl = $("#todoList");
  const emptyEl = $("#todoEmpty");
  listEl.innerHTML = "";

  if (!filtered.length) {
    emptyEl.classList.remove("hidden");
  } else {
    emptyEl.classList.add("hidden");
  }

  for (const item of filtered) {
    const li = document.createElement("li");
    li.className =
      "todo-item flex items-center gap-3 px-3 py-2.5 rounded-lg border border-gray-200 hover:border-gray-300 transition group";

    // Checkbox
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = item.completed;
    checkbox.className = "w-5 h-5 rounded border-gray-300 text-blue-600 cursor-pointer shrink-0";
    checkbox.addEventListener("change", () => {
      toggleTodo(item.id);
      renderTodo();
    });
    li.appendChild(checkbox);

    // Tekst
    const span = document.createElement("span");
    span.className = "flex-1 text-sm " + (item.completed ? "line-through text-gray-400" : "text-gray-800");
    span.textContent = item.text;

    // Dubbelklik om te bewerken
    span.addEventListener("dblclick", () => {
      const input = document.createElement("input");
      input.type = "text";
      input.value = item.text;
      input.className =
        "flex-1 text-sm border border-blue-400 rounded px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-blue-500";
      input.addEventListener("blur", () => finishEdit(input, item));
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") finishEdit(input, item);
        if (e.key === "Escape") { input.value = item.text; finishEdit(input, item); }
      });
      span.replaceWith(input);
      input.focus();
      input.select();
    });
    li.appendChild(span);

    // Verwijderknop
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className =
      "shrink-0 w-7 h-7 flex items-center justify-center rounded text-gray-300 hover:text-red-600 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition";
    delBtn.textContent = "✕";
    delBtn.title = "Verwijderen";
    delBtn.addEventListener("click", () => {
      deleteTodo(item.id);
      renderTodo();
    });
    li.appendChild(delBtn);

    listEl.appendChild(li);
  }

  // Footer (clear completed)
  const completedCount = list.filter((t) => t.completed).length;
  $("#todoFooter").classList.toggle("hidden", completedCount === 0);
}

/** Rond bewerken af: vervang de input weer door de span. */
function finishEdit(input, item) {
  const newText = input.value.trim();
  if (newText && newText !== item.text) {
    item.text = newText;
    updateTodoDoc(item.id, { text: newText }).catch((e) =>
      console.error("Taak bijwerken mislukt:", e)
    );
  }
  renderTodo();
}

/** Open de todo-view. */
function openTodo() {
  showView("todo");
  todoState.filter = "all";
  renderTodo();
  $("#todoInput").focus();
}

// --- Event handlers ---------------------------------------------------------

// Knop in settings-view
$("#openTodoBtn").addEventListener("click", () => navigate({ view: "todo" }, openTodo));

// "+ Nieuw liedje" knop op de todo-pagina
$("#todoNewSongBtn").addEventListener("click", () => navigate({ view: "editor", id: null }, () => openEditor(null)));

// Todo toevoegen
$("#todoForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("#todoInput");
  const text = input.value.trim();
  if (!text) return;
  addTodo(text);
  input.value = "";
  todoState.filter = "all";
  renderTodo();
  input.focus();
});

// Filterknoppen
document.querySelectorAll(".todo-filter-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    todoState.filter = btn.dataset.filter;
    renderTodo();
  });
});

// Voltooide taken verwijderen
$("#clearCompletedBtn").addEventListener("click", () => {
  if (!confirm("Alle voltooide taken verwijderen?")) return;
  clearCompleted();
  todoState.filter = "all";
  renderTodo();
});

// ===========================================================================
//  AKKOORDENBEHEER (CRUD voor de 'chords' collectie)
// ===========================================================================

/** Open de akkoordenbeheerpagina. */
function openChords() {
  showView("chords");
  resetChordForm();
  loadChordsList();
}

/** Reset het formulier naar 'nieuw akkoord'-modus. */
function resetChordForm() {
  $("#chordEditId").value = "";
  $("#chordFormTitle").textContent = "Nieuw akkoord toevoegen";
  $("#fChordName").value = "";
  $("#fBaseFret").value = 1;
  for (let i = 0; i < 6; i++) {
    const el = document.getElementById(`fFret${i}`);
    if (el) el.value = i === 0 ? -1 : i === 5 ? 0 : 2;
  }
  for (let i = 0; i < 6; i++) {
    const el = document.getElementById(`fFinger${i}`);
    if (el) el.value = 0;
  }
  $("#chordCancelBtn").classList.add("hidden");
  $("#chordPreviewSvg").classList.add("hidden");
  $("#chordPreviewMobile").classList.add("hidden");
}

/** Lees de huidige formulierwaarden uit. */
function readChordForm() {
  const frets = [];
  const fingers = [];
  for (let i = 0; i < 6; i++) {
    const fretVal = parseInt(document.getElementById(`fFret${i}`)?.value);
    frets.push(Number.isNaN(fretVal) ? -1 : fretVal);
    fingers.push(parseInt(document.getElementById(`fFinger${i}`)?.value) || 0);
  }
  const baseFretVal = parseInt($("#fBaseFret").value);
  return {
    chordName: $("#fChordName").value.trim(),
    baseFret: Number.isNaN(baseFretVal) ? 1 : baseFretVal,
    frets,
    fingers,
  };
}

/** Vul het formulier met bestaande data (bewerk-modus). */
function fillChordForm(chordData) {
  $("#chordEditId").value = chordData.id || chordData.chordName;
  $("#chordFormTitle").textContent = `Akkoord bewerken: ${chordData.chordName}`;
  $("#fChordName").value = chordData.chordName || "";
  $("#fBaseFret").value = chordData.baseFret != null ? chordData.baseFret : 1;
  const frets = chordData.frets || [-1, -1, -1, -1, -1, -1];
  const fingers = chordData.fingers || [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < 6; i++) {
    const elF = document.getElementById(`fFret${i}`);
    if (elF) elF.value = frets[i] != null ? frets[i] : -1;
    const elG = document.getElementById(`fFinger${i}`);
    if (elG) elG.value = fingers[i] != null ? fingers[i] : 0;
  }
  $("#chordCancelBtn").classList.remove("hidden");
  updateChordPreview();
}

/** Live preview van het akkoord in het formulier. */
function updateChordPreview() {
  const data = readChordForm();
  if (!data.chordName) {
    $("#chordPreviewSvg").classList.add("hidden");
    $("#chordPreviewMobile").classList.add("hidden");
    return;
  }
  try {
    const svg = renderChordSVG(data);
    $("#chordPreviewSvg").innerHTML = svg;
    $("#chordPreviewSvg").classList.remove("hidden");
    $("#chordPreviewMobile").innerHTML = svg;
    $("#chordPreviewMobile").classList.remove("hidden");
  } catch (ex) {
    // negeer renderfouten tijdens typen
  }
}

/** Laad en render de akkoordenlijst. */
async function loadChordsList(filter = "") {
  const list = $("#chordsList");
  list.innerHTML = '<p class="text-gray-400 text-sm italic">Laden…</p>';

  let chords = [];
  try {
    chords = await getAllChords();
    // Update lokale cache
    for (const ch of chords) {
      state.chordCache[ch.id] = ch;
    }
  } catch (ex) {
    console.error("Akkoorden laden mislukt:", ex);
    // Gebruik cache als fallback
    chords = Object.values(state.chordCache);
  }

  const term = filter.toLowerCase().trim();
  if (term) {
    chords = chords.filter((c) => (c.id || "").toLowerCase().includes(term));
  }
  chords.sort((a, b) => (a.id || "").localeCompare(b.id || ""));

  list.innerHTML = "";
  if (!chords.length) {
    $("#chordsEmpty").classList.remove("hidden");
  } else {
    $("#chordsEmpty").classList.add("hidden");
  }

  for (const ch of chords) {
    const card = document.createElement("div");
    card.className = "bg-white rounded-xl shadow-sm hover:shadow-md transition flex items-center";

    // Mini preview SVG
    const preview = document.createElement("div");
    preview.className = "shrink-0 p-2";
    try {
      const miniSvg = renderChordSVG(ch);
      preview.innerHTML = miniSvg.replace(/width="[^"]*"/, 'width="50"').replace(/height="[^"]*"/, 'height="50"');
    } catch (_) {
      preview.innerHTML = `<div class="w-[50px] h-[50px] bg-gray-100 rounded flex items-center justify-center text-gray-400 text-xs">?</div>`;
    }

    const info = document.createElement("button");
    info.className = "flex-1 text-left p-3 min-w-0";
    info.innerHTML = `<div class="font-semibold">${escapeHtml(ch.id || "?")}</div>`;
    info.addEventListener("click", () => {
      fillChordForm(ch);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    const del = document.createElement("button");
    del.className = "shrink-0 px-4 py-4 text-gray-300 hover:text-red-600";
    del.textContent = "🗑";
    del.title = "Akkoord verwijderen";
    del.addEventListener("click", () => onDeleteChord(ch));

    card.appendChild(preview);
    card.appendChild(info);
    card.appendChild(del);
    list.appendChild(card);
  }
}

/** Verwijder een akkoord. */
async function onDeleteChord(chord) {
  if (!confirm(`Akkoord "${chord.id}" verwijderen?`)) return;
  try {
    await deleteChord(chord.id);
    delete state.chordCache[chord.id];
    const term = $("#chordSearch").value;
    loadChordsList(term);
  } catch (ex) {
    console.error("Verwijderen mislukt:", ex);
    alert("Verwijderen mislukt. Controleer je verbinding.");
  }
}

// --- Event handlers -------------------------------------------------------

$("#openChordsBtn").addEventListener("click", () => navigate({ view: "chords" }, openChords));

$("#chordSearch").addEventListener("input", (e) => loadChordsList(e.target.value));

// Live preview bij wijzigen van elk formulierveld
$("#chordForm").addEventListener("input", updateChordPreview);

$("#chordForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = readChordForm();
  if (!data.chordName) return;

  const docId = data.chordName; // document-id = akkoordnaam
  try {
    await setChord(docId, {
      chordName: data.chordName,
      baseFret: data.baseFret,
      frets: data.frets,
      fingers: data.fingers,
    });
    state.chordCache[docId] = {
      id: docId,
      chordName: data.chordName,
      baseFret: data.baseFret,
      frets: data.frets,
      fingers: data.fingers,
    };
    const term = $("#chordSearch").value;
    resetChordForm();
    loadChordsList(term);
  } catch (ex) {
    console.error("Opslaan mislukt:", ex);
    alert("Opslaan mislukt. Controleer je verbinding.");
  }
});

$("#chordCancelBtn").addEventListener("click", resetChordForm);

// Seed-knop op de beheerpagina
$("#seedChordsFromUi").addEventListener("click", async () => {
  const btn = $("#seedChordsFromUi");
  btn.disabled = true;
  btn.textContent = "⏳ Bezig...";
  try {
    for (const ch of EXAMPLE_CHORDS) {
      await setChord(ch.id, {
        chordName: ch.chordName,
        baseFret: ch.baseFret,
        frets: ch.frets,
        fingers: ch.fingers,
      });
      state.chordCache[ch.id] = ch;
    }
    const term = $("#chordSearch").value;
    loadChordsList(term);
  } catch (ex) {
    console.error("Seed mislukt:", ex);
    alert("Seed mislukt. Controleer je verbinding.");
  } finally {
    btn.disabled = false;
    btn.textContent = "🌱 Seed voorbeelden";
  }
});

// ===========================================================================
//  PIANO-AKKOORDENBEHEER (CRUD voor de 'pianoChords' collectie)
// ===========================================================================

const PIANO_NOTE_OPTIONS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Open de piano-akkoordenbeheerpagina. */
function openPianoChords() {
  showView("piano-chords");
  resetPianoChordForm();
  loadPianoChordsList();
}

/** HTML voor één noten/vinger-rij (maximaal 4 rijen in het formulier). */
function pianoNoteRowHtml(note = "", finger = 1) {
  const opts = ['<option value="">—</option>']
    .concat(PIANO_NOTE_OPTIONS.map((n) => `<option ${n === note ? "selected" : ""}>${n}</option>`))
    .join("");
  return `<div class="piano-note-row flex items-center gap-2">
    <select class="piano-note-select w-24 border border-gray-300 rounded-lg px-2 py-2 text-sm focus:ring-2 focus:ring-blue-500 focus:outline-none">${opts}</select>
    <span class="text-xs text-gray-400">vinger</span>
    <input type="number" min="1" max="4" value="${finger}" class="piano-finger-input w-16 border border-gray-300 rounded-lg px-2 py-2 text-sm text-center focus:ring-2 focus:ring-blue-500 focus:outline-none">
  </div>`;
}

/** Render de 4 noten-rijen in het formulier. */
function renderPianoNoteRows(notes = [], fingers = []) {
  const wrap = $("#pianoNoteRows");
  if (!wrap) return;
  wrap.innerHTML = "";
  for (let i = 0; i < 4; i++) {
    wrap.insertAdjacentHTML("beforeend", pianoNoteRowHtml(notes[i] || "", fingers[i] || i + 1));
  }
}

/** Reset het piano-akkoordformulier naar 'nieuw'-modus. */
function resetPianoChordForm() {
  $("#pianoChordEditId").value = "";
  $("#pianoChordFormTitle").textContent = "Nieuw piano-akkoord toevoegen";
  $("#fPianoChordName").value = "";
  renderPianoNoteRows();
  $("#pianoChordCancelBtn").classList.add("hidden");
  $("#pianoChordPreview").classList.add("hidden");
}

/** Lees het piano-akkoordformulier uit. */
function readPianoChordForm() {
  const notes = [];
  const fingers = [];
  document.querySelectorAll("#pianoNoteRows .piano-note-row").forEach((row) => {
    const note = row.querySelector(".piano-note-select").value;
    if (!note) return;
    const fingerVal = parseInt(row.querySelector(".piano-finger-input").value);
    notes.push(note);
    fingers.push(Number.isNaN(fingerVal) ? notes.length : Math.min(4, Math.max(1, fingerVal)));
  });
  return {
    chordName: $("#fPianoChordName").value.trim(),
    notes,
    fingers,
  };
}

/** Vul het formulier met bestaande data (bewerk-modus). */
function fillPianoChordForm(chordData) {
  $("#pianoChordEditId").value = chordData.id || chordData.chordName;
  $("#pianoChordFormTitle").textContent = `Piano-akkoord bewerken: ${chordData.chordName}`;
  $("#fPianoChordName").value = chordData.chordName || "";
  renderPianoNoteRows(chordData.notes || [], chordData.fingers || []);
  $("#pianoChordCancelBtn").classList.remove("hidden");
  updatePianoChordPreview();
}

/** Live preview van het piano-akkoord in het formulier. */
function updatePianoChordPreview() {
  const data = readPianoChordForm();
  const preview = $("#pianoChordPreview");
  if (!preview) return;
  if (!data.notes.length) {
    preview.classList.add("hidden");
    return;
  }
  try {
    const svg = renderPianoChordSVG(data.chordName || "?", data.notes.length ? data : null);
    preview.innerHTML = svg;
    preview.classList.remove("hidden");
  } catch (ex) {
    // negeer renderfouten tijdens typen
  }
}

/** Laad en render de piano-akkoordenlijst. */
async function loadPianoChordsList(filter = "") {
  const list = $("#pianoChordsList");
  list.innerHTML = '<p class="text-gray-400 text-sm italic">Laden…</p>';

  let chords = [];
  try {
    chords = await getAllPianoChords();
    for (const ch of chords) {
      state.pianoChordCache[ch.id] = ch;
    }
  } catch (ex) {
    console.error("Piano-akkoorden laden mislukt:", ex);
    chords = Object.values(state.pianoChordCache);
  }

  const term = filter.toLowerCase().trim();
  if (term) {
    chords = chords.filter((c) => (c.id || "").toLowerCase().includes(term));
  }
  chords.sort((a, b) => (a.id || "").localeCompare(b.id || ""));

  list.innerHTML = "";
  $("#pianoChordsEmpty").classList.toggle("hidden", chords.length > 0);

  for (const ch of chords) {
    const card = document.createElement("div");
    card.className = "bg-white rounded-xl shadow-sm hover:shadow-md transition flex items-center";

    const preview = document.createElement("div");
    preview.className = "shrink-0 p-2";
    try {
      const miniSvg = renderPianoChordSVG(ch.id, ch.notes?.length ? ch : null);
      preview.innerHTML = miniSvg.replace(
        /style="[^"]*"/,
        'style="width:120px;height:auto;display:block"'
      );
    } catch (_) {
      preview.innerHTML = `<div class="w-[120px] h-[60px] bg-gray-100 rounded flex items-center justify-center text-gray-400 text-xs">?</div>`;
    }

    const info = document.createElement("button");
    info.className = "flex-1 text-left p-3 min-w-0";
    info.innerHTML = `<div class="font-semibold">${escapeHtml(ch.id || "?")}</div>
      <div class="text-xs text-gray-500">${escapeHtml((ch.notes || []).join(" ")) || "geen noten"}</div>`;
    info.addEventListener("click", () => {
      fillPianoChordForm(ch);
      window.scrollTo({ top: 0, behavior: "smooth" });
    });

    const del = document.createElement("button");
    del.className = "shrink-0 px-4 py-4 text-gray-300 hover:text-red-600";
    del.textContent = "🗑";
    del.title = "Piano-akkoord verwijderen";
    del.addEventListener("click", () => onDeletePianoChord(ch));

    card.appendChild(preview);
    card.appendChild(info);
    card.appendChild(del);
    list.appendChild(card);
  }
}

/** Verwijder een piano-akkoord. */
async function onDeletePianoChord(chord) {
  if (!confirm(`Piano-akkoord "${chord.id}" verwijderen?`)) return;
  try {
    await deletePianoChord(chord.id);
    delete state.pianoChordCache[chord.id];
    loadPianoChordsList($("#pianoChordSearch").value);
  } catch (ex) {
    console.error("Verwijderen mislukt:", ex);
    alert("Verwijderen mislukt. Controleer je verbinding.");
  }
}

// --- Event handlers ---------------------------------------------------------

$("#openPianoChordsBtn").addEventListener("click", () => navigate({ view: "piano-chords" }, openPianoChords));

$("#pianoChordSearch").addEventListener("input", (e) => loadPianoChordsList(e.target.value));

$("#pianoChordForm").addEventListener("input", updatePianoChordPreview);

// Vul de noten automatisch in op basis van de akkoordnaam.
$("#pianoAutoFillBtn").addEventListener("click", () => {
  const name = $("#fPianoChordName").value.trim();
  if (!name) {
    alert("Vul eerst een akkoordnaam in (bijv. C7).");
    return;
  }
  const parsed = chordToNotes(name);
  if (!parsed) {
    alert("Kon deze akkoordnaam niet herkennen. Je kunt de noten ook handmatig kiezen.");
    return;
  }
  const voicing = chordVoicing(parsed);
  const notes = voicing.map((v) => pitchClassName(v.midi % 12));
  const fingers = voicing.map((v) => v.finger);
  renderPianoNoteRows(notes, fingers);
  updatePianoChordPreview();
});

$("#pianoChordForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const data = readPianoChordForm();
  if (!data.chordName) return;
  if (!data.notes.length) {
    alert("Voeg minstens één noot toe.");
    return;
  }

  const docId = data.chordName; // document-id = akkoordnaam
  try {
    await setPianoChord(docId, {
      chordName: data.chordName,
      notes: data.notes,
      fingers: data.fingers,
    });
    state.pianoChordCache[docId] = {
      id: docId,
      chordName: data.chordName,
      notes: data.notes,
      fingers: data.fingers,
    };
    const term = $("#pianoChordSearch").value;
    resetPianoChordForm();
    loadPianoChordsList(term);
  } catch (ex) {
    console.error("Opslaan mislukt:", ex);
    alert("Opslaan mislukt. Controleer je verbinding.");
  }
});

$("#pianoChordCancelBtn").addEventListener("click", resetPianoChordForm);

// Seed-knop: genereer piano-akkoorden uit de voorbeeld-akkoordnamen.
$("#pianoSeedBtn").addEventListener("click", async () => {
  const btn = $("#pianoSeedBtn");
  btn.disabled = true;
  btn.textContent = "⏳ Bezig...";
  try {
    const names = [...new Set(EXAMPLE_CHORDS.map((c) => c.id))];
    for (const name of names) {
      const parsed = chordToNotes(name);
      if (!parsed) continue;
      const voicing = chordVoicing(parsed);
      const notes = voicing.map((v) => pitchClassName(v.midi % 12));
      const fingers = voicing.map((v) => v.finger);
      await setPianoChord(name, { chordName: name, notes, fingers });
      state.pianoChordCache[name] = { id: name, chordName: name, notes, fingers };
    }
    loadPianoChordsList($("#pianoChordSearch").value);
  } catch (ex) {
    console.error("Seed mislukt:", ex);
    alert("Seed mislukt. Controleer je verbinding.");
  } finally {
    btn.disabled = false;
    btn.textContent = "🌱 Seed voorbeelden";
  }
});

// ===========================================================================
//  HULPFUNCTIES
// ===========================================================================
function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** Firestore Timestamp of iets datumachtigs -> milliseconden. */
function toMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === "function") return ts.toMillis();
  if (typeof ts.seconds === "number") return ts.seconds * 1000;
  const d = new Date(ts);
  return isNaN(d) ? 0 : d.getTime();
}

function formatDate(ts) {
  const ms = toMillis(ts);
  if (!ms) return "";
  return new Date(ms).toLocaleString("nl-NL", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ===========================================================================
//  AANWEZIGHEID (presence) + OEFENKEUZE (rehearsal picker)
// ===========================================================================

const PRESENCE_HEARTBEAT_MS = 15000; // hoe vaak we "ik ben online" melden
const PRESENCE_ONLINE_MS = 45000;    // hoe lang een heartbeat geldig blijft

let currentPractice = null; // laatst ontvangen oefenkeuze (voor de "Bekijk liedje"-knop)
let pickedSongId = null;    // laatst gekozen liedje op de kies-pagina (voor de "Bekijk liedje"-knop)
let toastTimer = null;      // timer voor automatisch sluiten + openen van het liedje
const TOAST_AUTO_OPEN_MS = 3000; // hoe lang de popup blijft staan voordat hij opent

/** Schrijf het eigen presence-document (uid, naam, rehearsing-vlag, tijd). */
function writePresence() {
  if (!state.user) return;
  setPresence(state.user.uid, {
    name: state.user.email || "",
    rehearsing: !!state.settings.rehearsing,
  }).catch((e) => console.error("Presence schrijven mislukt:", e));
}

/** Direct het rehearsing-vlagje bijwerken (na het toggelen in instellingen). */
function refreshPresence() {
  writePresence();
}

/** Start de heartbeat én de listeners (presence + oefenkeuze). */
function startRealtime() {
  if (!state.user) return;

  // Presence: schrijf meteen en daarna met een vaste interval.
  writePresence();
  stopPresenceLoop();
  state.presenceTimer = setInterval(writePresence, PRESENCE_HEARTBEAT_MS);

  // Presence-listener voor de ledenlijst op de kies-pagina.
  if (state.presenceUnsub) state.presenceUnsub();
  state.presenceUnsub = watchPresence((list) => {
    state.presenceList = list;
    renderPracticeMembers();
  });

  // Luisteren naar oefenkeuzes van andere bandleden.
  if (state.practiceUnsub) state.practiceUnsub();
  state.practiceUnsub = watchPractice((practice) => {
    if (!practice) { state.lastPracticeNonce = null; return; }
    if (state.lastPracticeNonce === practice.nonce) return; // al gezien/verzonden
    const isFirst = state.lastPracticeNonce === null;
    state.lastPracticeNonce = practice.nonce;
    if (isFirst) return; // bestaande keuze bij het laden niet opnieuw tonen
    // Tonen wanneer dit bandlid "aan het repeteren" is, óf "verplicht" is
    // gemarkeerd (verplicht overschrijft de eigen repeteer-status).
    const amIRequired = (state.requiredMembers || []).some((m) => m.uid === state.user?.uid);
    if (!state.settings.rehearsing && !amIRequired) return;
    showPracticeToast(practice);
  });

  // Verplichte bandleden bij de liedjeskiezer (shared).
  if (state.requiredUnsub) state.requiredUnsub();
  state.requiredUnsub = watchRequiredMembers((members) => {
    state.requiredMembers = members || [];
    renderPracticeMembers();
  });

  // Actieve setlist-sessie: deelnemers volgen elkaars sessie-acties realtime.
  if (state.sessionUnsub) state.sessionUnsub();
  state.sessionUnsub = watchSession((session) => {
    handleSessionUpdate(session);
  });

  // Takenlijst: live meeluisteren (gedeeld met de hele band).
  if (state.todosUnsub) state.todosUnsub();
  state.todosUnsub = watchTodos((todos) => {
    todoState.items = todos;
    renderTodo();
  });

  // Eenmalig: oude localStorage-taken overzetten naar de gedeelde takenlijst.
  migrateLocalTodos();
}

function stopPresenceLoop() {
  if (state.presenceTimer) {
    clearInterval(state.presenceTimer);
    state.presenceTimer = null;
  }
}

/** Stop alle realtime zaken en ruim het presence-document op (bij uitloggen). */
function teardownRealtime(prevUid) {
  stopPresenceLoop();
  if (state.presenceUnsub) { state.presenceUnsub(); state.presenceUnsub = null; }
  if (state.practiceUnsub) { state.practiceUnsub(); state.practiceUnsub = null; }
  if (state.requiredUnsub) { state.requiredUnsub(); state.requiredUnsub = null; }
  if (state.sessionUnsub) { state.sessionUnsub(); state.sessionUnsub = null; }
  if (state.todosUnsub) { state.todosUnsub(); state.todosUnsub = null; }
  state.presenceList = [];
  state.lastPracticeNonce = null;
  state.requiredMembers = [];
  state.session = null;
  renderSessionBar();
  currentPractice = null;
  todoState.items = [];
  hidePracticeToast();
  if (prevUid) clearPresence(prevUid);
}

// ---------------------------------------------------------------------------
//  KIES-PAGINA (roulette)
// ---------------------------------------------------------------------------

/** Open de 'liedje kiezen'-pagina. */
async function openPractice() {
  showView("practice");
  if (!state.user) return;

  // Zorg dat de liedjescache gevuld is.
  if (!state.songs.length) {
    try { state.songs = await getAllSongs(); } catch (e) { console.error(e); }
  }
  // Alleen liedjes die voor de liedjeskiezer zijn aangezet doen mee.
  state.practiceSongs = state.songs.filter((s) => s.inPicker !== false);
  resetPracticeReel();
  renderPracticeMembers();
}

/** Zet de roulette terug naar de beginstand. */
function resetPracticeReel() {
  const reel = $("#practiceReelInner");
  reel.style.transition = "none";
  reel.style.transform = "translateY(0)";
  reel.innerHTML = '<div class="practice-tile practice-tile-idle">🎲 Druk op de knop</div>';
  $("#practiceResult").classList.add("hidden");
  $("#practiceResultNote").textContent = "";
  updatePracticePickGate();
}

/**
 * Bouw een lijst met willekeurige titels, met als laatste de winnaar.
 * `pool` is een array van titel-strings; bij een lege pool vallen we terug op
 * een paar muziek-emoji's zodat de reel nooit leeg is.
 */
function buildSpinTitles(pool, winnerTitle) {
  const fallback = ["🎵", "🎶", "🎼"];
  const source = pool && pool.length ? pool : fallback;
  const count = 24 + Math.floor(Math.random() * 6); // 24..29 titels
  const titles = [];
  for (let i = 0; i < count; i++) {
    titles.push(source[Math.floor(Math.random() * source.length)]);
  }
  titles.push(winnerTitle);
  return titles;
}

/**
 * Laat een reel (de verticale rij titels) draaien en landen op de laatste tile.
 * `onDone` wordt één keer aangeroepen zodra de animatie is afgelopen.
 */
function animateReel(innerEl, titles, spinMs, onDone) {
  innerEl.innerHTML = titles
    .map((t) => `<div class="practice-tile">${escapeHtml(t)}</div>`)
    .join("");
  innerEl.style.transition = "none";
  innerEl.style.transform = "translateY(0)";
  void innerEl.offsetHeight; // forceer reflow zodat de overgang opnieuw start

  const tileHeight = innerEl.querySelector(".practice-tile").offsetHeight;
  const target = -((titles.length - 1) * tileHeight); // de winnaar is de laatste tile
  innerEl.style.transition = `transform ${spinMs}ms cubic-bezier(0.12, 0.8, 0.2, 1)`;
  innerEl.style.transform = `translateY(${target}px)`;

  let finished = false;
  const done = () => {
    if (finished) return;
    finished = true;
    onDone();
  };
  innerEl.addEventListener("transitionend", done, { once: true });
  setTimeout(done, spinMs + 400); // fallback als transitionend niet afgaat
}

/** Start de roulette en kiest uiteindelijk een willekeurig liedje. */
function pickPracticeSong() {
  const songs = state.practiceSongs;
  if (!songs.length) {
    alert("Geen liedjes om uit te kiezen. Voeg eerst liedjes toe.");
    return;
  }
  const btn = $("#practicePickBtn");
  if (btn.disabled) return;
  btn.disabled = true;
  $("#practiceResult").classList.add("hidden");
  $("#practiceResultNote").textContent = "";

  const winner = songs[Math.floor(Math.random() * songs.length)];
  const pool = songs.map((s) => s.title || "(zonder titel)");
  const titles = buildSpinTitles(pool, winner.title || "(zonder titel)");
  const spinMs = 3200 + Math.floor(Math.random() * 600);

  animateReel($("#practiceReelInner"), titles, spinMs, () => finishPracticePick(winner));
}

/** Toon het resultaat en stuur de keuze naar de band. */
function finishPracticePick(winner) {
  $("#practiceResult").classList.remove("hidden");
  $("#practiceResultTitle").textContent = winner.title || "(zonder titel)";
  $("#practiceResultArtist").textContent = winner.artist || "";
  pickedSongId = winner.id; // onthoud het gekozen liedje voor de "Bekijk liedje"-knop
  updatePracticePickGate();

  const nonce = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  state.lastPracticeNonce = nonce; // eigen keuze niet als melding tonen
  setCurrentPractice({
    songId: winner.id,
    title: winner.title || "",
    artist: winner.artist || "",
    chosenBy: state.user?.email || "",
    nonce,
  })
    .then(() => {
      $("#practiceResultNote").textContent =
        "✓ De keuze is naar de online, repeterende bandleden gestuurd.";
    })
    .catch((e) => {
      console.error("Keuze verzenden mislukt:", e);
      $("#practiceResultNote").textContent =
        "Keuze gemaakt, maar verzenden naar de band is mislukt.";
    });
}

/** Online bandleden (recente heartbeat). */
function onlineMembers() {
  const now = Date.now();
  return (state.presenceList || []).filter((p) => now - toMillis(p.lastSeen) < PRESENCE_ONLINE_MS);
}

/** Leesbare naam van een lid, zonder e-maildomein. */
function memberDisplayName(name) {
  return (name || "").split("@")[0] || "Bandlid";
}

/** Update de "Kies een liedje"-knop en de wacht-hint op basis van verplichte leden. */
function updatePracticePickGate() {
  const btn = $("#practicePickBtn");
  const hint = $("#practiceRequiredHint");
  if (!btn) return;

  const onlineIds = new Set(onlineMembers().map((p) => p.id));
  const required = state.requiredMembers || [];
  const missing = required.filter((m) => !onlineIds.has(m.uid));

  // Knop is uit als er geen liedjes zijn, of als er verplichte leden offline zijn.
  btn.disabled = !state.practiceSongs.length || missing.length > 0;

  if (hint) {
    if (missing.length) {
      hint.classList.remove("hidden");
      hint.textContent =
        "⏳ Wacht op verplichte leden: " +
        missing.map((m) => memberDisplayName(m.name)).join(", ");
    } else {
      hint.classList.add("hidden");
    }
  }
}

/** Vink een bandlid aan/af als verplicht deelnemer aan de liedjeskiezer. */
function toggleRequiredMember(member, required) {
  const members = (state.requiredMembers || []).filter((m) => m.uid !== member.id);
  if (required) members.push({ uid: member.id, name: member.name || "" });
  state.requiredMembers = members;
  renderPracticeMembers();
  setRequiredMembers(members).catch((e) =>
    console.error("Verplichte leden opslaan mislukt:", e)
  );
}

/** Bouw één leden-rij met een 'verplicht'-vinkje. */
function memberRow(member, isRequired, isOffline = false) {
  const isSelf = member.id === state.user?.uid;
  const name = memberDisplayName(member.name);
  // "Verplicht" overschrijft de eigen "repeterend"-status: zo'n lid telt mee.
  const rehearsing = member.rehearsing || (isRequired && !isOffline);
  const row = document.createElement("div");
  row.className = "flex items-center justify-between gap-2 text-sm py-0.5";

  const left = document.createElement("div");
  left.className = "flex items-center gap-2 min-w-0";
  const dot = rehearsing ? "bg-green-500" : "bg-gray-300";
  const nameClass = rehearsing ? "font-medium text-gray-800" : "text-gray-500";
  left.innerHTML =
    `<span class="w-2 h-2 rounded-full shrink-0 ${dot}"></span>` +
    `<span class="${nameClass} truncate">${escapeHtml(name)}</span>` +
    (isSelf ? '<span class="text-xs text-gray-400">(jij)</span>' : "") +
    (rehearsing ? '<span class="text-xs text-green-600">🎯 repeterend</span>' : "") +
    (isOffline ? '<span class="text-xs text-amber-600">offline</span>' : "");
  row.appendChild(left);

  const label = document.createElement("label");
  label.className = "flex items-center gap-1 shrink-0 cursor-pointer select-none";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = isRequired;
  cb.className = "accent-blue-600";
  cb.addEventListener("change", () => toggleRequiredMember(member, cb.checked));
  const span = document.createElement("span");
  span.className = "text-xs text-gray-500";
  span.textContent = "verplicht";
  label.appendChild(cb);
  label.appendChild(span);
  row.appendChild(label);

  return row;
}

/** Toon welke bandleden online zijn en wie verplicht meedoet aan de kiezer. */
function renderPracticeMembers() {
  const listEl = $("#practiceMembersList");
  if (!listEl) return;

  const online = onlineMembers();
  const required = state.requiredMembers || [];
  const requiredUids = new Set(required.map((m) => m.uid));

  listEl.innerHTML = "";

  if (!online.length && !required.length) {
    listEl.innerHTML = '<p class="text-sm text-gray-400">Niemand online.</p>';
    updatePracticePickGate();
    return;
  }

  // Online leden.
  for (const p of online) {
    listEl.appendChild(memberRow(p, requiredUids.has(p.id)));
  }

  // Verplichte leden die nu offline zijn, zodat je ze alsnog kunt uitzetten.
  const offlineRequired = required.filter((m) => !online.some((p) => p.id === m.uid));
  for (const m of offlineRequired) {
    listEl.appendChild(memberRow({ id: m.uid, name: m.name, rehearsing: false, lastSeen: 0 }, true, true));
  }

  updatePracticePickGate();
}

// ---------------------------------------------------------------------------
//  GLOBALE MELDING: de keuze verschijnt overal in de app
// ---------------------------------------------------------------------------

function showPracticeToast(practice) {
  currentPractice = practice;
  clearTimeout(toastTimer); // annuleer een eventuele eerdere auto-open
  toastTimer = null;

  // Vul de tekst alvast in (wordt pas getoond nadat de spin is afgelopen).
  $("#practiceToastTitle").textContent = practice.title || "(zonder titel)";
  $("#practiceToastArtist").textContent = practice.artist || "";
  const by = practice.chosenBy ? (practice.chosenBy.split("@")[0] || practice.chosenBy) : "";
  $("#practiceToastBy").textContent = by ? `Gekozen door ${by}` : "";

  // Verberg resultaat + knoppen tot de spin klaar is.
  $("#practiceToastInfo").classList.add("hidden");
  $("#practiceToastActions").classList.add("hidden");
  $("#practiceToast").classList.remove("hidden");

  // Draai het rad en toon daarna het resultaat.
  const pool = state.songs.map((s) => s.title || "(zonder titel)");
  const titles = buildSpinTitles(pool, practice.title || "(zonder titel)");
  const spinMs = 2400 + Math.floor(Math.random() * 500);
  animateReel($("#practiceToastReelInner"), titles, spinMs, () => revealToastInfo(practice));
}

function revealToastInfo(practice) {
  if (currentPractice !== practice) return; // verouderde spin negeren
  $("#practiceToastInfo").classList.remove("hidden");
  $("#practiceToastActions").classList.remove("hidden");

  // Na een paar seconden automatisch sluiten en het gekozen liedje openen.
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    const id = currentPractice?.songId;
    hidePracticeToast();
    if (id) navigate({ view: "song", id }, () => openSong(id));
  }, TOAST_AUTO_OPEN_MS);
}

function hidePracticeToast() {
  clearTimeout(toastTimer);
  toastTimer = null;
  $("#practiceToast").classList.add("hidden");
}

// --- Event handlers ---------------------------------------------------------

$("#openPracticeBtn").addEventListener("click", () => navigate({ view: "practice" }, openPractice));
$("#practicePickBtn").addEventListener("click", pickPracticeSong);
$("#practiceResultOpenBtn").addEventListener("click", () => {
  if (pickedSongId) navigate({ view: "song", id: pickedSongId }, () => openSong(pickedSongId));
});
$("#practiceToastCloseBtn").addEventListener("click", hidePracticeToast);
$("#practiceToastOverlay").addEventListener("click", hidePracticeToast);
$("#practiceToastOpenBtn").addEventListener("click", () => {
  const id = currentPractice?.songId;
  hidePracticeToast();
  if (id) navigate({ view: "song", id }, () => openSong(id));
});

