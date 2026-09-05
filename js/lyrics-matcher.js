// ============================================================================
//  LyricsMatcher
//  Vergelijkt herkende spraak (van SpeechService) met de songtekst van het
//  huidige nummer en bepaalt welke regel het beste overeenkomt.
//
//  Retourneert minimaal:
//    - lineIndex   : globaal regelnummer (0-based, komt overeen met de
//                    volgorde van .song-line-elementen in #songBody)
//    - lineText    : de gevonden tekstregel
//    - confidence  : score tussen 0 en 1
//
//  Zoekstrategie:
//    - normaliseert tekst (kleine letters, leestekens en accenten eruit)
//    - tolereert kleine verschillen via fuzzy woordvergelijking
//    - zoekt EERST in een venster rond de verwachte positie (huidige regel)
//    - alleen als dat niets sterks oplevert wordt de hele songtekst doorzocht
//    - een herkend fragment mag over 1 tot maximaal 3 opeenvolgende regels
//      vallen (zanger loopt net over de regelgrens heen)
// ============================================================================

const DEFAULT_OPTIONS = {
  minConfidence: 0.30,      // onder deze score retourneren we null (niet corrigeren)
  strongConfidence: 0.80,   // venster-match die zo goed is dat volledig zoeken niet nodig is
  windowRadius: 6,          // aantal regels rond de verwachte positie dat eerst bekeken wordt
  maxWindowLines: 3,        // max aantal opeenvolgende regels waarop een fragment mag vallen
  minTokens: 2,             // fragmenten met minder woorden negeren (te weinig signaal)
  chunkSize: 3,             // match op combinaties van zoveel woorden (i.p.v. één hele zin)
  fuzzy: true,              // kleine schrijffouten/uitspraakverschillen tolereren
};

/** Verwijder hoofdletters, accenten en leestekens; houd woorden over. */
function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")           // accenten
    .replace(/[^a-z0-9\s'-]/g, " ")            // leestekens -> spatie
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return text.split(" ").filter(Boolean);
}

/** Levenshtein-afstand tussen twee woorden (voor fuzzy matching). */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
}

/** Score tussen twee woorden: 1 = exact, 0.7 = klein verschil, 0 = geen match. */
function wordScore(a, b, fuzzy) {
  if (a === b) return 1;
  if (!fuzzy) return 0;
  // Fuzzy alleen voor echte woorden (geen cijfers/afkortingen) van voldoende
  // lengte; anders blazen toevallige overeenkomsten de score te veel op.
  if (a.length < 4 || b.length < 4) return 0;
  if (!/^[a-z]+$/.test(a) || !/^[a-z]+$/.test(b)) return 0;
  if (levenshtein(a, b) <= 1) return 0.7;
  return 0;
}

export class LyricsMatcher {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this._entries = [];          // [{ index, text, tokens, sectionIndex, lineIndex, sectionType }]
    this._textToIndices = new Map(); // genormaliseerde tekst -> [regelindices] (voor ambiguïteit)
  }

  /**
   * Laad een songtekst. `content` is dezelfde structuur als song.content:
   * [ { type, lines: [ { text, chords? } ] } ]
   */
  setSong(content) {
    this._entries = [];
    this._textToIndices = new Map();
    let globalIndex = 0;
    for (let s = 0; s < (content || []).length; s++) {
      const section = content[s];
      for (let l = 0; l < (section.lines || []).length; l++) {
        const line = section.lines[l];
        const text = normalizeText(line.text);
        this._entries.push({
          index: globalIndex,
          text: line.text || "",
          normalized: text,
          tokens: tokenize(text),
          sectionIndex: s,
          lineIndex: l,
          sectionType: section.type || "",
        });
        if (text) {
          if (!this._textToIndices.has(text)) this._textToIndices.set(text, []);
          this._textToIndices.get(text).push(globalIndex);
        }
        globalIndex++;
      }
    }
    return this._entries.length;
  }

  get lineCount() {
    return this._entries.length;
  }

  /**
   * Zoek de beste regel bij een herkend tekstfragment.
   *
   * In plaats van één hele zin te matchen, schuiven we een venster van
   * `chunkSize` woorden (standaard 3) over de herkende tekst en scoren we elk
   * stukje. Zo kunnen we al tijdens een zin (korte pauze) herkennen, en wint
   * bij gelijke score het laatst herkende stukje (meest recente positie).
   *
   * @param {string} transcript   herkende tekst van SpeechService
   * @param {number} expectedIndex verwachte globale regelindex (huidige positie)
   * @returns {{ lineIndex, lineText, confidence, searchMode, windowSize } | null}
   */
  match(transcript, expectedIndex = 0) {
    if (!this._entries.length) return null;

    const tokens = tokenize(normalizeText(transcript));
    if (tokens.length < this.options.minTokens) return null;

    const expected = Math.max(0, Math.min(this._entries.length - 1, Math.round(expectedIndex) || 0));
    const chunkSize = Math.max(this.options.minTokens, this.options.chunkSize || 3);

    // Kort fragment: match het fragment in zijn geheel.
    if (tokens.length <= chunkSize) {
      return this._matchTokens(tokens, expected);
    }

    // Langer fragment: schuif een 3-woord-venster over de tekst. Bij gelijke
    // score wint het latere venster (de woorden die het laatst gezongen zijn).
    let best = null;
    for (let i = 0; i <= tokens.length - chunkSize; i++) {
      const chunk = tokens.slice(i, i + chunkSize);
      const r = this._matchTokens(chunk, expected);
      if (r && (!best || r.confidence >= best.confidence)) best = r;
    }
    return best;
  }

  /** Match een concreet token-rijtje (1 chunk) tegen de songtekst. */
  _matchTokens(tokens, expected) {
    // 1) Zoek eerst in het venster rond de verwachte positie (voorkeur dichtbij).
    const radius = this.options.windowRadius;
    const from = Math.max(0, expected - radius);
    const to = Math.min(this._entries.length - 1, expected + radius);
    let bestWindow = null;
    for (let i = from; i <= to; i++) {
      const r = this._scoreAt(i, tokens);
      if (r && (!bestWindow || r.confidence > bestWindow.confidence)) bestWindow = r;
    }

    // 2) Volledige scan: nodig om te zien of dezelfde 3-woord-combinatie op
    //    meerdere plekken in het liedje voorkomt.
    const fullCandidates = [];
    let linesWithAllTokens = 0;
    for (let i = 0; i < this._entries.length; i++) {
      const r = this._scoreAt(i, tokens);
      if (r) fullCandidates.push(r);
      if (this._entryHasAllTokens(this._entries[i], tokens)) linesWithAllTokens++;
    }

    if (!fullCandidates.length) {
      if (bestWindow && bestWindow.confidence >= this.options.minConfidence) {
        return this._toResult(bestWindow, "window", this._isRepeatedLine(bestWindow.lineIndex));
      }
      return null;
    }

    fullCandidates.sort((a, b) => b.confidence - a.confidence);
    const bestFull = fullCandidates[0];

    // Kies tussen venster en volledige zoektocht. Het venster heeft een lichte
    // voorkeur (herhaald refrein blijft zo dicht bij de verwachte positie),
    // maar een duidelijk betere match buiten het venster wint.
    const fullWins = bestFull.confidence > (bestWindow ? bestWindow.confidence : 0) + 0.10;
    const best = fullWins ? bestFull : bestWindow;
    if (!best || best.confidence < this.options.minConfidence) return null;

    // Ambiguïteit:
    //  - dezelfde regeltekst staat op meerdere plekken, of
    //  - de 3-woord-combinatie zelf staat op meerdere regels, of
    //  - er zijn meerdere regels met vrijwel dezelfde score.
    // Dan kunnen we niet bepalen welke positie juist is → niet scrollen.
    const closeCount = fullCandidates.filter(
      (r) => r.confidence >= bestFull.confidence - 0.05
    ).length;
    const ambiguous =
      this._isRepeatedLine(best.lineIndex) ||
      linesWithAllTokens >= 2 ||
      closeCount >= 2;

    return this._toResult(best, fullWins ? "full" : "window", ambiguous);
  }

  /** Bevat deze regel alle woorden van het fragment? (voor herhalingsdetectie) */
  _entryHasAllTokens(entry, tokens) {
    for (const t of tokens) {
      if (!entry.tokens.includes(t)) return false;
    }
    return true;
  }

  /** Komt deze genormaliseerde regeltekst op meerdere plekken in het liedje voor? */
  _isRepeatedLine(lineIndex) {
    const entry = this._entries[lineIndex];
    if (!entry || !entry.normalized) return false;
    return (this._textToIndices.get(entry.normalized) || []).length > 1;
  }

  /** Score voor een venster dat begint bij regel `startIndex`. */
  _scoreAt(startIndex, transcriptTokens) {
    let best = null;
    const maxLines = Math.min(this.options.maxWindowLines, this._entries.length - startIndex);

    for (let size = 1; size <= maxLines; size++) {
      const windowTokens = [];
      for (let k = 0; k < size; k++) {
        windowTokens.push(...this._entries[startIndex + k].tokens);
      }
      if (!windowTokens.length) continue;

      const { matched, dice } = this._compare(transcriptTokens, windowTokens);
      if (best == null || dice > best.confidence) {
        best = { lineIndex: startIndex, windowSize: size, confidence: dice, matched };
      }
    }
    return best;
  }

  /** Vergelijk transcript-tokens met venster-tokens (greedy fuzzy matching). */
  _compare(transcriptTokens, windowTokens) {
    const used = new Array(windowTokens.length).fill(false);
    let matched = 0;

    for (const t of transcriptTokens) {
      let bestJ = -1;
      let bestScore = 0;
      for (let j = 0; j < windowTokens.length; j++) {
        if (used[j]) continue;
        const s = wordScore(t, windowTokens[j], this.options.fuzzy);
        if (s === 1) { bestJ = j; bestScore = 1; break; } // exact is direct raak
        if (s > bestScore) { bestJ = j; bestScore = s; }
      }
      if (bestJ >= 0) {
        used[bestJ] = true;
        matched += bestScore;
      }
    }

    const dice = (2 * matched) / (transcriptTokens.length + windowTokens.length);
    return { matched, dice };
  }

  _toResult(best, searchMode, ambiguous = false) {
    const entry = this._entries[best.lineIndex];
    return {
      lineIndex: entry.index,
      lineText: entry.text,
      confidence: Math.round(best.confidence * 1000) / 1000,
      searchMode,                  // "window" | "full" (handig voor debug)
      windowSize: best.windowSize, // op hoeveel regels het fragment viel
      matchedWords: best.matched,  // gewogen aantal gematchte woorden (debug)
      sectionType: entry.sectionType,
      ambiguous,                   // true = tekst komt (bijna) meerdere keren voor
    };
  }
}
