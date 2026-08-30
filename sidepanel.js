const DEFAULT_API = "https://redcall.tech/redcall-api";
// Doit rester aligné avec content_scripts.matches et host_permissions du manifeste.
const BIDIRECTIONAL_ORIGINS = ["https://meet.google.com", "https://web.telegram.org"];
// Zoom sert les réunions depuis des sous-domaines régionaux (us02web.zoom.us…).
const BIDIRECTIONAL_SUFFIXES = ["zoom.us"];
function bidirectionalAllowed(origin) {
  if (!origin) return false;
  if (BIDIRECTIONAL_ORIGINS.includes(origin)) return true;
  let host;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch (_) {
    return false;
  }
  return BIDIRECTIONAL_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
}
const LANGUAGES = {
  fr: "Français",
  en: "Anglais",
  es: "Espagnol",
  de: "Allemand",
  pt: "Portugais",
  it: "Italien",
  ar: "Arabe",
  zh: "Chinois",
  ja: "Japonais",
  ko: "Coréen",
  hi: "Hindi",
  tr: "Turc"
};
let state = {
  mode: "listen",
  config: null,
  capabilities: null,
  heartbeat: null,
  statusPoll: null,
  tabId: null
};
const $ = (id) => document.getElementById(id);

// Un document offscreen ne peut pas afficher d'invite d'autorisation. On tente donc
// depuis le panneau, et à défaut on ouvre une vraie page qui, elle, le peut.
// Une fois accordée, l'autorisation vaut pour toute l'extension.
async function ensureMicrophone() {
  try {
    const status = await navigator.permissions.query({name: "microphone"});
    if (status.state === "granted") return true;
  } catch (_) {}
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio: true});
    for (const track of stream.getTracks()) track.stop();
    return true;
  } catch (_) {
    await chrome.tabs.create({url: chrome.runtime.getURL("mic-permission.html")});
    throw new Error(
      "Autorisez le microphone dans l’onglet qui vient de s’ouvrir, puis relancez la traduction."
    );
  }
}

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}
function randomString(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return b64url(value);
}
async function sha256(value) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}
async function settings() {
  const value = await chrome.storage.local.get(["apiBase", "auth", "deviceId"]);
  if (!value.deviceId) {
    value.deviceId = crypto.randomUUID();
    await chrome.storage.local.set({deviceId: value.deviceId});
  }
  return {
    apiBase: (value.apiBase || DEFAULT_API).replace(/\/$/, ""),
    auth: value.auth,
    deviceId: value.deviceId
  };
}

async function authenticate() {
  const config = await settings();
  const verifier = randomString(48);
  const challenge = b64url(await sha256(verifier));
  const stateToken = randomString(24);
  const redirect = chrome.identity.getRedirectURL("redcall");
  const url = new URL(config.apiBase + "/extension/authorize");
  url.search = new URLSearchParams({
    redirect_uri: redirect,
    code_challenge: challenge,
    state: stateToken,
    device_name: `Chrome ${navigator.platform}`
  });
  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: url.toString(),
    interactive: true
  });
  if (!responseUrl) throw new Error("Connexion annulée");
  const callback = new URL(responseUrl);
  if (callback.searchParams.get("state") !== stateToken)
    throw new Error("État de connexion invalide");
  const response = await fetch(config.apiBase + "/extension/auth/token", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({
      code: callback.searchParams.get("code"),
      code_verifier: verifier,
      redirect_uri: redirect,
      device_id: config.deviceId,
      device_name: `Chrome ${navigator.platform}`
    })
  });
  if (!response.ok) throw new Error((await response.json()).detail || "Connexion refusée");
  const auth = await response.json();
  auth.saved_at = Date.now();
  await chrome.storage.local.set({auth});
  return auth;
}

async function refresh() {
  const config = await settings();
  if (!config.auth?.refresh_token) throw new Error("Connexion requise");
  const response = await fetch(config.apiBase + "/extension/auth/refresh", {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify({refresh_token: config.auth.refresh_token, device_id: config.deviceId})
  });
  if (!response.ok) {
    await chrome.storage.local.remove("auth");
    throw new Error("Session RedCall expirée");
  }
  const next = await response.json();
  const auth = {...config.auth, ...next, saved_at: Date.now()};
  await chrome.storage.local.set({auth});
  return auth;
}
async function api(path, options = {}) {
  let config = await settings();
  let auth = config.auth;
  if (!auth) throw new Error("Connexion requise");
  if (Date.now() - (auth.saved_at || 0) > (auth.expires_in - 60) * 1000) auth = await refresh();
  let response = await fetch(config.apiBase + path, {
    ...options,
    headers: {...(options.headers || {}), Authorization: `Bearer ${auth.access_token}`}
  });
  if (response.status === 401) {
    auth = await refresh();
    response = await fetch(config.apiBase + path, {
      ...options,
      headers: {...(options.headers || {}), Authorization: `Bearer ${auth.access_token}`}
    });
  }
  if (!response.ok) {
    let detail = "Erreur RedCall";
    try {
      detail = (await response.json()).detail || detail;
    } catch (_) {}
    throw new Error(detail);
  }
  return response.status === 204 ? null : response.json();
}

function setStatus(kind, title, detail) {
  $("statusDot").className = `dot ${kind}`;
  $("statusTitle").textContent = title;
  $("statusDetail").textContent = detail;
}
function showError(message) {
  $("errorBox").textContent = message;
  $("errorBox").hidden = false;
  setStatus("error", "Action requise", message);
}
function selectValue(select) {
  const option = select.selectedOptions[0];
  return option ? {id: option.value, kind: option.dataset.kind} : null;
}
function voiceFields(prefix, voice) {
  return voice.kind === "clone"
    ? {[`${prefix}_voice_clone_id`]: voice.id, [`${prefix}_voice_template_id`]: null}
    : {[`${prefix}_voice_clone_id`]: null, [`${prefix}_voice_template_id`]: voice.id};
}

async function loadApp() {
  const config = await settings();
  $("apiBase").value = config.apiBase;
  const connected = Boolean(config.auth);
  $("loginView").hidden = connected;
  $("appView").hidden = !connected;
  if (!connected) return;
  try {
    const [me, voices, capabilities] = await Promise.all([
      api("/extension/me"),
      api("/extension/voices"),
      api("/extension/capabilities")
    ]);
    state.capabilities = capabilities;
    const adaptive = Boolean(capabilities.adaptive_voice);
    $("accountBadge").textContent = me.username || me.email;
    $("accountBadge").className = "badge";
    $("providerBadge").textContent =
      capabilities.translation_provider_label || "Moteur de traduction RedCall";
    $("inboundVoiceGroup").hidden = adaptive;
    $("adaptiveVoiceNote").hidden = !adaptive;
    $("outboundGroup").hidden = adaptive || state.mode !== "bidirectional";
    for (const id of ["inboundVoice", "outboundVoice"]) {
      $(id).innerHTML = "";
      for (const voice of voices.voices) {
        const option = document.createElement("option");
        option.value = voice.id;
        option.dataset.kind = voice.kind;
        option.textContent = `${voice.kind === "clone" ? "Ma voix" : "Pro"} · ${voice.name}${voice.language ? ` (${voice.language})` : ""}`;
        $(id).appendChild(option);
      }
    }
    if (capabilities.voice_selection_required && !voices.voices.length)
      showError("Ajoutez d’abord une voix dans RedCall > Mes voix.");
    if (!capabilities.configured)
      showError("Le fournisseur de traduction choisi par l’administrateur n’est pas configuré.");
  } catch (error) {
    showError(error.message);
  }
}

async function captureContext() {
  const response = await chrome.runtime.sendMessage({
    target: "service-worker",
    type: "GET_CAPTURE_CONTEXT"
  });
  if (!response?.ok) throw new Error(response?.error || "Impossible d’identifier l’onglet courant");
  const context = response.context || {};
  if (context.tabId) {
    try {
      const info = await chrome.tabs.sendMessage(context.tabId, {type: "GET_REDCALL_TAB_INFO"});
      if (info?.ok) Object.assign(context, {url: info.origin, title: info.title});
    } catch (_) {}
  }
  return context;
}

async function chooseTabAudio() {
  // 1) tabCapture : aucun sélecteur, et l'onglet est réellement mis en sourdine.
  const viaTabCapture = await chrome.runtime
    .sendMessage({target: "service-worker", type: "CHOOSE_TAB_AUDIO"})
    .catch(() => null);
  if (viaTabCapture?.ok) return {streamId: viaTabCapture.streamId, sourceType: "tab"};
  // 2) repli : sélecteur natif. L'onglet continue de jouer son propre son.
  return new Promise((resolve, reject) => {
    chrome.desktopCapture.chooseDesktopMedia(["tab", "audio"], (streamId, options = {}) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (!streamId) {
        reject(new Error("Sélection de l’onglet annulée"));
        return;
      }
      if (!options.canRequestAudioTrack) {
        reject(
          new Error(
            "Aucune piste audio autorisée. Sélectionnez un onglet Chrome et cochez « Partager l’audio de l’onglet »."
          )
        );
        return;
      }
      resolve({streamId, sourceType: "desktop"});
    });
  });
}

function validWebOrigin(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
  } catch (_) {
    return null;
  }
}

async function start() {
  $("errorBox").hidden = true;
  const tab = await captureContext();
  let origin = validWebOrigin(tab.url);
  if (state.mode === "bidirectional" && !origin)
    throw new Error(
      "Ouvrez Google Meet, Zoom Web, Telegram Web ou WhatsApp Web, puis cliquez de nouveau sur l’icône RedCall."
    );
  if (state.mode === "bidirectional" && !bidirectionalAllowed(origin))
    throw new Error(
      "Le mode Deux sens est disponible sur Google Meet, Zoom Web et Telegram Web. Sur WhatsApp, seul le mode Écouter traduit est disponible."
    );
  if (state.mode === "bidirectional") await ensureMicrophone();
  origin = origin || "https://selected-tab.invalid";
  if ($("sourceLanguage").value === $("userLanguage").value)
    throw new Error("Choisissez deux langues différentes");
  const adaptive = Boolean(state.capabilities?.adaptive_voice);
  const payload = {
    mode: state.mode,
    site_origin: origin,
    tab_title: tab.title || "",
    source_language: $("sourceLanguage").value,
    user_language: $("userLanguage").value
  };
  if (!adaptive) {
    const incoming = selectValue($("inboundVoice"));
    if (!incoming) throw new Error("Choisissez une voix d’écoute");
    Object.assign(payload, voiceFields("inbound", incoming));
    if (state.mode === "bidirectional") {
      const outgoing = selectValue($("outboundVoice"));
      if (!outgoing) throw new Error("Choisissez une voix sortante");
      Object.assign(payload, voiceFields("outbound", outgoing));
    }
  }
  try {
    const offscreen = await chrome.runtime.sendMessage({
      target: "service-worker",
      type: "PREPARE_OFFSCREEN"
    });
    if (!offscreen?.ok)
      throw new Error(offscreen?.error || "Le moteur audio Chrome n’a pas pu démarrer");
    setStatus("working", "Préparation…", "Vérification de l’onglet à traduire.");
    const capture = await chooseTabAudio();
    setStatus(
      "working",
      "Capture audio…",
      "La piste sélectionnée est sécurisée avant la connexion."
    );
    const prepared = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "PREPARE_AUDIO",
      streamId: capture.streamId,
      sourceType: capture.sourceType,
      originalVolume: Number($("originalVolume").value)
    });
    if (!prepared?.ok) throw new Error(prepared?.error || "La capture audio a échoué");
    if (capture.sourceType === "desktop") {
      $("errorBox").textContent =
        "Mode de secours : le son original de l’onglet ne peut pas être coupé. Utilisez un casque.";
      $("errorBox").hidden = false;
    }
    setStatus("working", "Connexion…", "Création de la session RedCall.");
    state.config = await api("/extension/translations", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(payload)
    });
    $("providerBadge").textContent =
      state.config.translation_provider === "openai_realtime"
        ? "OpenAI Realtime · voix adaptative"
        : "Moteur RedCall · voix personnalisées";
    const audio = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "CONNECT_AUDIO",
      config: state.config
    });
    if (!audio?.ok) throw new Error(audio?.error || "La connexion audio a échoué");
    if (state.mode === "bidirectional") {
      if (!tab.tabId) throw new Error("L’onglet de la réunion n’est plus disponible");
      const reply = await chrome.tabs.sendMessage(tab.tabId, {
        type: "REDCALL_ADAPTER_START",
        config: state.config
      });
      if (!reply?.ok) throw new Error("L’adaptateur du site n’a pas répondu");
    }
  } catch (error) {
    await chrome.runtime.sendMessage({target: "offscreen", type: "STOP_AUDIO"}).catch(() => {});
    if (state.config)
      await api(`/extension/translations/${state.config.id}`, {method: "DELETE"}).catch(() => {});
    state.config = null;
    throw error;
  }
  state.tabId = tab.tabId || null;
  $("startButton").hidden = true;
  $("stopButton").hidden = false;
  setStatus(
    "working",
    "Traduction en préparation",
    "Le premier segment peut demander quelques secondes."
  );
  state.heartbeat = setInterval(
    () =>
      api(`/extension/translations/${state.config.id}/heartbeat`, {method: "POST"}).catch(() =>
        stop(false)
      ),
    15000
  );
  state.statusPoll = setInterval(async () => {
    try {
      const value = await api(`/extension/translations/${state.config.id}`);
      if (value.bridge_status === "ready")
        setStatus(
          "active",
          "Traduction active",
          state.mode === "bidirectional"
            ? "Micro distant sécurisé, audio traduit en direct."
            : "Écoute traduite de l’onglet actif."
        );
      if (value.status === "failed")
        throw new Error(value.error || "Le moteur de traduction s’est arrêté");
    } catch (error) {
      showError(error.message);
    }
  }, 2000);
}

async function stop(callApi = true) {
  clearInterval(state.heartbeat);
  clearInterval(state.statusPoll);
  state.heartbeat = state.statusPoll = null;
  if (state.mode === "bidirectional" && state.tabId)
    await chrome.tabs.sendMessage(state.tabId, {type: "REDCALL_ADAPTER_STOP"}).catch(() => {});
  await chrome.runtime.sendMessage({target: "offscreen", type: "STOP_AUDIO"}).catch(() => {});
  if (callApi && state.config)
    await api(`/extension/translations/${state.config.id}`, {method: "DELETE"}).catch(() => {});
  state.config = null;
  state.tabId = null;
  $("startButton").hidden = false;
  $("stopButton").hidden = true;
  setStatus("idle", "Prêt à traduire", "Sélectionnez le mode et les langues.");
}

for (const [code, label] of Object.entries(LANGUAGES)) {
  for (const id of ["sourceLanguage", "userLanguage"]) {
    const option = document.createElement("option");
    option.value = code;
    option.textContent = label;
    $(id).appendChild(option);
  }
}
$("sourceLanguage").value = "en";
$("userLanguage").value = "fr";
document.querySelectorAll(".mode").forEach((button) =>
  button.addEventListener("click", () => {
    document.querySelectorAll(".mode").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.mode = button.dataset.mode;
    $("outboundGroup").hidden =
      Boolean(state.capabilities?.adaptive_voice) || state.mode !== "bidirectional";
    $("safetyCard").hidden = state.mode !== "bidirectional";
  })
);
$("loginButton").addEventListener("click", () =>
  authenticate()
    .then(loadApp)
    .catch((error) => showError(error.message))
);
$("logoutButton").addEventListener("click", async () => {
  await stop();
  await api("/extension/auth/logout", {method: "POST"}).catch(() => {});
  await chrome.storage.local.remove("auth");
  loadApp();
});
$("startButton").addEventListener("click", async () => {
  if ($("startButton").disabled) return;
  $("startButton").disabled = true;
  try {
    await start();
  } catch (error) {
    showError(error.message);
  } finally {
    $("startButton").disabled = false;
  }
});
$("stopButton").addEventListener("click", () => stop().catch((error) => showError(error.message)));
$("originalVolume").addEventListener("input", () => {
  $("volumeOutput").textContent = `${$("originalVolume").value} %`;
  chrome.runtime
    .sendMessage({
      target: "offscreen",
      type: "SET_ORIGINAL_VOLUME",
      value: Number($("originalVolume").value)
    })
    .catch(() => {});
});
$("advancedButton").addEventListener("click", () => {
  $("advanced").hidden = !$("advanced").hidden;
});
$("saveApi").addEventListener("click", async () => {
  await chrome.storage.local.set({apiBase: $("apiBase").value.replace(/\/$/, "")});
  location.reload();
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.target === "sidepanel" && message.type === "ADAPTER_STATUS") {
    if (message.status === "translated")
      setStatus("active", "Traduction bidirectionnelle active", message.detail);
    if (["error", "fail-closed"].includes(message.status)) showError(message.detail);
  }
});
window.addEventListener("unload", () => {
  if (state.config) stop().catch(() => {});
});
loadApp();
