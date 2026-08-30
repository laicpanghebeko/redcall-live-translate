const OFFSCREEN_URL = "offscreen.html";
const CAPTURE_TARGET_KEY = "captureTarget";

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: false}).catch(() => {});
});

chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: false}).catch(() => {});

chrome.action.onClicked.addListener((tab) => {
  if (tab?.windowId) chrome.sidePanel.open({windowId: tab.windowId}).catch(() => {});
  if (tab?.id) {
    chrome.storage.session
      .set({
        [CAPTURE_TARGET_KEY]: {
          tabId: tab.id,
          windowId: tab.windowId,
          url: tab.url || "",
          title: tab.title || "",
          selectedAt: Date.now()
        }
      })
      .catch(() => {});
  }
});

// Chemin principal : pas de sélecteur, l'onglet est celui sur lequel l'icône a été
// cliquée. tabCapture coupe aussi le son de l'onglet, ce qui rend le curseur
// "son original" réellement fonctionnel (desktopCapture, lui, ne coupe rien).
function getMediaStreamId(targetTabId) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabCapture.getMediaStreamId({targetTabId}, (streamId) => {
        const error = chrome.runtime.lastError;
        if (error || !streamId) {
          reject(new Error(error?.message || "Identifiant de flux indisponible"));
          return;
        }
        resolve(streamId);
      });
    } catch (error) {
      reject(error);
    }
  });
}

async function captureTabAudio() {
  const context = await captureContext();
  if (!context.tabId) throw new Error("Aucun onglet à capturer");
  const streamId = await getMediaStreamId(context.tabId);
  return {ok: true, streamId, sourceType: "tab", context};
}

async function waitForOffscreen(attempts = 40) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const pong = await chrome.runtime.sendMessage({target: "offscreen-document", type: "PING"});
      if (pong?.ok) return true;
    } catch (_) {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Le module audio de l’extension n’a pas démarré");
}

async function captureContext() {
  const stored = await chrome.storage.session.get(CAPTURE_TARGET_KEY);
  const saved = stored[CAPTURE_TARGET_KEY] || {};
  if (saved?.tabId) {
    const remembered = await chrome.tabs.get(saved.tabId).catch(() => null);
    if (remembered) {
      return {
        tabId: remembered.id,
        windowId: remembered.windowId,
        url: remembered.url || saved.url || "",
        title: remembered.title || saved.title || "",
        selectedAt: saved.selectedAt || Date.now()
      };
    }
  }
  const [active] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!active?.id) return saved;
  return {
    tabId: active.id,
    windowId: active.windowId,
    url: active.url || (saved.tabId === active.id ? saved.url : "") || "",
    title: active.title || (saved.tabId === active.id ? saved.title : "") || "",
    selectedAt: saved.tabId === active.id ? saved.selectedAt : Date.now()
  };
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  if (!contexts.length) {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["USER_MEDIA", "DISPLAY_MEDIA", "WEB_RTC", "AUDIO_PLAYBACK"],
      justification:
        "Capturer uniquement l’audio de l’onglet choisi et jouer sa traduction RedCall."
    });
  }
  await waitForOffscreen();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "service-worker" && message.type === "PREPARE_OFFSCREEN") {
    ensureOffscreen()
      .then(() => sendResponse({ok: true}))
      .catch((error) => sendResponse({ok: false, error: error.message}));
    return true;
  }
  if (message?.target === "service-worker" && message.type === "CHOOSE_TAB_AUDIO") {
    captureTabAudio()
      .then(sendResponse)
      .catch((error) => sendResponse({ok: false, error: error.message}));
    return true;
  }
  if (message?.target === "service-worker" && message.type === "GET_CAPTURE_CONTEXT") {
    captureContext()
      .then((context) => sendResponse({ok: true, context}))
      .catch((error) => sendResponse({ok: false, error: error.message}));
    return true;
  }
  if (message?.target === "offscreen") {
    ensureOffscreen()
      .then(() => chrome.runtime.sendMessage({...message, target: "offscreen-document"}))
      .then(sendResponse)
      .catch((error) => sendResponse({ok: false, error: error.message}));
    return true;
  }
  if (message?.type === "ADAPTER_STATUS") {
    chrome.runtime.sendMessage({...message, target: "sidepanel"}).catch(() => {});
  }
  return false;
});
