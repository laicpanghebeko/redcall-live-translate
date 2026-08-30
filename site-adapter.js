(() => {
  if (window.__redcallSiteAdapter) return;
  window.__redcallSiteAdapter = true;
  const NativePC = window.RTCPeerConnection;
  const peerConnections = new Set();
  const originals = new Map();
  let active = false;
  let translatedTrack = null;
  let room = null;
  let silenceTrack = null;
  let muteTimer = null;
  let mutedNow = false;

  function status(value, detail = "") {
    window.postMessage(
      {channel: "redcall-site-adapter", type: "ADAPTER_STATUS", status: value, detail},
      window.location.origin
    );
  }

  function makeSilence() {
    if (silenceTrack) return silenceTrack;
    const context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    gain.gain.value = 0;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    silenceTrack = destination.stream.getAudioTracks()[0];
    return silenceTrack;
  }

  // Puits audio muet : garantit que Chrome tire réellement les trames de la piste
  // distante. Sans consommateur, une piste WebRTC distante peut rester silencieuse.
  // L'élément est muet et à volume nul : l'utilisateur n'entend rien de plus.
  let pumpElement = null;
  function attachPump(track) {
    detachPump();
    try {
      pumpElement = track.attach();
      pumpElement.muted = true;
      pumpElement.volume = 0;
      pumpElement.autoplay = true;
      pumpElement.setAttribute("data-redcall", "pump");
      pumpElement.style.display = "none";
      document.documentElement.appendChild(pumpElement);
      const played = pumpElement.play();
      if (played && played.catch) played.catch(() => {});
    } catch (_) {}
  }
  function detachPump() {
    if (!pumpElement) return;
    try {
      pumpElement.remove();
    } catch (_) {}
    pumpElement = null;
  }

  // Mesure le niveau réel de la piste traduite. Si elle reste à zéro alors que la
  // traduction est censée parler, le problème est en amont (piste non alimentée).
  // Si elle bouge et que le correspondant n'entend rien, le problème est dans Meet.
  let levelTimer = null;
  function monitorLevel(track) {
    clearInterval(levelTimer);
    let context;
    try {
      context = new AudioContext();
      const source = context.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
      const analyser = context.createAnalyser();
      analyser.fftSize = 512;
      source.connect(analyser);
      const buffer = new Float32Array(512);
      let peak = 0;
      levelTimer = setInterval(() => {
        if (!active) {
          clearInterval(levelTimer);
          context.close().catch(() => {});
          return;
        }
        analyser.getFloatTimeDomainData(buffer);
        let localPeak = 0;
        for (let i = 0; i < buffer.length; i += 1) {
          const value = Math.abs(buffer[i]);
          if (value > localPeak) localPeak = value;
        }
        if (localPeak > peak) {
          peak = localPeak;
          status("translated", `Voix traduite active (niveau max ${(peak * 100).toFixed(0)}%)`);
        }
      }, 250);
    } catch (_) {}
  }

  function audioSenders() {
    const result = [];
    for (const pc of peerConnections) {
      for (const sender of pc.getSenders()) {
        if ((sender.track && sender.track.kind === "audio") || originals.has(sender))
          result.push(sender);
      }
    }
    return result;
  }

  // Trou 1 : Meet coupe le micro via enabled=false sur la piste D'ORIGINE, qui
  // n'est plus attachée au sender. Sans ce miroir, le bouton "muet" ne coupe rien.
  function syncMuteState() {
    if (!active || !translatedTrack) return;
    let muted = false;
    for (const track of originals.values()) {
      if (track && (track.enabled === false || track.muted === true)) muted = true;
    }
    if (muted === mutedNow) return;
    mutedNow = muted;
    translatedTrack.enabled = !muted;
    status(
      muted ? "muted" : "translated",
      muted
        ? "Micro coupé dans la réunion : traduction suspendue"
        : "La réunion reçoit uniquement la voix traduite"
    );
  }

  // Trou 2 : au démasquage, certains clients rappellent replaceTrack() avec le micro
  // brut, ce qui remettrait la voix non traduite sur le réseau. On l'intercepte.
  const nativeReplaceTrack = RTCRtpSender.prototype.replaceTrack;
  RTCRtpSender.prototype.replaceTrack = function (track) {
    if (
      active &&
      track &&
      track.kind === "audio" &&
      track !== translatedTrack &&
      track !== silenceTrack
    ) {
      originals.set(this, track);
      return nativeReplaceTrack.call(this, translatedTrack || makeSilence());
    }
    return nativeReplaceTrack.call(this, track);
  };

  async function secureSenders(track) {
    const senders = audioSenders();
    await Promise.all(
      senders.map(async (sender) => {
        if (!originals.has(sender) && sender.track) originals.set(sender, sender.track);
        try {
          await sender.replaceTrack(track);
        } catch (_) {}
      })
    );
    return senders.length;
  }

  function WrappedPC(...args) {
    const pc = new NativePC(...args);
    peerConnections.add(pc);
    pc.addEventListener("connectionstatechange", () => {
      if (["closed", "failed"].includes(pc.connectionState)) peerConnections.delete(pc);
    });
    return pc;
  }
  WrappedPC.prototype = NativePC.prototype;
  Object.setPrototypeOf(WrappedPC, NativePC);
  window.RTCPeerConnection = WrappedPC;
  if (window.webkitRTCPeerConnection === NativePC) window.webkitRTCPeerConnection = WrappedPC;

  const nativeAddTrack = NativePC.prototype.addTrack;
  NativePC.prototype.addTrack = function (track, ...streams) {
    const sender = nativeAddTrack.call(this, track, ...streams);
    peerConnections.add(this);
    if (track.kind === "audio" && active) {
      originals.set(sender, track);
      sender.replaceTrack(translatedTrack || makeSilence()).catch(() => {});
    }
    return sender;
  };
  const nativeAddTransceiver = NativePC.prototype.addTransceiver;
  NativePC.prototype.addTransceiver = function (trackOrKind, init) {
    const transceiver = nativeAddTransceiver.call(this, trackOrKind, init);
    peerConnections.add(this);
    const kind = typeof trackOrKind === "string" ? trackOrKind : trackOrKind?.kind;
    if (kind === "audio" && active) {
      if (transceiver.sender.track) originals.set(transceiver.sender, transceiver.sender.track);
      transceiver.sender.replaceTrack(translatedTrack || makeSilence()).catch(() => {});
    }
    return transceiver;
  };

  async function start(config) {
    if (!window.LivekitClient) throw new Error("SDK LiveKit indisponible");
    active = true;
    translatedTrack = null;
    const count = await secureSenders(makeSilence());
    status("securing", count ? "Micro brut coupé" : "En attente du microphone de la réunion");
    room = new LivekitClient.Room({adaptiveStream: false, dynacast: false});
    room.on(LivekitClient.RoomEvent.TrackSubscribed, async (track, publication) => {
      if (publication.trackName !== config.tracks.to_remote || track.kind !== "audio") return;
      attachPump(track);
      translatedTrack = track.mediaStreamTrack;
      await secureSenders(translatedTrack);
      status("translated", "La réunion reçoit uniquement la voix traduite");
      monitorLevel(track);
    });
    room.on(LivekitClient.RoomEvent.TrackUnsubscribed, async (_track, publication) => {
      if (publication.trackName === config.tracks.to_remote && active) {
        translatedTrack = null;
        await secureSenders(makeSilence());
        status("fail-closed", "Traduction interrompue : microphone distant coupé");
      }
    });
    room.on(LivekitClient.RoomEvent.Disconnected, async () => {
      if (active) {
        translatedTrack = null;
        await secureSenders(makeSilence());
        status("fail-closed", "Connexion RedCall perdue : microphone distant coupé");
      }
    });
    await room.connect(config.livekit_url, config.adapter.token, {autoSubscribe: true});
    mutedNow = false;
    muteTimer = setInterval(syncMuteState, 200);
  }

  async function stop() {
    active = false;
    detachPump();
    clearInterval(levelTimer);
    levelTimer = null;
    clearInterval(muteTimer);
    muteTimer = null;
    mutedNow = false;
    translatedTrack = null;
    if (room) await room.disconnect();
    room = null;
    await Promise.all(
      [...originals].map(async ([sender, track]) => {
        try {
          await sender.replaceTrack(track.readyState === "live" ? track : null);
        } catch (_) {}
      })
    );
    originals.clear();
    status("stopped", "Microphone d’origine restauré explicitement");
  }

  window.addEventListener("message", (event) => {
    if (
      event.source !== window ||
      event.origin !== window.location.origin ||
      event.data?.channel !== "redcall-extension"
    )
      return;
    if (event.data.type === "REDCALL_ADAPTER_START")
      start(event.data.config).catch(async (error) => {
        await secureSenders(makeSilence());
        status("error", error.message);
      });
    if (event.data.type === "REDCALL_ADAPTER_STOP") stop().catch(() => {});
  });
})();
