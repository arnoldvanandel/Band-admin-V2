// ============================================================================
//  Piano-akkoorden SVG-renderer in Chordify-stijl (donker thema)
// ----------------------------------------------------------------------------
//  Deze module rekent uit welke noten bij een akkoordnaam horen en tekent een
//  pianoklavier (2 octaven, C4 t/m B5) met de akkoordtonen gemarkeerd en
//  vingernummers (maximaal 4, in één kleur) op de getoonde toetsen.
//  Het uiterlijk sluit aan bij de gitaargreep-popup: donkere kaart, witte
//  akkoordnaam bovenaan en daaronder het instrument.
// ============================================================================

const NOTE_OFFSETS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const PITCH_CLASS_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// true = witte toets, false = zwarte toets (pitch class 0 = C).
const IS_WHITE = [true, false, true, false, true, true, false, true, false, true, false, true];

// Eerste en laatste MIDI-noot van het klavier (2 octaven, C4 t/m B5).
const FIRST_MIDI = 60; // C4
const LAST_MIDI = 83;  // B5

/**
 * Parse een akkoordnaam (bijv. "C", "Dm7", "G/B", "F#m7b5") naar:
 * { root: pitch class 0-11, notes: Set van pitch classes } of null.
 * Nederlandse/Engelse notenamen met # en b worden ondersteund.
 */
export function chordToNotes(chordName) {
  const raw = String(chordName || "").trim();
  if (!raw) return null;

  // Slash-akkoord: "C/G" → hoofdakkoord "C", bastoon "G".
  const slashIdx = raw.indexOf("/");
  const mainPart = (slashIdx >= 0 ? raw.slice(0, slashIdx) : raw).trim();
  const bassPart = slashIdx >= 0 ? raw.slice(slashIdx + 1).trim() : "";

  const m = /^([A-Ga-g])([#b]?)(.*)$/.exec(mainPart);
  if (!m) return null;

  const letter = m[1].toUpperCase();
  const accidental = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  const root = (((NOTE_OFFSETS[letter] + accidental) % 12) + 12) % 12;
  const suffix = m[3].toLowerCase();

  const intervals = new Set([0]); // grondtoon
  let third = 4;                  // 4 = grote terts; null = power chord (geen terts)
  let fifth = 7;                  // 7 = reine kwint
  let dim = false;                // dim-akkoord: de 7 wordt een verminderde septiem

  let i = 0;
  const s = suffix;
  while (i < s.length) {
    if (s.startsWith("maj7", i)) { intervals.add(11); i += 4; continue; }
    if (s.startsWith("maj", i)) { i += 3; continue; }
    if (s.startsWith("min", i)) { third = 3; i += 3; continue; }
    if (s.startsWith("dim", i)) { third = 3; fifth = 6; dim = true; i += 3; continue; }
    if (s.startsWith("aug", i)) { third = 4; fifth = 8; i += 3; continue; }
    if (s.startsWith("sus", i)) {
      third = s[i + 3] === "2" ? 2 : 5;
      i += 4;
      continue;
    }
    if (s.startsWith("add", i)) {
      const numMatch = /^\d+/.exec(s.slice(i + 3));
      const n = numMatch ? parseInt(numMatch[0], 10) : 0;
      if (n === 9) intervals.add(14);
      else if (n === 11) intervals.add(17);
      else if (n === 13) intervals.add(21);
      i += 3 + (numMatch ? numMatch[0].length : 0);
      continue;
    }

    const ch = s[i];
    if (ch === "m") { third = 3; i++; continue; }
    if (ch === "°" || ch === "ø" || ch === "o") { third = 3; fifth = 6; dim = true; i++; continue; }
    if (ch === "Δ") { intervals.add(11); i++; continue; }
    if (ch === "+") { fifth = 8; i++; continue; }
    if (ch === "-") { third = 3; i++; continue; }
    if ((ch === "b" || ch === "#") && s[i + 1] === "5") {
      fifth = ch === "b" ? 6 : 8;
      i += 2;
      continue;
    }
    if (ch >= "0" && ch <= "9") {
      const numMatch = /^\d+/.exec(s.slice(i));
      const n = parseInt(numMatch[0], 10);
      if (n === 5) { third = null; fifth = 7; }
      else if (n === 6) { intervals.add(9); }
      else if (n === 7) { intervals.add(dim ? 9 : 10); }
      else if (n === 9) { intervals.add(10); intervals.add(14); }
      else if (n === 11) { intervals.add(10); intervals.add(17); }
      else if (n === 13) { intervals.add(10); intervals.add(21); }
      i += numMatch[0].length;
      continue;
    }
    i++;
  }

  if (third !== null) intervals.add(third);
  intervals.add(fifth);

  // Zet intervallen om naar pitch classes (modulo 12).
  const notes = new Set();
  for (const iv of intervals) {
    notes.add(((root + iv) % 12 + 12) % 12);
  }

  // Bastoon van een slash-akkoord hoort ook bij de klank.
  if (bassPart) {
    const bm = /^([A-Ga-g])([#b]?)/.exec(bassPart);
    if (bm) {
      const bassAcc = bm[2] === "#" ? 1 : bm[2] === "b" ? -1 : 0;
      const bassPc = (((NOTE_OFFSETS[bm[1].toUpperCase()] + bassAcc) % 12) + 12) % 12;
      notes.add(bassPc);
    }
  }

  return { root, notes };
}

/**
 * Bepaal de getoonde ligging (voicing) van een akkoord: maximaal 4 tonen in
 * grondligging vanaf C4, met vingernummers 1 t/m 4 (laag → hoog).
 * @param {{root: number, notes: Set<number>}|null} parsed - resultaat van chordToNotes
 * @returns {Array<{midi: number, finger: number}>}
 */
export function chordVoicing(parsed) {
  if (!parsed) return [];
  const { root, notes } = parsed;

  // Afstand van een pitch class tot de grondtoon (in halve tonen).
  const intervalOf = (pc) => (((pc - root) % 12) + 12) % 12;
  const pcs = [...notes];
  const intervalFor = new Map(pcs.map((pc) => [pc, intervalOf(pc)]));

  // Kies maximaal 4 tonen met de belangrijkste akkoordklank eerst:
  // grondtoon → terts → kwint → septiem. Kleuringen (9, 11, 13) vullen aan.
  const groups = [
    [0],         // grondtoon
    [3, 4],      // kleine/grote terts (of sus)
    [7, 6, 8],   // reine/verminderde/overmatige kwint
    [10, 11, 9], // klein/groot septiem of sext
  ];
  const ordered = [];
  const used = new Set();
  for (const group of groups) {
    for (const pc of pcs) {
      if (used.has(pc)) continue;
      if (group.includes(intervalFor.get(pc))) {
        used.add(pc);
        ordered.push(pc);
      }
    }
  }
  const rest = pcs
    .filter((pc) => !used.has(pc))
    .sort((a, b) => intervalFor.get(a) - intervalFor.get(b));
  const selected = ordered.concat(rest).slice(0, 4);

  const midis = [];
  for (const pc of selected) {
    // Eerste MIDI-noot ≥ C4 met deze pitch class, oplopend houden.
    let midi = 60 + ((((pc - 60) % 12) + 12) % 12);
    while (midis.length && midi <= midis[midis.length - 1]) midi += 12;
    midis.push(midi);
  }

  return midis.map((midi, i) => ({ midi, finger: i + 1 }));
}

/**
 * Zet een nootnaam ("C", "F#", "Bb") om naar een pitch class (0-11), of null.
 */
export function noteNameToPitchClass(name) {
  const m = /^([A-Ga-g])([#b]?)/.exec(String(name || "").trim());
  if (!m) return null;
  const letter = m[1].toUpperCase();
  if (!(letter in NOTE_OFFSETS)) return null;
  const acc = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  return (((NOTE_OFFSETS[letter] + acc) % 12) + 12) % 12;
}

/**
 * Bouw een voicing uit handmatig opgegeven noten en (optioneel) vingers.
 * @param {string[]} noteNames - bijv. ["C", "E", "G", "Bb"]
 * @param {number[]} [fingers] - vingernummers, even lang als noteNames
 * @returns {Array<{midi: number, finger: number}>}
 */
export function customVoicing(noteNames, fingers = []) {
  const pcs = (noteNames || [])
    .map((n) => noteNameToPitchClass(n))
    .filter((pc) => pc !== null)
    .slice(0, 4);

  const midis = [];
  for (const pc of pcs) {
    // Eerste MIDI-noot ≥ C4 met deze pitch class, oplopend houden.
    let midi = 60 + ((((pc - 60) % 12) + 12) % 12);
    while (midis.length && midi <= midis[midis.length - 1]) midi += 12;
    midis.push(midi);
  }

  return midis.map((midi, i) => ({
    midi,
    finger: Number(fingers?.[i]) || i + 1,
  }));
}

/**
 * Render een SVG-pianoklavier met de akkoordtonen gemarkeerd.
 * @param {string} chordName - de akkoordnaam, bijv. "C", "Am7", "G/B"
 * @param {{notes?: string[], fingers?: number[]}|null} [custom] - optioneel
 *   handmatig opgegeven noten/vingers (uit de piano-akkoorden database)
 * @returns {string} SVG als HTML-string (responsive, donker thema)
 */
export function renderPianoChordSVG(chordName, custom = null) {
  const parsed = chordToNotes(chordName);

  // --- Afmetingen ---
  const PAD = 20;
  const TITLE_Y = 38;
  const KEYS_Y = 70;
  const WHITE_W = 34;
  const WHITE_H = 132;
  const BLACK_W = 22;
  const BLACK_H = 82;
  const WHITE_FILL = "#f5f5f7";
  const WHITE_STROKE = "#3a3a44";
  const BLACK_FILL = "#15151b";
  const HIGHLIGHT = "#4fc3f7";   // akkoordtonen (licht blauw, Chordify-stijl)
  const FINGER_COLOR = "#0b1220"; // vingernummers: allemaal dezelfde kleur

  const whiteCount = 14; // C4 t/m B5 = 2 octaven
  const totalW = PAD * 2 + whiteCount * WHITE_W;
  const totalH = KEYS_Y + WHITE_H + PAD;

  let svg = "";
  svg += `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${totalH}" style="width:100%;height:auto;display:block">`;

  // --- Achtergrond ---
  svg += `<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="#1e1e24" rx="10"/>`;

  // --- Akkoordnaam ---
  svg += `<text x="${totalW / 2}" y="${TITLE_Y}" fill="#ffffff" font-size="24" font-weight="700" font-family="system-ui, sans-serif" text-anchor="middle">${escapeXml(chordName || "?")}</text>`;

  // Gebruik handmatig opgegeven noten/vingers als die er zijn, anders de
  // automatisch berekende ligging op basis van de akkoordnaam.
  const hasCustom = custom && Array.isArray(custom.notes) && custom.notes.length > 0;
  const voicing = hasCustom
    ? customVoicing(custom.notes, custom.fingers)
    : chordVoicing(parsed);

  if (!voicing.length) {
    svg += `<text x="${totalW / 2}" y="${KEYS_Y + WHITE_H / 2 + 5}" fill="#9aa0aa" font-size="15" font-family="system-ui, sans-serif" text-anchor="middle">Onbekend akkoord — geen noten gevonden</text>`;
    svg += `</svg>`;
    return svg;
  }

  const fingerByMidi = new Map(voicing.map((v) => [v.midi, v.finger]));

  // Posities per MIDI-noot opbouwen (witte toetsen bepalen de lay-out).
  const keyPos = []; // { midi, x, white }
  let whiteIndex = 0;
  for (let midi = FIRST_MIDI; midi <= LAST_MIDI; midi++) {
    const pc = midi % 12;
    if (IS_WHITE[pc]) {
      keyPos.push({ midi, x: PAD + whiteIndex * WHITE_W, white: true });
      whiteIndex++;
    } else {
      // Zwarte toets zit midden op de grens tussen de linker- en rechterwitte toets.
      const x = PAD + whiteIndex * WHITE_W - BLACK_W / 2;
      keyPos.push({ midi, x, white: false });
    }
  }

  // --- Witte toetsen ---
  for (const key of keyPos) {
    if (!key.white) continue;
    const finger = fingerByMidi.get(key.midi);
    const fill = finger ? HIGHLIGHT : WHITE_FILL;
    svg += `<rect x="${key.x}" y="${KEYS_Y}" width="${WHITE_W}" height="${WHITE_H}" rx="3" fill="${fill}" stroke="${WHITE_STROKE}" stroke-width="1"/>`;
  }

  // --- Zwarte toetsen (bovenop) ---
  for (const key of keyPos) {
    if (key.white) continue;
    const finger = fingerByMidi.get(key.midi);
    const fill = finger ? HIGHLIGHT : BLACK_FILL;
    svg += `<rect x="${key.x}" y="${KEYS_Y}" width="${BLACK_W}" height="${BLACK_H}" rx="3" fill="${fill}" stroke="#000000" stroke-width="1"/>`;
  }

  // --- Vingernummers (maximaal 4, allemaal in dezelfde kleur) ---
  for (const key of keyPos) {
    const finger = fingerByMidi.get(key.midi);
    if (!finger) continue;
    if (key.white) {
      svg += `<text x="${key.x + WHITE_W / 2}" y="${KEYS_Y + WHITE_H - 30}" fill="${FINGER_COLOR}" font-size="15" font-weight="700" font-family="system-ui, sans-serif" text-anchor="middle">${finger}</text>`;
    } else {
      svg += `<text x="${key.x + BLACK_W / 2}" y="${KEYS_Y + BLACK_H - 14}" fill="${FINGER_COLOR}" font-size="11" font-weight="700" font-family="system-ui, sans-serif" text-anchor="middle">${finger}</text>`;
    }
  }

  svg += `</svg>`;
  return svg;
}

/** Maak notenamen leesbaar voor eventuele labels/tests. */
export function pitchClassName(pc) {
  return PITCH_CLASS_NAMES[((pc % 12) + 12) % 12];
}

function escapeXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
