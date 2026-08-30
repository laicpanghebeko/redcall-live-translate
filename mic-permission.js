const state = document.getElementById("state");

function show(text, kind) {
  state.textContent = text;
  state.className = `state ${kind}`;
}

async function ask() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({audio: true});
    // L'autorisation est désormais accordée à l'origine de l'extension : le
    // document offscreen pourra l'utiliser sans invite. On libère le micro.
    for (const track of stream.getTracks()) track.stop();
    show("Microphone autorisé. Vous pouvez fermer cet onglet et relancer RedCall.", "ok");
  } catch (error) {
    const name = error?.name || "";
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      show("Aucun microphone détecté sur cet ordinateur.", "ko");
      return;
    }
    show(
      "Autorisation refusée. Cliquez sur l’icône de caméra ou de cadenas à gauche de " +
        "la barre d’adresse, mettez le microphone sur « Autoriser », puis rechargez cette page.",
      "ko"
    );
  }
}

document.getElementById("ask").addEventListener("click", ask);

navigator.permissions
  .query({name: "microphone"})
  .then((status) => {
    if (status.state === "granted") {
      show("Microphone déjà autorisé. Vous pouvez fermer cet onglet.", "ok");
    }
  })
  .catch(() => {});
