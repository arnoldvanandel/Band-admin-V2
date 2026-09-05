// ============================================================================
//  FollowController
//  Centrale controller voor AI Follow.
//
//  De positie in het nummer is een combinatie van:
//
//    A. BPM / bestaande autoscroll  ->  voorspelling
//    B. Speech recognition          ->  correctie
//
//  De controller onthoudt een scroll-offset ten opzichte van de BPM-positie:
//
//      targetY = bpmY + offsetY
//
//  De BPM-loop blijft dus gewoon de voorspelling leveren (en vloeiend lopen);
//  spraakherkenning verschuift alleen de offset. De offset wordt bovendien
//  vloeiend geanimeerd richting zijn doel, zodat correcties nooit "springen".
//
//  Beveiligingen:
//    - lage confidence          -> niets doen (BPM blijft de baas)
//    - meerdere opeenvolgende herkenningen nodig voordat een correctie
//      geaccepteerd wordt (hysterese)
//    - maximale offset-stap per correctie (voorkomt grote sprongen)
//    - bij verlies van herkenning blijft de laatst geaccepteerde offset staan
// ============================================================================

import { LyricsMatcher } from "./lyrics-matcher.js";

const DEFAULT_OPTIONS = {
  acceptConfidence: 0.45,       // minimale confidence om een correctie te overwegen
  highConfidence: 0.70,         // bij deze score of hoger direct corrigeren (1× is genoeg)
  minInterimWords: 3,           // analyseer tussentijdse herkenning al vanaf zoveel woorden
  consecutiveMatches: 2,        // aantal opeenvolgende, overeenstemmende herkenningen
  settleWindowLines: 2,         // matches binnen dit aantal regels gelden als "dezelfde"
  maxOffsetChangePx: 600,       // max px dat de offset per correctie mag verschuiven
  offsetSpeedPxPerSec: 240,     // snelheid waarmee de offset vloeiend naar zijn doel beweegt
  debug: false,
};

export class FollowController {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.matcher = options.matcher || new LyricsMatcher();

    this._bpmY = 0;             // laatst bekende BPM/scroll-positie (px)
    this._bpmLine = 0;          // huidige voorspelde regelindex
    this._expectedLine = 0;     // waar we de zanger verwachten (input voor matcher)
    this._offsetY = 0;          // geanimeerde spraakcorrectie-offset t.o.v. BPM-positie
    this._offsetTarget = 0;     // doel-offset (waar _offsetY vloeiend naartoe beweegt)
    this._lastAnimAt = null;    // timestamp van de laatste offset-animatiestap
    this._acceptedLine = null;  // { lineIndex, confidence, at } laatste geaccepteerde correctie
    this._pending = null;       // { lineIndex, confidence, count } lopende hysterese
    this._lastMatch = null;     // laatste LyricsMatcher-resultaat (voor debug)
    this._lineYResolver = null; // fn(lineIndex) => scroll-Y in px
    this._onCorrection = null;  // callback bij een geaccepteerde correctie (voor de app)
  }

  /** Laad de songtekst (dezelfde structuur als song.content). */
  setSong(content) {
    this.matcher.setSong(content);
    this.reset();
  }

  /** Geef een functie op die een regelindex omzet naar een scroll-Y-positie. */
  setLineYResolver(fn) {
    this._lineYResolver = fn;
  }

  /**
   * Callback die afgaat zodra een spraakcorrectie geaccepteerd wordt.
   * De app kan hiermee bijv. een eenmalige smooth-scroll doen wanneer de
   * BPM-autoscroll niet draait.
   */
  setOnCorrection(fn) {
    this._onCorrection = fn;
  }

  /** Begin opnieuw (nieuw liedje). */
  reset() {
    this._bpmY = 0;
    this._bpmLine = 0;
    this._expectedLine = 0;
    this._offsetY = 0;
    this._offsetTarget = 0;
    this._lastAnimAt = null;
    this._acceptedLine = null;
    this._pending = null;
    this._lastMatch = null;
    this._log("reset");
  }

  /**
   * Update de BPM-voorspelling. Wordt elke frame/tick aangeroepen met de
   * huidige autoscroll-positie en de daaruit afgeleide regel.
   */
  updateBpm(y, lineIndex = null) {
    this._bpmY = y;
    if (lineIndex != null && Number.isFinite(lineIndex)) {
      this._bpmLine = Math.max(0, lineIndex);
    }
    this._animateOffset();
  }

  /**
   * Stel in waar we de zanger verwachten. De app berekent dit doorgaans uit
   * getTargetY() (BPM + offset), zodat de verwachting met de muziek meeloopt.
   */
  setExpectedLine(lineIndex) {
    if (lineIndex != null && Number.isFinite(lineIndex)) {
      this._expectedLine = Math.max(0, Math.round(lineIndex));
    }
  }

  /**
   * Verwerk een herkend tekstfragment van de SpeechService.
   * Alleen finale resultaten worden gebruikt voor correcties; interim-
   * fragmenten zijn te ruisgevoelig.
   *
   * @returns {object|null} het LyricsMatcher-resultaat (ook voor debug)
   */
  handleRecognition(transcript, isFinal) {
    // Finale resultaten altijd verwerken; tussentijdse (interim) resultaten
    // pas zodra er genoeg woorden zijn (kortere pauze = sneller analyseren).
    if (!isFinal) {
      const words = String(transcript || "").trim().split(/\s+/).filter(Boolean).length;
      if (words < this.options.minInterimWords) return null;
    }

    const match = this.matcher.match(transcript, this._expectedLine);
    this._lastMatch = match;
    this._log("match:", match);

    if (!match) return null;

    // Ambigue match: deze regel/zin komt (bijna) meerdere keren voor in het
    // liedje. We kunnen niet bepalen welke positie juist is → NIET scrollen.
    if (match.ambiguous) {
      this._pending = null;
      this._log("ambigue match genegeerd:", match);
      return match;
    }

    if (match.confidence < this.options.acceptConfidence) {
      // Lage confidence: NIET corrigeren, BPM blijft gewoon doorlopen.
      return match;
    }

    // Hoge confidence: direct corrigeren, één herkenning is genoeg.
    if (match.confidence >= this.options.highConfidence) {
      this._pending = null;
      this._acceptCorrection(match.lineIndex, match.confidence);
      return match;
    }

    // Hysterese: alleen corrigeren na meerdere overeenstemmende herkenningen.
    const settle = this.options.settleWindowLines;
    if (this._pending && Math.abs(this._pending.lineIndex - match.lineIndex) <= settle) {
      this._pending.count++;
      this._pending.lineIndex = match.lineIndex;
      this._pending.confidence = Math.max(this._pending.confidence, match.confidence);
    } else {
      this._pending = { lineIndex: match.lineIndex, confidence: match.confidence, count: 1 };
    }

    if (this._pending.count >= this.options.consecutiveMatches) {
      const pending = this._pending;
      this._pending = null;
      this._acceptCorrection(pending.lineIndex, pending.confidence);
    }

    return match;
  }

  /** Accepteer een spraakcorrectie: verschuif het offset-DOEL richting de regel. */
  _acceptCorrection(lineIndex, confidence) {
    if (!this._lineYResolver) return;
    const lineY = this._lineYResolver(lineIndex);
    if (lineY == null) return;

    const desiredOffset = lineY - this._bpmY;
    const oldTarget = this._offsetTarget;
    const delta = desiredOffset - oldTarget;
    const maxDelta = this.options.maxOffsetChangePx;

    let newTarget = desiredOffset;
    if (Math.abs(delta) > maxDelta) {
      // Begrens de sprong; bij een volgende herkenning schuiven we verder.
      newTarget = oldTarget + Math.sign(delta) * maxDelta;
    }

    this._offsetTarget = newTarget;
    this._acceptedLine = { lineIndex, confidence, at: Date.now() };
    this._expectedLine = lineIndex;
    this._log(`correctie: regel ${lineIndex}, offset-doel ${Math.round(newTarget)}px (was ${Math.round(oldTarget)}px)`);

    if (this._onCorrection) {
      try {
        this._onCorrection({ lineIndex, lineY, confidence, targetOffset: newTarget });
      } catch (ex) {
        console.error("onCorrection-callback fout:", ex);
      }
    }
  }

  /**
   * Verwerk de offset in de BPM-basispositie en zet de offset terug naar 0.
   * Handig wanneer BPM niet draait: na een eenmalige smooth-scroll naar een
   * herkende regel willen we geen blijvende offset meer.
   */
  absorbOffset() {
    this._bpmY = this._bpmY + this._offsetY;
    this._offsetY = 0;
    this._offsetTarget = 0;
    this._lastAnimAt = null;
    this._acceptedLine = null;
  }

  /** Is de offset nog onderweg naar zijn doel? */
  hasActiveCorrection() {
    return Math.abs(this._offsetTarget - this._offsetY) > 1;
  }

  /** Zet de offset terug naar 0 (bijv. bij pauzeren/uitzetten van AI Follow). */
  clearOffset() {
    this._offsetY = 0;
    this._offsetTarget = 0;
    this._lastAnimAt = null;
    this._acceptedLine = null;
  }

  /** De positie waar AI Follow naartoe wil (BPM-voorspelling + spraakcorrectie). */
  getTargetY() {
    return this._bpmY + this._offsetY;
  }

  /** Beweeg de offset vloeiend richting het doel (wordt elke frame aangeroepen). */
  _animateOffset() {
    if (this._lastAnimAt == null) {
      this._lastAnimAt = performance.now();
      return;
    }
    const now = performance.now();
    let dt = (now - this._lastAnimAt) / 1000;
    this._lastAnimAt = now;
    if (dt <= 0) return;
    dt = Math.min(dt, 0.1); // voorkom een sprong na lang inactief tabblad

    const diff = this._offsetTarget - this._offsetY;
    if (Math.abs(diff) < 0.5) {
      this._offsetY = this._offsetTarget;
      return;
    }
    const step = this.options.offsetSpeedPxPerSec * dt;
    this._offsetY += Math.sign(diff) * Math.min(step, Math.abs(diff));
  }

  /** Debug-overzicht voor de UI. */
  getDebug() {
    return {
      bpmY: Math.round(this._bpmY),
      bpmLine: this._bpmLine,
      expectedLine: this._expectedLine,
      offsetY: Math.round(this._offsetY),
      offsetTarget: Math.round(this._offsetTarget),
      targetY: Math.round(this.getTargetY()),
      acceptedLine: this._acceptedLine ? this._acceptedLine.lineIndex : null,
      acceptedConfidence: this._acceptedLine ? this._acceptedLine.confidence : null,
      pendingCount: this._pending ? this._pending.count : 0,
      lastMatch: this._lastMatch,
    };
  }

  _log(...args) {
    if (this.options.debug) console.log("[FollowController]", ...args);
  }
}
