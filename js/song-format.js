// ============================================================================
//  Song-formaat: Smart Song Parser
//  Converteert rauwe geplakte tekst -> Firestore-structuur en terug, plus het
//  renderen van een regel met akkoorden exact boven de tekst.
//
//  Ondersteunde invoerformaten (worden automatisch herkend):
//    1. "Line-by-line": een akkoordenregel direct boven de tekstregel.
//         Em      A
//         Tien tegen een dat ik mijn mond houd
//       -> posities worden berekend uit het aantal spaties (kolomindex).
//
//    2. "Inline ChordPro": akkoorden tussen [haken] middenin de tekst.
//         [Em]Tien tegen een dat ik mijn [A]mond houd
//       -> ongevoelig voor ingeklapte spaties (aanrader bij kopiëren/plakken).
//
//  Secties markeer je met [Verse] / [Chorus] / [Solo] / [Bridge] enz.
// ============================================================================

const SECTION_TYPES = ["verse", "chorus", "solo", "bridge", "intro", "outro", "interlude", "pre-chorus"];

const SECTION_ALIASES = {
  verse: "verse", couplet: "verse", vers: "verse",
  chorus: "chorus", refrein: "chorus", ref: "chorus",
  solo: "solo",
  bridge: "bridge", brug: "bridge",
  intro: "intro",
  outro: "outro", end: "outro", einde: "outro",
  interlude: "interlude", tussenspel: "interlude",
  "pre-chorus": "pre-chorus", prechorus: "pre-chorus",
};

// Herkent of een los woord een akkoord is:
//   Em, A, C#m7, Gsus4, D/F#, Bb, Amaj7, Dadd9, Csus2, F#m7b5, Bdim, Aaug, G+, C13
const CHORD_TOKEN =
  /^[A-G](#|b)?(maj|min|m|dim|aug|sus|add|\+)?[0-9]*(b5|#5|b9|#9|#11|b13)?(sus|add)?[0-9]*(\/[A-G](#|b)?)?$/;

// Herhalingsmarkeringen op instrumentale regels: x4, 4x, (x2)
const REPEAT_TOKEN = /^\(?(x\d+|\d+x)\)?$/i;

// ---------------------------------------------------------------------------
//  Transponeren van akkoorden
// ---------------------------------------------------------------------------

const NOTE_VALUES = {
  C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5,
  "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11,
};
const SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

/** Transponeer één grondtoon (bijv. "C#", "Bb") met N halve tonen. */
function transposeNote(note, semitones) {
  const value = NOTE_VALUES[note];
  if (value == null) return note;
  const flat = note.includes("b");
  const next = ((value + semitones) % 12 + 12) % 12;
  return (flat ? FLAT_NAMES : SHARP_NAMES)[next];
}

/** Transponeer een volledige akkoordnaam zoals "F#m7", "Bb" of "D/F#". */
export function transposeChordName(chord, semitones) {
  if (!chord || !semitones) return chord;
  const [main, bass] = String(chord).split("/");
  const m = /^([A-G](?:#|b)?)/.exec(main);
  if (!m) return chord;
  const root = m[1];
  const rest = main.slice(root.length);
  const out = transposeNote(root, semitones) + rest;
  return bass ? out + "/" + transposeNote(bass, semitones) : out;
}

// ---------------------------------------------------------------------------
//  Detectie-helpers
// ---------------------------------------------------------------------------

/** Bepaal het sectie-type uit een header als "[Verse]"/"[Refrein]"/"[Tussenspel]". */
function parseSectionHeader(line) {
  const m = line.trim().match(/^\[([^\]]+)\]$/);
  if (!m) return null;
  const raw = m[1].trim();
  const key = raw.toLowerCase();
  if (SECTION_ALIASES[key]) return SECTION_ALIASES[key];
  if (SECTION_TYPES.includes(key)) return key;
  // Een losse [Em] op een regel is een akkoord (instrumentaal), geen sectie.
  if (CHORD_TOKEN.test(raw)) return null;
  return key; // onbekende maar geldige sectienaam -> gebruik letterlijk als label
}

/** Bevat de regel inline-akkoorden zoals [Em] middenin de tekst? */
function hasInlineChords(line) {
  const brackets = line.match(/\[[^\]]+\]/g);
  if (!brackets) return false;
  return brackets.some((b) => CHORD_TOKEN.test(b.slice(1, -1).trim()));
}

/** Is één los woord een geldig akkoord? */
export function isChord(token) {
  return CHORD_TOKEN.test(token);
}

/** Is de HELE regel een akkoordenregel? (alleen akkoorden + evt. herhaalmarkering) */
export function isChordLine(line) {
  const tokens = line.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return false;
  let hasChord = false;
  for (const t of tokens) {
    if (CHORD_TOKEN.test(t)) { hasChord = true; continue; }
    if (REPEAT_TOKEN.test(t)) continue;
    return false;
  }
  return hasChord;
}

// ---------------------------------------------------------------------------
//  Regel-parsers
// ---------------------------------------------------------------------------

/** Line-by-line: zet een akkoordenregel om naar [{ chord, position }] per kolom. */
function chordsFromLine(line) {
  const chords = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    chords.push({ chord: m[0], position: m.index });
  }
  return chords;
}

/** Inline ChordPro: haal [akkoorden] uit de tekst en bereken hun positie. */
function parseInlineLine(line) {
  const chords = [];
  let text = "";
  const re = /\[([^\]]+)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(line)) !== null) {
    text += line.slice(last, m.index);        // tekst vóór dit akkoord
    chords.push({ chord: m[1].trim(), position: text.length });
    last = m.index + m[0].length;
  }
  text += line.slice(last);                    // resterende tekst
  return { chords, text };
}

// ---------------------------------------------------------------------------
//  Hoofdparser: rauwe tekst -> content-structuur
// ---------------------------------------------------------------------------
export function parseSongText(raw) {
  const lines = (raw || "").replace(/\r\n/g, "\n").split("\n");
  const content = [];
  let current = null;

  const ensureSection = () => {
    if (!current) {
      current = { type: "verse", lines: [] };
      content.push(current);
    }
    return current;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // 1) Sectie-header?
    const sectionType = parseSectionHeader(line);
    if (sectionType) {
      current = { type: sectionType, lines: [] };
      content.push(current);
      continue;
    }

    // Lege regels alleen als scheiding; niet opslaan.
    if (line.trim() === "") continue;

    // 2) Inline ChordPro-regel?
    if (hasInlineChords(line)) {
      ensureSection().lines.push(parseInlineLine(line));
      continue;
    }

    // 3) Line-by-line: akkoordenregel?
    if (isChordLine(line)) {
      const chords = chordsFromLine(line);
      const next = lines[i + 1];
      const nextIsLyric =
        next !== undefined &&
        next.trim() !== "" &&
        !isChordLine(next) &&
        !parseSectionHeader(next) &&
        !hasInlineChords(next);
      if (nextIsLyric) {
        ensureSection().lines.push({ chords, text: next });
        i++; // koppel en consumeer de tekstregel
      } else {
        ensureSection().lines.push({ chords, text: "" }); // instrumentale regel
      }
    } else {
      // 4) Gewone tekstregel zonder akkoorden.
      ensureSection().lines.push({ chords: [], text: line });
    }
  }

  return content;
}

// ---------------------------------------------------------------------------
//  Serialisatie: content-structuur -> bewerkbare (line-by-line) tekst
// ---------------------------------------------------------------------------
export function serializeSong(content) {
  const out = [];
  for (const section of content || []) {
    out.push(`[${capitalize(section.type || "verse")}]`);
    out.push(serializeLines(section.lines || []));
    out.push(""); // lege regel tussen secties
  }
  return out.join("\n").trimEnd();
}

/** Serialiseer alleen de regels van één sectie (zonder [kop]) naar tekst. */
export function serializeLines(lines) {
  const out = [];
  for (const line of lines || []) {
    const chordLine = buildChordLine(line.chords || []);
    if (chordLine.trim() !== "") out.push(chordLine);
    out.push(line.text || "");
  }
  return out.join("\n");
}

/** Bouw een akkoordenregel-string uit [{chord, position}] met correcte spaties. */
export function buildChordLine(chords) {
  if (!chords || !chords.length) return "";
  const sorted = [...chords].sort((a, b) => a.position - b.position);
  let out = "";
  for (const c of sorted) {
    if (out.length < c.position) {
      out += " ".repeat(c.position - out.length);
    } else if (out.length > 0) {
      out += " "; // voorkom dat akkoorden aan elkaar plakken
    }
    out += c.chord;
  }
  return out;
}

/**
 * Bouw een akkoordenregel als HTML met klikbare <span>s rond elk akkoord.
 * De spaties blijven als gewone tekst behouden zodat de monospace-uitlijning
 * karakter-voor-karakter klopt.
 */
export function buildChordLineHTML(chords) {
  if (!chords || !chords.length) return "";
  const sorted = [...chords].sort((a, b) => a.position - b.position);
  let out = "";
  let visualPos = 0; // track zichtbare positie (exclusief HTML-tags)
  for (const c of sorted) {
    if (visualPos < c.position) {
      out += " ".repeat(c.position - visualPos);
      visualPos = c.position;
    } else if (visualPos > 0) {
      out += " ";
      visualPos += 1;
    }
    out += `<span class="chord-clickable cursor-pointer" data-chord="${escapeHtml(c.chord)}">${escapeHtml(c.chord)}</span>`;
    visualPos += c.chord.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
//  Rendering
// ---------------------------------------------------------------------------

/**
 * Render één regel als DOM-element: akkoordenregel boven de tekstregel.
 * Dankzij het monospace-font staan de akkoorden exact boven de juiste kolom.
 */
export function renderLine(line) {
  const wrap = document.createElement("div");
  wrap.className = "song-line";

  const chordsDiv = document.createElement("div");
  chordsDiv.className = "chords";
  chordsDiv.innerHTML = buildChordLineHTML(line.chords || []);

  const lyricsDiv = document.createElement("div");
  lyricsDiv.className = "lyrics";
  lyricsDiv.textContent = line.text || " ";

  wrap.appendChild(chordsDiv);
  wrap.appendChild(lyricsDiv);
  return wrap;
}

/** Menselijk leesbaar sectie-label (voor de weergave). */
export function sectionLabel(type) {
  const map = {
    verse: "Couplet",
    chorus: "Refrein",
    solo: "Solo",
    bridge: "Bridge",
    intro: "Intro",
    outro: "Outro",
    interlude: "Tussenspel",
    "pre-chorus": "Pre-refrein",
  };
  return map[type] || capitalize(type || "");
}

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
