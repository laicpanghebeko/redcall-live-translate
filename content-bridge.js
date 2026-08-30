chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "GET_REDCALL_TAB_INFO") {
    sendResponse({ok: true, origin: window.location.origin, title: document.title});
    return false;
  }
  if (message?.type === "REDCALL_ADAPTER_START" || message?.type === "REDCALL_ADAPTER_STOP") {
    window.postMessage({...message, channel: "redcall-extension"}, window.location.origin);
    sendResponse({ok: true});
  }
});

window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  if (event.data?.channel === "redcall-site-adapter" && event.data?.type === "ADAPTER_STATUS") {
    chrome.runtime.sendMessage({
      type: "ADAPTER_STATUS",
      status: event.data.status,
      detail: event.data.detail
    });
  }
});
