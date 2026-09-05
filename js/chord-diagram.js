// ============================================================================
//  Gitaargreep SVG-renderer in Chordify-stijl (donker thema)
// ============================================================================

/**
 * Render een SVG gitaargreep-diagram.
 * @param {Object} chordData - { chordName, baseFret, frets, fingers }
 * @returns {string} SVG als HTML-string
 */
export function renderChordSVG(chordData) {
  const {
    chordName = "?",
    baseFret = 1,
    frets = [-1, 0, 2, 2, 1, 0],
    fingers = [0, 0, 0, 0, 0, 0],
  } = chordData;

  // --- Afmetingen ---
  const PAD_LEFT = 22;
  const PAD_RIGHT = 12;
  const PAD_TOP = 48;
  const PAD_BOTTOM = 18;
  const STRING_SPACING = 32;
  const FRET_SPACING = 38;

  const numStrings = 6;
  const numFrets = 5; // toon maximaal 5 frets

  // X-posities van de snaren
  const stringX = [];
  for (let i = 0; i < numStrings; i++) {
    stringX.push(PAD_LEFT + i * STRING_SPACING);
  }

  const totalW = stringX[5] + PAD_RIGHT;
  const nutY = PAD_TOP + 14;
  const totalH = nutY + numFrets * FRET_SPACING + PAD_BOTTOM;

  // Helper: y-positie van een fretlijn
  const fretY = (f) => nutY + f * FRET_SPACING;

  // Helper: y-positie midden tussen twee fretten (voor de stip)
  const dotY = (f) => {
    if (f === 0) return nutY + FRET_SPACING / 2; // open string: geen stip, X/O bovenaan
    return nutY + (f - 0.5) * FRET_SPACING;
  };

  let svg = "";
  svg += `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalW} ${totalH}" width="210" height="${Math.round(totalH * 210 / totalW)}">`;

  // --- Achtergrond ---
  svg += `<rect x="0" y="0" width="${totalW}" height="${totalH}" fill="#1e1e24" rx="8"/>`;

  // --- Akkoordnaam ---
  svg += `<text x="${totalW / 2}" y="${PAD_TOP - 6}" fill="#ffffff" font-size="22" font-weight="700" font-family="system-ui, sans-serif" text-anchor="middle">${escapeXml(chordName)}</text>`;

  // --- Base fret nummer (als > 1) ---
  if (baseFret > 1) {
    svg += `<text x="${stringX[0] - 10}" y="${dotY(1) + 5}" fill="#aaa" font-size="12" font-family="system-ui, sans-serif" text-anchor="end">${baseFret}</text>`;
  }

  // --- Snaar-lijnen (verticaal) ---
  for (let i = 0; i < numStrings; i++) {
    const x = stringX[i];
    const topY = nutY;
    const bottomY = fretY(numFrets);
    // Iets dikkere lijn voor de bassnaar (E, A)
    const strokeW = i < 2 ? 2.2 : i < 4 ? 1.8 : 1.4;
    svg += `<line x1="${x}" y1="${topY}" x2="${x}" y2="${bottomY}" stroke="#888" stroke-width="${strokeW}" stroke-linecap="round"/>`;
  }

  // --- Fret-lijnen (horizontaal) ---
  for (let f = 0; f <= numFrets; f++) {
    const y = fretY(f);
    const strokeW = f === 0 ? 3.5 : 1.2;
    const color = f === 0 ? "#ccc" : "#555";
    svg += `<line x1="${stringX[0]}" y1="${y}" x2="${stringX[5]}" y2="${y}" stroke="${color}" stroke-width="${strokeW}" stroke-linecap="round"/>`;
  }

  // --- Vinger-indicatoren (stippen) ---
  for (let i = 0; i < numStrings; i++) {
    const f = frets[i] != null ? frets[i] : -1;
    if (f >= 1) {
      // Toon de stip alleen als deze binnen het zichtbare fretbereik valt
      const visibleFret = f - baseFret + 1;
      if (visibleFret >= 1 && visibleFret <= numFrets) {
        const cx = stringX[i];
        const cy = dotY(visibleFret);
        svg += `<circle cx="${cx}" cy="${cy}" r="10" fill="#ffffff"/>`;
        // Vingernummer (klein in het midden van de stip)
        if (fingers[i] && fingers[i] > 0) {
          svg += `<text x="${cx}" y="${cy + 5}" fill="#1e1e24" font-size="11" font-weight="700" font-family="system-ui, sans-serif" text-anchor="middle">${fingers[i]}</text>`;
        }
      }
    }
  }

  // --- X (gedempt) en O (open) boven de snaren ---
  for (let i = 0; i < numStrings; i++) {
    const f = frets[i] != null ? frets[i] : -1;
    const cx = stringX[i];
    const cy = nutY - 10;
    if (f === -1) {
      // X — gedempte snaar
      const s = 5;
      svg += `<line x1="${cx - s}" y1="${cy - s}" x2="${cx + s}" y2="${cy + s}" stroke="#e05555" stroke-width="2.2" stroke-linecap="round"/>`;
      svg += `<line x1="${cx + s}" y1="${cy - s}" x2="${cx - s}" y2="${cy + s}" stroke="#e05555" stroke-width="2.2" stroke-linecap="round"/>`;
    } else if (f === 0) {
      // O — open snaar
      svg += `<circle cx="${cx}" cy="${cy}" r="6" fill="none" stroke="#ffffff" stroke-width="2"/>`;
    }
  }

  svg += `</svg>`;
  return svg;
}

function escapeXml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Toon de chord modal.
 * @param {string} svgString - de SVG-string
 * @param {{wide?: boolean}} [options] - wide = bredere modal (voor piano)
 */
export function showChordModal(svgString, { wide = false } = {}) {
  const modal = document.getElementById("chordModal");
  const svgContainer = document.getElementById("chordModalSvg");
  const body = document.getElementById("chordModalBody");
  if (!modal || !svgContainer) return;
  svgContainer.innerHTML = svgString;
  // De gitaargreep past in een smalle kaart; het pianoklavier heeft meer ruimte
  // nodig. Inline style overschrijft de Tailwind max-w-klasse betrouwbaar.
  if (body) body.style.maxWidth = wide ? "min(94vw, 560px)" : "min(94vw, 260px)";
  modal.classList.remove("hidden");
}

/** Sluit de chord modal. */
export function hideChordModal() {
  const modal = document.getElementById("chordModal");
  if (modal) modal.classList.add("hidden");
}
