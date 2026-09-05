// ============================================================================
//  Firestore data-laag (CRUD voor 'songs')
// ----------------------------------------------------------------------------
//  Datamodel van een song-document:
//  {
//    title:  string,
//    artist: string,
//    capo:   number,
//    content: [                        // secties in volgorde
//      { type: "verse"|"chorus"|"solo"|"bridge",
//        lines: [
//          { chords: [{ chord: "Em", position: 0 }], text: "..." }
//        ]
//      }
//    ],
//    notes: [                          // aantekeningen van bandleden
//      { id, userId, instrument, text, createdAt }
//    ]
//  }
// ============================================================================

import { db } from "./firebase-config.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  addDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  arrayUnion,
  arrayRemove,
  query,
  orderBy,
  where,
  onSnapshot,
  serverTimestamp,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const SONGS = "songs";
const USERS = "users";
const DRAWINGS = "drawings";
const SETLISTS = "setlists";
const CHORDS = "chords";
const PIANO_CHORDS = "pianoChords";
const PRESENCE = "presence";
const PRACTICE = "practice";
const TODOS = "todos";
const SESSIONS = "sessions";

// --- Handgeschreven tekenlaag (per liedje + gebruiker + instrument) ----------

/** Documentsleutel voor een tekenlaag. */
function drawingId(songId, userId, instrument) {
  return `${songId}__${userId}__${instrument}`;
}

/** Haal de opgeslagen tekening (data-URL string) op, of null. */
export async function getDrawing(songId, userId, instrument) {
  const snap = await getDoc(doc(db, DRAWINGS, drawingId(songId, userId, instrument)));
  return snap.exists() ? snap.data().drawingData || null : null;
}

/**
 * Sla de tekenlaag op (fire-and-forget, net als notities: werkt ook offline en
 * synchroniseert vanzelf). drawingData is een data-URL, of "" als er niets is.
 */
export function saveDrawing(songId, userId, instrument, drawingData) {
  setDoc(
    doc(db, DRAWINGS, drawingId(songId, userId, instrument)),
    { songId, userId, instrument, drawingData, updatedAt: Timestamp.now() },
    { merge: true }
  ).catch((e) => console.error("Tekening synchroniseren mislukt:", e));
}

/** Haal alle liedjes op, gesorteerd op titel. */
export async function getAllSongs() {
  const q = query(collection(db, SONGS), orderBy("title"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Haal één liedje op basis van id. */
export async function getSong(id) {
  const snap = await getDoc(doc(db, SONGS, id));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

/** Maak een nieuw liedje aan. Geeft de nieuwe document-id terug. */
export async function createSong(data) {
  const payload = {
    title: data.title || "",
    artist: data.artist || "",
    capo: Number(data.capo) || 0,
    bpm: Number(data.bpm) || 0,
    scrollSpeedFactor: Math.max(0.1, Number(data.scrollSpeedFactor) || 1.0),
    spotifyUrl: data.spotifyUrl || "",
    content: data.content || [],
    notes: data.notes || [],
  };
  const ref = await addDoc(collection(db, SONGS), payload);
  return ref.id;
}

/** Werk een bestaand liedje bij (titel, artiest, capo, bpm, scrollSpeedFactor, spotifyUrl, content). */
export async function updateSong(id, data) {
  const payload = {
    title: data.title || "",
    artist: data.artist || "",
    capo: Number(data.capo) || 0,
    bpm: Number(data.bpm) || 0,
    scrollSpeedFactor: Math.max(0.1, Number(data.scrollSpeedFactor) || 1.0),
    spotifyUrl: data.spotifyUrl || "",
    // Ruim het oude veld op: de app leest dat nog als fallback, dus laten staan
    // zou een gewiste of gewijzigde link weer terug laten komen.
    youtubeUrl: "",
    content: data.content || [],
  };
  await updateDoc(doc(db, SONGS, id), payload);
}

/** Verwijder een liedje. */
export async function deleteSong(id) {
  await deleteDoc(doc(db, SONGS, id));
}

/**
 * Zet aan/uit of een liedje meedoet in de liedjeskiezer (roulette).
 * `inPicker` is boolean; afwezig betekent standaard "aan".
 */
export async function setSongInPicker(id, inPicker) {
  await updateDoc(doc(db, SONGS, id), { inPicker: !!inPicker });
}

/**
 * Voeg een aantekening toe aan een liedje.
 * Let op: Firestore ondersteunt geen serverTimestamp() binnen array-elementen,
 * daarom gebruiken we hier een client-side Timestamp.
 */
export function addNote(songId, { userId, instrument, text, sectionId = null, lineIndex = null }) {
  const note = {
    id: cryptoRandomId(),
    userId,
    instrument,
    text,
    sectionId,             // null = algemeen; anders gekoppeld aan een sectie
    lineIndex,             // null = sectie-breed; anders een specifieke regel
    createdAt: Timestamp.now(),
  };
  // Fire-and-forget: offline wordt de schrijfactie in de wachtrij gezet en
  // gesynchroniseerd zodra er weer verbinding is. De UI werkt direct bij.
  updateDoc(doc(db, SONGS, songId), { notes: arrayUnion(note) }).catch((e) =>
    console.error("Notitie synchroniseren mislukt:", e)
  );
  return note;
}

/** Sla alleen de content opnieuw op (bijv. na het toekennen van section-ids). */
export async function saveContent(songId, content) {
  await updateDoc(doc(db, SONGS, songId), { content: content || [] });
}

/** Genereer een korte, unieke id (voor secties). */
export function newId() {
  return cryptoRandomId();
}

// --- Gebruikersprofiel (welk instrument speelt dit bandlid) ----------------

/** Haal het profiel van een gebruiker op (of null). */
export async function getUserProfile(uid) {
  const snap = await getDoc(doc(db, USERS, uid));
  return snap.exists() ? snap.data() : null;
}

/** Sla (deels) het gebruikersprofiel op, bijv. { instrument: "guitar" }. */
export async function setUserProfile(uid, data) {
  await setDoc(doc(db, USERS, uid), data, { merge: true });
}

/** Verwijder een specifieke aantekening (het volledige note-object is nodig). */
export async function removeNote(songId, note) {
  await updateDoc(doc(db, SONGS, songId), { notes: arrayRemove(note) });
}

/** Werk een bestaande aantekening bij (vervang het oude object door het nieuwe). */
export async function updateNote(songId, oldNote, newNote) {
  await updateDoc(doc(db, SONGS, songId), { notes: arrayRemove(oldNote) });
  await updateDoc(doc(db, SONGS, songId), { notes: arrayUnion(newNote) });
}

/** Genereer een korte, unieke id voor aantekeningen. */
function cryptoRandomId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return "n_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// --- Setlist CRUD (voor live-optredens) ------------------------------------

/** Haal alle setlists op (gedeeld tussen alle bandleden), gesorteerd op datum (nieuwste eerst). */
export async function getAllSetlists() {
  const q = query(
    collection(db, SETLISTS),
    orderBy("date", "desc")
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Haal één setlist op basis van id. */
export async function getSetlist(id) {
  const snap = await getDoc(doc(db, SETLISTS, id));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

/**
 * Zet iets datumachtigs (JS Date, Firestore Timestamp, ISO-string of ms) om
 * naar een Date die Firestore accepteert. Retourneert null bij een ongeldige
 * waarde, zodat we nooit een "Invalid Date" naar Firestore schrijven.
 */
function toDateOrNull(value) {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value) ? null : value;
  // Firestore Timestamp heeft een toDate()-methode.
  if (typeof value.toDate === "function") return value.toDate();
  // Timestamp-achtig object met seconds.
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  const d = new Date(value);
  return isNaN(d) ? null : d;
}

/** Maak een nieuwe setlist aan (gedeeld tussen alle bandleden). */
export async function createSetlist({ name, date, songIds = [] }) {
  const payload = {
    name: name || "",
    date: toDateOrNull(date) || new Date(),
    songIds: songIds || [],
    createdAt: Timestamp.now(),
  };
  const ref = await addDoc(collection(db, SETLISTS), payload);
  return ref.id;
}

/** Update een bestaande setlist (naam, datum, volgorde). */
export async function updateSetlist(id, { name, date, songIds }) {
  const payload = {
    name: name || "",
    date: toDateOrNull(date) || new Date(),
    songIds: songIds || [],
  };
  await updateDoc(doc(db, SETLISTS, id), payload);
}

/** Verwijder een setlist. */
export async function deleteSetlist(id) {
  await deleteDoc(doc(db, SETLISTS, id));
}

// --- Akkoorden / Gitaargrepen (Chordify-stijl) --------------------------------

/** Haal één akkoord op uit de 'chords' collectie. */
export async function getChord(chordName) {
  const snap = await getDoc(doc(db, CHORDS, chordName));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

/** Haal alle akkoorden op (voor offline caching). */
export async function getAllChords() {
  const snap = await getDocs(collection(db, CHORDS));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Schrijf een akkoorddocument naar de 'chords' collectie. */
export async function setChord(chordName, data) {
  await setDoc(doc(db, CHORDS, chordName), data);
}

/** Verwijder een akkoord uit de 'chords' collectie. */
export async function deleteChord(chordName) {
  await deleteDoc(doc(db, CHORDS, chordName));
}

// --- Piano-akkoorden (aangepaste noten + vingerzetting) ----------------------

/** Haal één piano-akkoord op uit de 'pianoChords' collectie. */
export async function getPianoChord(chordName) {
  const snap = await getDoc(doc(db, PIANO_CHORDS, chordName));
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}

/** Haal alle piano-akkoorden op (voor offline caching). */
export async function getAllPianoChords() {
  const snap = await getDocs(collection(db, PIANO_CHORDS));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Schrijf een piano-akkoorddocument naar de 'pianoChords' collectie. */
export async function setPianoChord(chordName, data) {
  await setDoc(doc(db, PIANO_CHORDS, chordName), data);
}

/** Verwijder een piano-akkoord uit de 'pianoChords' collectie. */
export async function deletePianoChord(chordName) {
  await deleteDoc(doc(db, PIANO_CHORDS, chordName));
}

// --- Aanwezigheid (presence) -------------------------------------------------
// Elk online bandlid schrijft met een vaste interval een heartbeat-document.
// Een gebruiker geldt als "online" zolang zijn `lastSeen` recent is. Het
// `rehearsing`-vlagje geeft aan of hij/zij "aan het repeteren" is.

/** Schrijf (merge) het presence-document van deze gebruiker. */
export function setPresence(uid, { name, rehearsing }) {
  return setDoc(
    doc(db, PRESENCE, uid),
    { uid, name: name || "", rehearsing: !!rehearsing, lastSeen: Timestamp.now() },
    { merge: true }
  );
}

/** Verwijder het presence-document (bij uitloggen). */
export async function clearPresence(uid) {
  try {
    await deleteDoc(doc(db, PRESENCE, uid));
  } catch (e) {
    console.error("Presence opruimen mislukt:", e);
  }
}

/**
 * Luister naar alle presence-documenten. De callback krijgt een array met
 * { id (uid), name, rehearsing, lastSeen }. Geeft een unsubscribe-functie terug.
 */
export function watchPresence(callback, onError) {
  return onSnapshot(
    query(collection(db, PRESENCE)),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError || ((e) => console.error("Presence luisteren mislukt:", e))
  );
}

// --- Oefenkeuze (practice broadcast) -----------------------------------------
// Eén gedeeld document met de laatst gekozen oefenliedje. Alle online, repe-
// tende bandleden luisteren hiernaar en krijgen de keuze direct te zien.

/** Schrijf de gekozen oefenliedje (broadcast naar de band). */
export async function setCurrentPractice({ songId, title, artist, chosenBy, nonce }) {
  await setDoc(doc(db, PRACTICE, "current"), {
    songId,
    title: title || "",
    artist: artist || "",
    chosenBy: chosenBy || "",
    chosenAt: Timestamp.now(),
    nonce,
  });
}

/**
 * Luister naar de laatst gekozen oefenliedje. De callback krijgt het document
 * (of null als er nog geen keuze is). Geeft een unsubscribe-functie terug.
 */
export function watchPractice(callback, onError) {
  return onSnapshot(
    doc(db, PRACTICE, "current"),
    (snap) => callback(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    onError || ((e) => console.error("Practice luisteren mislukt:", e))
  );
}

// --- Verplichte bandleden bij de liedjeskiezer -------------------------------

/** Sla op welke bandleden verplicht meedoen aan de liedjeskiezer (shared). */
export async function setRequiredMembers(members) {
  await setDoc(doc(db, PRACTICE, "required"), { members: members || [] });
}

/** Luister naar de verplichte bandleden. Callback krijgt [{ uid, name }]. */
export function watchRequiredMembers(callback, onError) {
  return onSnapshot(
    doc(db, PRACTICE, "required"),
    (snap) => callback(snap.exists() ? snap.data().members || [] : []),
    onError || ((e) => console.error("Verplichte leden luisteren mislukt:", e))
  );
}

// --- Sessies (realtime setlist afspelen, beheerd door alle deelnemers) --------
// Eén gedeeld document `sessions/active` beschrijft de lopende sessie:
// {
//   setlistId, setlistName,
//   leaderUid, leaderName,        // aanmaker van de sessie (ter info)
//   members: [{ uid, name }],     // deelnemende bandleden (inclusief de aanmaker)
//   songIds: [...],               // setlist-volgorde
//   songIndex: number,            // huidig nummer
//   playing: boolean,             // iemand heeft het huidige nummer gestart
//   actorUid: string,             // wie de laatste sessie-actie deed
//   updatedAt: Timestamp
// }

/** Start een nieuwe sessie (overschrijft een eventuele bestaande actieve sessie). */
export async function startSession({
  setlistId,
  setlistName,
  leaderUid,
  leaderName,
  members = [],
  songIds = [],
  songIndex = 0,
  playing = false,
  actorUid = "",
}) {
  await setDoc(doc(db, SESSIONS, "active"), {
    setlistId: setlistId || "",
    setlistName: setlistName || "",
    leaderUid: leaderUid || "",
    leaderName: leaderName || "",
    members: members || [],
    songIds: songIds || [],
    songIndex: songIndex || 0,
    playing: !!playing,
    actorUid: actorUid || leaderUid || "",
    updatedAt: Timestamp.now(),
  });
}

/** Werk de actieve sessie bij (merge), bijv. { songIndex: 3 } of { playing: true }. */
export async function updateSession(data) {
  await updateDoc(doc(db, SESSIONS, "active"), { ...data, updatedAt: Timestamp.now() });
}

/** Beëindig de actieve sessie (iedereen stopt met volgen). */
export async function endSession() {
  await deleteDoc(doc(db, SESSIONS, "active"));
}

/**
 * Luister naar de actieve sessie. De callback krijgt het document
 * (of null als er geen sessie actief is). Geeft een unsubscribe-functie terug.
 */
export function watchSession(callback, onError) {
  return onSnapshot(
    doc(db, SESSIONS, "active"),
    (snap) => callback(snap.exists() ? { id: snap.id, ...snap.data() } : null),
    onError || ((e) => console.error("Sessie luisteren mislukt:", e))
  );
}

// --- Takenlijst (todos, gedeeld met de hele band) ----------------------------

/** Maak een nieuwe taak aan (gedeeld). Geeft de document-id terug. */
export async function createTodo(text, completed = false) {
  const ref = await addDoc(collection(db, TODOS), {
    text: text || "",
    completed: !!completed,
    createdAt: Timestamp.now(),
  });
  return ref.id;
}

/** Werk (delen van) een taak bij, bijv. { completed: true } of { text: "…" }. */
export async function updateTodoDoc(id, data) {
  await updateDoc(doc(db, TODOS, id), data);
}

/** Verwijder een taak. */
export async function deleteTodoDoc(id) {
  await deleteDoc(doc(db, TODOS, id));
}

/**
 * Luister naar alle taken (gesorteerd op aanmaakdatum). De callback krijgt een
 * array met { id, text, completed, createdAt }. Geeft een unsubscribe-functie terug.
 */
export function watchTodos(callback, onError) {
  return onSnapshot(
    query(collection(db, TODOS), orderBy("createdAt", "asc")),
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError || ((e) => console.error("Todos luisteren mislukt:", e))
  );
}

// serverTimestamp wordt bewust niet in arrays gebruikt, maar geëxporteerd
// voor eventueel toekomstig gebruik op documentniveau.
export { serverTimestamp };
