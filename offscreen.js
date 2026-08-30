let runtime = null;
let prepared = null;

const DUCK_FLOOR = 0.18;
const DUCK_ATTACK = 0.05;
const DUCK_RELEASE = 0.4;
const SPEECH_RMS = 0.012;

// Conditionne l'audio AVANT publication vers le worker. Un niveau régulier et sans
// infrabasses améliore nettement la transcription des voix faibles ou lointaines,
// d'où viennent la plupart des erreurs de traduction.
function conditionForSpeech(audioContext, sourceNode) {
  const highpass = audioContext.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 85;

  const presence = audioContext.createBiquadFilter();
  presence.type = "peaking";
  presence.frequency.value = 2600;
  presence.Q.value = 0.9;
  presence.gain.value = 3;

  const compressor = audioContext.createDynamicsCompressor();
  compressor.threshold.value = -26;
  compressor.knee.value = 12;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.006;
  compressor.release.value = 0.22;

  sourceNode.connect(highpass).connect(presence).connect(compressor);
  return compressor;
}

function publishableTrack(audioContext, rawTrack) {
  const source = audioContext.createMediaStreamSource(new MediaStream([rawTrack]));
  const destination = audioContext.createMediaStreamDestination();
  conditionForSpeech(audioContext, source).connect(destination);
  return destination.stream.getAudioTracks()[0];
}

function playTranslated(audioContext, track, elements) {
  const pump = track.attach();
  pump.autoplay = true;
  pump.muted = true;
  pump.volume = 0;
  document.body.appendChild(pump);
  pump.play().catch(() => {});
  elements.push(pump);

  const source = audioContext.createMediaStreamSource(new MediaStream([track.mediaStreamTrack]));
  const limiter = audioContext.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;

  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.2;

  source.connect(limiter);
  limiter.connect(audioContext.destination);
  limiter.connect(analyser);
  return analyser;
}

function applyOriginalGain(state, target, timeConstant) {
  if (!state?.reinject) return;
  const now = state.audioContext.currentTime;
  state.originalGain.gain.cancelScheduledValues(now);
  state.originalGain.gain.setTargetAtTime(target, now, timeConstant);
}

// Atténuation automatique : le son original baisse pendant que la traduction parle.
// Sans cela, un volume original non nul rend les deux voix inintelligibles.
function startDucking(state) {
  const buffer = new Float32Array(512);
  state.duckTimer = setInterval(() => {
    if (!state.analyser || !state.reinject) return;
    state.analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let index = 0; index < buffer.length; index += 1) sum += buffer[index] * buffer[index];
    const speaking = Math.sqrt(sum / buffer.length) > SPEECH_RMS;
    if (speaking === state.ducked) return;
    state.ducked = speaking;
    applyOriginalGain(
      state,
      state.originalVolume * (speaking ? DUCK_FLOOR : 1),
      speaking ? DUCK_ATTACK : DUCK_RELEASE
    );
  }, 50);
}

async function stopRuntime() {
  const current = runtime || prepared;
  runtime = null;
  prepared = null;
  if (!current) return;
  clearInterval(current.duckTimer);
  for (const track of current.mediaTracks) track.stop();
  for (const element of current.elements) element.remove();
  if (current.room)
    try {
      await current.room.disconnect();
    } catch (_) {}
  try {
    await current.audioContext.close();
  } catch (_) {}
}

async function prepareRuntime(message) {
  await stopRuntime();
  const mediaSource = message.sourceType === "desktop" ? "desktop" : "tab";
  const tabStream = await navigator.mediaDevices.getUserMedia({
    audio: {mandatory: {chromeMediaSource: mediaSource, chromeMediaSourceId: message.streamId}},
    video: false
  });
  if (!tabStream.getAudioTracks().length) {
    throw new Error("L’onglet sélectionné ne fournit aucune piste audio");
  }
  const audioContext = new AudioContext({latencyHint: "interactive"});
  await audioContext.resume();

  const rawTabTrack = tabStream.getAudioTracks()[0];
  const tabSource = audioContext.createMediaStreamSource(new MediaStream([rawTabTrack]));
  const originalGain = audioContext.createGain();
  // tabCapture coupe le son de l'onglet : il faut le réinjecter ici.
  // desktopCapture ne le coupe PAS : le réinjecter doublerait le son.
  const reinject = mediaSource === "tab";
  const originalVolume = Math.max(0, Math.min(1, Number(message.originalVolume || 0) / 100));
  originalGain.gain.value = reinject ? originalVolume : 0;
  if (reinject) tabSource.connect(originalGain).connect(audioContext.destination);

  prepared = {
    tabStream,
    rawTabTrack,
    mediaTracks: [rawTabTrack],
    elements: [],
    audioContext,
    originalGain,
    room: null,
    reinject,
    originalVolume,
    analyser: null,
    ducked: false,
    duckTimer: null
  };
  return {ok: true, sourceType: mediaSource};
}

async function connectRuntime(message) {
  if (!prepared) throw new Error("La piste audio sélectionnée n’est plus disponible");
  const config = message.config;
  const current = prepared;
  const audioContext = current.audioContext;
  const room = new LivekitClient.Room({adaptiveStream: false, dynacast: false});
  current.room = room;
  runtime = current;
  prepared = null;

  room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication) => {
    if (publication.trackName !== config.tracks.to_user || track.kind !== "audio") return;
    current.analyser = playTranslated(audioContext, track, current.elements);
    startDucking(current);
  });

  await room.connect(config.livekit_url, config.token, {autoSubscribe: true});

  const tabTrackForPublish = publishableTrack(audioContext, current.rawTabTrack);
  current.mediaTracks.push(tabTrackForPublish);
  await room.localParticipant.publishTrack(tabTrackForPublish, {
    name: config.tracks.tab,
    source: LivekitClient.Track.Source.Microphone,
    dtx: false,
    red: true,
    audioPreset: {maxBitrate: 48_000}
  });

  if (config.mode === "bidirectional") {
    let microphone;
    try {
      microphone = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
          sampleRate: 48_000
        },
        video: false
      });
    } catch (error) {
      // Un document offscreen ne peut pas afficher de demande d'autorisation.
      // Sans la permission audioCapture, Chrome répond "Permission dismissed".
      const name = error?.name || "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        throw new Error(
          "Micro refusé par Chrome. Ouvrez chrome://extensions, cliquez sur " +
            "Détails pour RedCall, et autorisez le microphone. Puis rechargez l’extension."
        );
      }
      if (name === "NotFoundError") {
        throw new Error("Aucun microphone détecté sur cet ordinateur.");
      }
      throw error;
    }
    const rawMicTrack = microphone.getAudioTracks()[0];
    current.mediaTracks.push(rawMicTrack);
    const micTrackForPublish = publishableTrack(audioContext, rawMicTrack);
    current.mediaTracks.push(micTrackForPublish);
    await room.localParticipant.publishTrack(micTrackForPublish, {
      name: config.tracks.microphone,
      source: LivekitClient.Track.Source.Microphone,
      dtx: false,
      red: true,
      audioPreset: {maxBitrate: 48_000}
    });
  }
  return {ok: true};
}

function failAndStop(error, sendResponse) {
  stopRuntime().finally(() => sendResponse({ok: false, error: error.message}));
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== "offscreen-document") return false;
  if (message.type === "PING") {
    sendResponse({ok: true, livekit: typeof LivekitClient !== "undefined"});
    return false;
  }
  if (message.type === "PREPARE_AUDIO") {
    prepareRuntime(message)
      .then(sendResponse)
      .catch((error) => failAndStop(error, sendResponse));
    return true;
  }
  if (message.type === "CONNECT_AUDIO") {
    connectRuntime(message)
      .then(sendResponse)
      .catch((error) => failAndStop(error, sendResponse));
    return true;
  }
  if (message.type === "STOP_AUDIO") {
    stopRuntime().then(() => sendResponse({ok: true}));
    return true;
  }
  if (message.type === "SET_ORIGINAL_VOLUME") {
    const state = runtime || prepared;
    if (state) {
      state.originalVolume = Math.max(0, Math.min(1, Number(message.value || 0) / 100));
      applyOriginalGain(state, state.originalVolume * (state.ducked ? DUCK_FLOOR : 1), 0.05);
    }
    sendResponse({ok: true});
  }
  return false;
});
