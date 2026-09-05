// ============================================================================
//  SpeechService
//  Wrapper rond de Web Speech API (SpeechRecognition) voor AI Follow.
//
//  Doel:
//  - microfoontoegang aanvragen zodra er gestart wordt
//  - gesproken/gezongen audio omzetten naar tekst
//  - herkende tekstfragmenten doorgeven via callbacks
//  - netjes omgaan met fouten, time-outs en herstarten van recognition
//
//  De rest van de applicatie praat alleen tegen deze klasse (start/stop/
//  callbacks). Zo kan deze service later vervangen worden door een externe
//  speech-to-text API zonder dat de rest van de app aangepast hoeft te worden.
// ============================================================================

const DEFAULT_OPTIONS = {
  lang: "nl-NL",            // herkenningstaal (bijv. "nl-NL", "en-US")
  continuous: true,         // blijven luisteren
  interimResults: true,     // ook tussentijdse (nog niet finale) resultaten
  maxAlternatives: 1,       // alleen het beste alternatief per fragment
  restartDelayMs: 250,      // wachttijd voordat een gestopte sessie automatisch herstart
  silenceTimeoutMs: 10000,  // geen enkel resultaat binnen deze tijd -> herstart
  debug: false,             // uitgebreide console-logs tijdens ontwikkeling
};

const ERROR_MESSAGES = {
  "no-speech": "Geen spraak gedetecteerd.",
  aborted: "Herkenning afgebroken.",
  "audio-capture": "Geen microfoon gevonden of microfoon is bezet.",
  network: "Netwerkfout tijdens spraakherkenning.",
  "not-allowed": "Microfoontoegang geweigerd. Geef toestemming in de browser.",
  "service-not-allowed": "Spraakherkenning is niet toegestaan in deze browser/omgeving.",
  "language-not-supported": "De ingestelde taal wordt niet ondersteund.",
};

export class SpeechService {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.recognition = null;
    this.active = false;         // true tussen start() en stop()
    this.restarting = false;     // true tijdens een automatische herstart
    this.fatalError = null;      // na een fout die automatisch herstarten blokkeert
    this.lastResultAt = 0;       // timestamp van het laatste resultaat
    this.restartTimer = null;
    this.silenceTimer = null;

    // Callbacks (in te stellen via setCallbacks):
    this.onResult = null;   // ({ transcript, isFinal, confidence }) => {}
    this.onState = null;    // (state, detail) => {}  state: "inactive"|"starting"|"listening"|"restarting"|"error"
    this.onError = null;    // ({ code, message }) => {}
  }

  /** Ondersteunt deze browser de Web Speech API? */
  static isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }

  /** Stel de callbacks in. Ketenbaar voor compact gebruik. */
  setCallbacks({ onResult, onState, onError }) {
    this.onResult = onResult || null;
    this.onState = onState || null;
    this.onError = onError || null;
    return this;
  }

  /** Vraag microfoontoegang en start de herkenning. */
  start() {
    if (!SpeechService.isSupported()) {
      this.fatalError = { code: "unsupported", message: "Deze browser ondersteunt geen spraakherkenning." };
      this._emitState("error", this.fatalError.message);
      this._emitError(this.fatalError);
      return false;
    }

    if (this.active) return true;

    this.active = true;
    this.fatalError = null;
    this.lastResultAt = 0;

    try {
      this._createRecognition();
      this.recognition.start();
      this._emitState("starting");
      this._startSilenceWatchdog();
      this._log("SpeechRecognition gestart (lang=" + this.options.lang + ")");
      return true;
    } catch (ex) {
      // Bijv. als start() wordt aangeroepen terwijl er al een sessie loopt.
      this.active = false;
      this.fatalError = { code: "start-failed", message: ex?.message || String(ex) };
      this._emitError(this.fatalError);
      return false;
    }
  }

  /** Stop de herkenning definitief (geen automatische herstart meer). */
  stop() {
    if (!this.active && !this.restarting) {
      this._log("stop() genegeerd: niet actief");
      return;
    }

    this.active = false;
    this.restarting = false;
    this._clearTimers();

    // Abort breekt direct af (geen onend-herstart); stop() laat de huidige
    // uiting netjes afronden. We gebruiken stop() wanneer beschikbaar.
    try {
      if (this.recognition) this.recognition.stop();
    } catch (ex) {
      // State kan al "inactive" zijn; dan is stop() niet meer mogelijk.
      this._log("stop() op recognition mislukte: " + (ex?.message || ex));
    }
    this._emitState("inactive");
  }

  /** Hard stoppen (bij view-wissels): direct afbreken. */
  abort() {
    this.active = false;
    this.restarting = false;
    this._clearTimers();
    try {
      if (this.recognition) this.recognition.abort();
    } catch (ex) {
      this._log("abort() mislukte: " + (ex?.message || ex));
    }
    this._emitState("inactive");
  }

  // ---------------------------------------------------------------------------
  //  Interne opbouw
  // ---------------------------------------------------------------------------

  _createRecognition() {
    const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new Ctor();

    rec.lang = this.options.lang;
    rec.continuous = !!this.options.continuous;
    rec.interimResults = !!this.options.interimResults;
    rec.maxAlternatives = this.options.maxAlternatives;

    rec.onstart = () => {
      this._emitState("listening");
    };

    rec.onresult = (event) => {
      this.lastResultAt = Date.now();
      let interim = "";
      let finalText = "";
      let confidence = 0;

      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const alternative = result[0] || {};
        const text = alternative.transcript || "";
        confidence = typeof alternative.confidence === "number" ? alternative.confidence : 0;

        if (result.isFinal) {
          finalText += text;
        } else {
          interim += text;
        }
      }

      const transcript = (finalText || interim).trim();
      if (!transcript) return;

      const payload = {
        transcript,
        isFinal: !!finalText,
        confidence,
      };

      if (payload.isFinal) {
        this._log("Finale herkenning:", transcript, "(confidence " + confidence.toFixed(2) + ")");
      }

      if (this.onResult) {
        try { this.onResult(payload); } catch (ex) { console.error("onResult-callback fout:", ex); }
      }
    };

    rec.onerror = (event) => {
      const code = event.error || "unknown";
      const message = ERROR_MESSAGES[code] || `Spraakherkenning fout (${code}).`;

      this._log("SpeechRecognition error:", code, "-", message);

      // Bij deze fouten is herstarten zinloos of ongewenst:
      const fatal = code === "not-allowed" || code === "service-not-allowed" || code === "language-not-supported";
      if (fatal) {
        this.active = false;
        this.fatalError = { code, message };
        this._clearTimers();
        this._emitState("error", message);
        this._emitError(this.fatalError);
      } else {
        // Bijv. "no-speech" of "network": melden, maar niet definitief stoppen.
        // De onend-handler start opnieuw zolang `active` true is.
        this._emitError({ code, message });
      }
    };

    rec.onend = () => {
      this._log("SpeechRecognition onend (active=" + this.active + ", restarting=" + this.restarting + ")");
      this._clearTimers();

      if (this.active && !this.fatalError) {
        // De Web Speech API stopt vanzelf na een pauze of een fout; herstart
        // zolang de gebruiker AI Follow aan heeft staan.
        this.restarting = true;
        this._emitState("restarting");
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.active) return; // inmiddels gestopt
          try {
            this._createRecognition();
            this.recognition.start();
            this._startSilenceWatchdog();
          } catch (ex) {
            this.restarting = false;
            this.fatalError = { code: "restart-failed", message: ex?.message || String(ex) };
            this._emitError(this.fatalError);
            this._emitState("error", this.fatalError.message);
          }
        }, this.options.restartDelayMs);
      } else {
        this.restarting = false;
        if (!this.fatalError) this._emitState("inactive");
      }
    };

    this.recognition = rec;
  }

  /** Herstart de sessie als er te lang niets herkend is (voorkomt "vastzitten"). */
  _startSilenceWatchdog() {
    this._clearSilenceWatchdog();
    this.silenceTimer = setInterval(() => {
      if (!this.active || this.fatalError) return;
      if (this.lastResultAt && Date.now() - this.lastResultAt > this.options.silenceTimeoutMs) {
        this._log("Stilte-timeout: sessie wordt herstart");
        this._emitError({ code: "silence-timeout", message: "Te lang niets herkend; herstart spraakherkenning." });
        try { this.recognition?.stop(); } catch (ex) { /* onend doet de herstart */ }
      }
    }, 1000);
  }

  _clearSilenceWatchdog() {
    if (this.silenceTimer) {
      clearInterval(this.silenceTimer);
      this.silenceTimer = null;
    }
  }

  _clearTimers() {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this._clearSilenceWatchdog();
  }

  _emitState(state, detail = "") {
    if (this.onState) {
      try { this.onState(state, detail); } catch (ex) { console.error("onState-callback fout:", ex); }
    }
  }

  _emitError({ code, message }) {
    if (this.onError) {
      try { this.onError({ code, message }); } catch (ex) { console.error("onError-callback fout:", ex); }
    }
  }

  _log(...args) {
    if (this.options.debug) console.log("[SpeechService]", ...args);
  }
}
