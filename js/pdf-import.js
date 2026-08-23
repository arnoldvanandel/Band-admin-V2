// ============================================================================
//  PDF Import & Parsing
//  Leest een chord-sheet-PDF en reconstrueert de tekst als "line-by-line"
//  formaat (akkoordregel boven tekstregel) met correcte kolom-uitlijning.
//
//  Werkwijze:
//   1. PDF.js levert per pagina alle tekst-items met X/Y-coördinaten
//      (item.transform = [a, b, c, d, x, y]).
//   2. Items worden op Y-coördinaat gegroepeerd tot regels (PDF-Y loopt van
//      onder naar boven, dus hoogste Y = bovenste regel).
//   3. Per regel bepalen we of het een akkoordregel is (alleen akkoorden).
//   4. Voor elk akkoord berekenen we uit zijn X-coördinaat de karakter-index
//      binnen de tekstregel eronder: index = round((X_akkoord - X0) / charWidth),
//      waarbij X0 en charWidth uit de tekstregel komen.
//   5. Het resultaat wordt als platte tekst teruggegeven en door de bestaande
//      parseSongText() omgezet naar de Firestore-structuur.
// ============================================================================

import { isChordLine } from "./song-format.js";

// PDF.js v4 (ES-module build) via CDN — lazy geladen bij het eerste gebruik.
const PDFJS_MODULE = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs";
const PDFJS_WORKER = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs";

let _pdfjs = null;
async function loadPdfjs() {
  if (_pdfjs) return _pdfjs;
  _pdfjs = await import(PDFJS_MODULE);
  _pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  return _pdfjs;
}

// ---------------------------------------------------------------------------
//  Publieke API
// ---------------------------------------------------------------------------

/**
 * Parse een PDF (ArrayBuffer) naar line-by-line songtekst.
 * @returns {Promise<string>} tekst geschikt voor parseSongText()
 */
export async function pdfToText(arrayBuffer) {
  const pdfjs = await loadPdfjs();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;

  const pages = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items
      .filter((it) => it.str && it.str.trim() !== "")
      .map((it) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
        width: it.width || 0,
        h: Math.hypot(it.transform[1], it.transform[3]) || it.height || 10,
      }));
    if (items.length) pages.push(itemsToText(items));
  }
  return pages.join("\n\n").trim();
}

// ---------------------------------------------------------------------------
//  Pure reconstructie (zonder PDF.js — testbaar)
// ---------------------------------------------------------------------------

/**
 * Zet losse tekst-items ({str, x, y, width, h}) om naar line-by-line tekst.
 */
export function itemsToText(items) {
  const lines = groupLines(items);
  const out = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const x0 = minX(line.items);
    const cw = refCharWidth(line.items);
    const text = buildString(line.items, x0, cw);

    // Sectie-koptekst? (bijv. "Verse", "Refrein 2")
    const section = sectionOf(text);
    if (section) {
      out.push(`[${section}]`);
      continue;
    }

    if (isChordLine(text)) {
      const next = lines[i + 1];
      const nextText = next ? buildString(next.items, minX(next.items), refCharWidth(next.items)) : "";
      const nextIsLyric =
        next && nextText.trim() !== "" && !isChordLine(nextText) && !sectionOf(nextText);

      if (nextIsLyric) {
        // Herbouw de akkoordregel met de MAATVOERING van de tekstregel eronder,
        // zodat de kolommen exact overeenkomen (stap 4 uit de werkwijze).
        const lx0 = minX(next.items);
        const lcw = refCharWidth(next.items);
        out.push(buildChordString(line.items, lx0, lcw));
        out.push(nextText);
        i++; // tekstregel is verwerkt
      } else {
        out.push(text); // instrumentale akkoordregel zonder tekst
      }
    } else {
      out.push(text);
    }
  }

  return out.join("\n");
}

// ---------------------------------------------------------------------------
//  Interne helpers
// ---------------------------------------------------------------------------

/** Groepeer items tot regels op basis van hun Y-coördinaat (boven -> onder). */
function groupLines(items) {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  let cur = null;
  for (const it of sorted) {
    const tol = Math.max(3, (it.h || 10) * 0.5);
    if (cur && Math.abs(cur.y - it.y) <= tol) {
      cur.items.push(it);
    } else {
      cur = { y: it.y, items: [it] };
      lines.push(cur);
    }
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines;
}

/** Laagste X-coördinaat van een regel = de linkermarge (kolom 0). */
function minX(items) {
  return items.reduce((m, it) => Math.min(m, it.x), Infinity);
}

/** Schat de breedte van één karakter (mediaan over de items van de regel). */
function refCharWidth(items) {
  const widths = items
    .filter((it) => it.str.length > 0 && it.width > 0)
    .map((it) => it.width / it.str.length);
  if (!widths.length) {
    // Val terug op de fonthoogte als er geen breedtes bekend zijn.
    const h = items[0]?.h || 10;
    return h * 0.5;
  }
  widths.sort((a, b) => a - b);
  return widths[Math.floor(widths.length / 2)];
}

/** Plaats tekst op een bepaalde kolom in de opbouwende string. */
function placeAt(out, col, text) {
  if (out.length < col) out += " ".repeat(col - out.length);
  else if (out.length > 0) out += " "; // voorkom dat woorden aan elkaar plakken
  return out + text;
}

/** Bouw een tekstregel: elk item op de kolom die bij zijn X-coördinaat hoort. */
function buildString(items, x0, cw) {
  let out = "";
  for (const it of items) {
    const col = Math.max(0, Math.round((it.x - x0) / cw));
    out = placeAt(out, col, it.str);
  }
  return out.replace(/\s+$/, "");
}

/**
 * Bouw een akkoordregel uitgelijnd op de maatvoering (x0, cw) van de tekstregel.
 * Items kunnen meerdere akkoorden bevatten; elk krijgt zijn eigen X-positie.
 */
function buildChordString(items, x0, cw) {
  const tokens = [];
  for (const it of items) {
    const icw = it.str.length ? it.width / it.str.length : cw;
    const re = /\S+/g;
    let m;
    while ((m = re.exec(it.str)) !== null) {
      tokens.push({ token: m[0], x: it.x + m.index * icw });
    }
  }
  tokens.sort((a, b) => a.x - b.x);
  let out = "";
  for (const tk of tokens) {
    const col = Math.max(0, Math.round((tk.x - x0) / cw));
    out = placeAt(out, col, tk.token);
  }
  return out;
}

/** Herken een sectie-koptekst (Verse/Chorus/Solo/Bridge/…), eventueel met nummer. */
function sectionOf(text) {
  const t = text.trim().replace(/[:.]+$/, "");
  const m = t.match(
    /^(verse|couplet|vers|chorus|refrein|refr|solo|bridge|brug|intro|outro|tussenspel|interlude|pre-?chorus)\s*\d*$/i
  );
  if (!m) return null;
  const map = {
    verse: "Verse", couplet: "Verse", vers: "Verse",
    chorus: "Chorus", refrein: "Chorus", refr: "Chorus",
    solo: "Solo",
    bridge: "Bridge", brug: "Bridge",
    intro: "Intro", outro: "Outro",
    tussenspel: "Interlude", interlude: "Interlude",
  };
  const key = m[1].toLowerCase().replace("-", "");
  return map[key] || "Verse";
}
