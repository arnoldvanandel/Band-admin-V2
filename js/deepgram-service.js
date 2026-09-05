// ============================================================================
//  DeepgramService
//  Live spraakherkenning via de Deepgram Streaming API (browser).
//
//  Werking:
//   1. Haalt een tijdelijk Deepgram-token op van de eigen Cloud Function
//      (`deepgramToken`). De echte API-key blijft dus op de server.
//   2. Vraagt microfoontoegang via getUserMedia.
//   3. Stuurt de microfoon-audio in kleine chunks naar Deepgram via een
//      WebSocket (subprotocol-auth met het tijdelijke token).
//   4. Geeft herkende tekst (interim + finaal) door via dezelfde callbacks
//      als de oude SpeechService, zodat de rest van de app niet verandert.
// ============================================================================

const DEFAULT_OPTIONS = {
  tokenUrl: "",              // URL van de deepgramToken Cloud Function
  model: "nova-3",           // Deepgram-model
  endpointingMs: 300,        // korte pauze voordat een resultaat "finaal" wordt
  interimResults: true,      // ook tussentijdse resultaten doorgeven
  smartFormat: true,         // hoofdletters/leestekens (wordt later genormaliseerd)
  language: "multi",         // "multi" = Deepgram detecteert zelf de taal (nl/en/...)
  chunkMs: 250,              // audio-chunkgrootte voor MediaRecorder
  keepAliveMs: 10000,        // Deepgram-keepalive-interval
  restartDelayMs: 250,       // wachttijd voordat een verbinding automatisch herstart
  debug: false,
};

const ERROR_MESSAGES = {
  "not-allowed": "Microfoontoegang geweigerd. Geef toestemming in de browser.",
  "audio-capture": "Geen microfoon gevonden of microfoon is bezet.",
  "token-failed": "Kon geen Deepgram-token ophalen van de server.",
  "socket-error": "Verbinding met Deepgram mislukt.",
};

export class DeepgramService {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.active = false;          // true tussen start() en stop()
    this.restarting = false;      // true tijdens een automatische herstart
    this.socket = null;
    this.mediaStream = null;
    this.mediaRecorder = null;
    this.keepAliveTimer = null;
    this.restartTimer = null;
    this.lastToken = "";

    this.onResult = null;   // ({ transcript, isFinal, confidence }) => {}
    this.onState = null;    // (state, detail) => {}
    this.onError = null;    // ({ code, message }) => {}
  }

  /** Ondersteunt deze browser alles wat DeepgramService nodig heeft? */
  static isSupported() {
    return !!(
      navigator.mediaDevices?.getUserMedia &&
      window.WebSocket &&
      window.MediaRecorder
    );
  }

  setCallbacks({ onResult, onState, onError }) {
    this.onResult = onResult || null;
    this.onState = onState || null;
    this.onError = onError || null;
    return this;
  }

  /** Start herkenning: token ophalen, microfoon openen en streamen. */
  async start() {
    if (!DeepgramService.isSupported()) {
      this._emitState("error", "Deze browser ondersteunt geen live spraakherkenning.");
      this._emitError({ code: "unsupported", message: "Deze browser ondersteunt geen live spraakherkenning." });
      return false;
    }
    if (this.active) return true;
    if (!this.options.tokenUrl) {
      this._emitState("error", "Geen Deepgram-token URL geconfigureerd.");
      this._emitError({ code: "config", message: "Geen Deepgram-token URL geconfigureerd." });
      return false;
    }

    this.active = true;
    this.restarting = false;
    this._emitState("starting");
    this._log("start()");

    try {
      const token = await this._fetchToken();
      if (!this.active) return false; // inmiddels gestopt
      this.lastToken = token;
      await this._openStream(token);
      return true;
    } catch (ex) {
      this.active = false;
      let code = ex.code || "start-failed";
      let message = ERROR_MESSAGES[code] || ex.message || String(ex);
      if (ex.name === "NotAllowedError" || ex.name === "PermissionDeniedError") {
        code = "not-allowed";
        message = ERROR_MESSAGES["not-allowed"];
      } else if (ex.name === "NotFoundError" || ex.name === "DevicesNotFoundError") {
        code = "audio-capture";
        message = ERROR_MESSAGES["audio-capture"];
      }
      this._emitState("error", message);
      this._emitError({ code, message });
      this._cleanup();
      return false;
    }
  }

  /** Stop definitief (geen automatische herstart). */
  stop() {
    if (!this.active && !this.restarting) return;
    this.active = false;
    this.restarting = false;
    this._clearTimers();
    this._cleanup();
    this._emitState("inactive");
    this._log("stop()");
  }

  /** Hard stoppen (bij view-wissels). */
  abort() {
    this.active = false;
    this.restarting = false;
    this._clearTimers();
    this._cleanup();
    this._emitState("inactive");
  }

  // ---------------------------------------------------------------------------

  async _fetchToken() {
    const res = await fetch(this.options.tokenUrl, { method: "GET" });
    if (!res.ok) {
      const err = new Error(`Deepgram-token ophalen mislukt (${res.status}).`);
      err.code = "token-failed";
      throw err;
    }
    const token = (await res.text()).trim();
    if (!token) {
      const err = new Error("Deepgram gaf een leeg token terug.");
      err.code = "token-failed";
      throw err;
    }
    return token;
  }

  async _openStream(token) {
    this._log("microfoon openen…");
    this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const params = new URLSearchParams({
      model: this.options.model,
      interim_results: String(!!this.options.interimResults),
      smart_format: String(!!this.options.smartFormat),
      endpointing: String(this.options.endpointingMs),
      language: this.options.language,
    });
    const url = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    this._log("Deepgram WebSocket openen:", url);
    this.socket = new WebSocket(url, ["bearer", token]);

    this.socket.onopen = () => {
      this._log("socket open, MediaRecorder starten");
      this._emitState("listening");
      this._startMediaRecorder();
      this._startKeepAlive();
    };

    this.socket.onmessage = (event) => this._handleMessage(event);

    this.socket.onerror = () => {
      this._log("socket error");
      this._emitError({ code: "socket-error", message: ERROR_MESSAGES["socket-error"] });
    };

    this.socket.onclose = (event) => {
      this._log("socket close", event.code, event.reason);
      this._clearTimers();
      this._stopMediaRecorder();

      if (this.active && !this.restarting) {
        // Verbinding verloren of door Deepgram gesloten: herstart zolang actief.
        this.restarting = true;
        this._emitState("restarting");
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          if (!this.active) return;
          this._openStream(this.lastToken).catch((ex) => {
            this.restarting = false;
            const message = ex.message || String(ex);
            this._emitState("error", message);
            this._emitError({ code: "restart-failed", message });
          });
        }, this.options.restartDelayMs);
      } else {
        this.restarting = false;
        // stop()/abort() hebben de "inactive"-state al gemeld.
      }
    };
  }

  _startMediaRecorder() {
    try {
      this.mediaRecorder = new MediaRecorder(this.mediaStream);
      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0 && this.socket?.readyState === WebSocket.OPEN) {
          event.data.arrayBuffer().then((buffer) => this.socket.send(buffer));
        }
      };
      this.mediaRecorder.start(this.options.chunkMs);
    } catch (ex) {
      this._emitError({ code: "audio-capture", message: ERROR_MESSAGES["audio-capture"] });
    }
  }

  _stopMediaRecorder() {
    if (this.mediaRecorder && this.mediaRecorder.state !== "inactive") {
      try { this.mediaRecorder.stop(); } catch (ex) { /* al gestopt */ }
    }
    this.mediaRecorder = null;
  }

  _handleMessage(event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (ex) {
      return;
    }
    const alternative = data.channel?.alternatives?.[0];
    const transcript = (alternative?.transcript || "").trim();
    if (!transcript) return;

    const isFinal = !!data.is_final;
    const confidence = typeof alternative.confidence === "number" ? alternative.confidence : 0;
    const language = data.channel?.detected_language || "";

    if (isFinal) this._log("finaal:", transcript, confidence.toFixed(2), language ? `(taal: ${language})` : "");
    else this._log("interim:", transcript);

    if (this.onResult) {
      try {
        this.onResult({ transcript, isFinal, confidence, language });
      } catch (ex) {
        console.error("onResult-callback fout:", ex);
      }
    }
  }

  _startKeepAlive() {
    this.keepAliveTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        try { this.socket.send(JSON.stringify({ type: "KeepAlive" })); } catch (ex) { /* negeren */ }
      }
    }, this.options.keepAliveMs);
  }

  _clearTimers() {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  _cleanup() {
    this._clearTimers();
    this._stopMediaRecorder();
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());
      this.mediaStream = null;
    }
    if (this.socket) {
      try { this.socket.close(); } catch (ex) { /* al dicht */ }
      this.socket = null;
    }
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
    if (this.options.debug) console.log("[DeepgramService]", ...args);
  }
}
