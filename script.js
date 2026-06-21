/* =========================================================
   Voice AI Assistant — Frontend Logic
   ---------------------------------------------------------
   Pipeline:
   mic click -> SpeechRecognition -> text -> POST to n8n webhook
            -> { reply } -> render bubble -> SpeechSynthesis (TTS)

   Sections:
   1. Configuration
   2. DOM references & state
   3. Helpers (UI: bubbles, status, loading, scroll)
   4. Speech Recognition (STT) setup
   5. Networking (call n8n webhook)
   6. Text-to-Speech (TTS)
   7. Event wiring
   ========================================================= */

/* 1. CONFIGURATION -------------------------------------- */
// n8n webhook endpoint. Change this if n8n runs elsewhere.
const WEBHOOK_URL = "https://adwaitha.app.n8n.cloud/webhook/voice-agent";
// Abort the request if the backend/Gemini takes too long (ms).
const REQUEST_TIMEOUT_MS = 30000;

/* 2. DOM REFERENCES & STATE ----------------------------- */
const chatEl = document.getElementById("chat");
const emptyState = document.getElementById("emptyState");
const statusEl = document.getElementById("status");
const micBtn = document.getElementById("micBtn");
const hintEl = document.getElementById("hint");
const muteBtn = document.getElementById("muteBtn");
const muteIcon = document.getElementById("muteIcon");
const muteLabel = document.getElementById("muteLabel");

let recognition = null;   // SpeechRecognition instance
let isListening = false;  // currently capturing speech?
let isMuted = false;  // suppress TTS output?
let isBusy = false;  // a request is in flight?

/* 3. UI HELPERS ----------------------------------------- */

// Remove the empty-state hint once the conversation starts.
function clearEmptyState() {
  if (emptyState && emptyState.parentNode) emptyState.remove();
}

// Always keep the newest message in view.
function scrollToBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

// Append a chat bubble. role = "user" | "ai". Returns the element.
function addMessage(role, text) {
  clearEmptyState();
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const who = document.createElement("span");
  who.className = "who";
  who.textContent = role === "user" ? "You" : "AI";
  const body = document.createElement("span");
  body.textContent = text;
  wrap.appendChild(who);
  wrap.appendChild(body);
  chatEl.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

// Show an animated "AI is thinking" bubble. Returns it so we can replace it.
function addLoadingBubble() {
  clearEmptyState();
  const wrap = document.createElement("div");
  wrap.className = "msg ai";
  wrap.innerHTML =
    '<span class="who">AI</span>' +
    '<span class="typing"><span></span><span></span><span></span></span>';
  chatEl.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

// Show a status / error banner. type = "info" | "error".
function showStatus(message, type = "info") {
  statusEl.textContent = message;
  statusEl.className = `status ${type}`;
  statusEl.classList.remove("hidden");
}
function hideStatus() {
  statusEl.classList.add("hidden");
}

// Reflect listening state in the UI.
function setListeningUI(active) {
  isListening = active;
  micBtn.classList.toggle("listening", active);
  micBtn.setAttribute("aria-label", active ? "Stop listening" : "Start listening");
  hintEl.textContent = active ? "Listening… speak now" : "Click the mic to start";
}

/* 4. SPEECH RECOGNITION (STT) --------------------------- */

// Feature-detect the (prefixed) Web Speech API.
function getRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;

  const rec = new SR();
  rec.lang = "en-US";          // recognition language
  rec.interimResults = false;  // only final results
  rec.maxAlternatives = 1;
  rec.continuous = false;      // auto-stop after a phrase

  // Fired once with the recognized transcript.
  rec.onresult = (event) => {
    const transcript = event.results[0][0].transcript.trim();
    if (transcript) {
      addMessage("user", transcript);   // show what the user said
      sendToWebhook(transcript);        // auto-send to backend
    }
  };

  // Recognition naturally ended (auto-stop after speech).
  rec.onend = () => setListeningUI(false);

  // Map recognition errors to friendly messages.
  rec.onerror = (event) => {
    setListeningUI(false);
    switch (event.error) {
      case "not-allowed":
      case "service-not-allowed":
        showStatus("Microphone permission denied. Allow mic access in your browser settings.", "error");
        break;
      case "no-speech":
        showStatus("No speech detected. Try again and speak clearly.", "info");
        break;
      case "audio-capture":
        showStatus("No microphone found. Please connect a mic and retry.", "error");
        break;
      case "network":
        showStatus("Network error during speech recognition.", "error");
        break;
      default:
        showStatus(`Speech recognition error: ${event.error}`, "error");
    }
  };

  return rec;
}

// Start or stop listening when the mic button is clicked.
function toggleListening() {
  if (isBusy) return; // ignore while waiting on the AI

  if (!recognition) {
    showStatus("Speech Recognition is not supported in this browser. Try Chrome or Edge.", "error");
    return;
  }
  if (isListening) {
    recognition.stop();
    setListeningUI(false);
    return;
  }
  hideStatus();
  try {
    recognition.start();
    setListeningUI(true);
  } catch (err) {
    // start() throws if called while already started; reset state.
    setListeningUI(false);
    showStatus("Could not start listening. Please try again.", "error");
  }
}

/* 5. NETWORKING (call n8n webhook) ---------------------- */

async function sendToWebhook(message) {
  isBusy = true;
  micBtn.disabled = true;
  hintEl.textContent = "Thinking…";
  const loadingBubble = addLoadingBubble();

  // Timeout via AbortController so a hung Gemini call fails gracefully.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      throw new Error(`Server responded with HTTP ${res.status}`);
    }

    // Parse JSON defensively (backend might return text on error).
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error("Received an invalid (non-JSON) response from the server.");
    }

    const reply = (data && typeof data.reply === "string") ? data.reply.trim() : "";

    loadingBubble.remove();

    if (!reply) {
      // Empty response handling.
      const fallback = "I didn't get a response. Please try again.";
      addMessage("ai", fallback);
      speak(fallback);
      showStatus("The AI returned an empty response.", "info");
    } else {
      addMessage("ai", reply);
      hideStatus();
      speak(reply);
    }
  } catch (err) {
    clearTimeout(timer);
    loadingBubble.remove();

    // Distinguish timeout vs connectivity vs other errors.
    if (err.name === "AbortError") {
      const msg = "The AI took too long to respond (timeout). Please try again.";
      addMessage("ai", "⚠️ " + msg);
      showStatus(msg, "error");
    } else if (err instanceof TypeError) {
      // fetch throws TypeError when the server is unreachable / CORS blocked.
      const msg = "Could not reach the n8n webhook. Is n8n running on localhost:5678?";
      addMessage("ai", "⚠️ " + msg);
      showStatus(msg, "error");
    } else {
      addMessage("ai", "⚠️ " + err.message);
      showStatus(err.message, "error");
    }
  } finally {
    isBusy = false;
    micBtn.disabled = false;
    hintEl.textContent = "Click the mic to start";
  }
}

/* 6. TEXT-TO-SPEECH (TTS) ------------------------------- */

function speak(text) {
  if (isMuted) return;
  if (!("speechSynthesis" in window)) return; // unsupported -> silently skip

  // Cancel any ongoing/queued speech before speaking the new reply.
  window.speechSynthesis.cancel();

  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "en-US";
  utter.rate = 1.0;
  utter.pitch = 1.0;
  utter.volume = 1.0;
  window.speechSynthesis.speak(utter);
}

// Toggle mute, update the button, and stop any current speech.
function toggleMute() {
  isMuted = !isMuted;
  if (isMuted) window.speechSynthesis && window.speechSynthesis.cancel();

  muteBtn.setAttribute("aria-pressed", String(isMuted));
  muteBtn.classList.toggle("muted-on", isMuted);
  muteIcon.textContent = isMuted ? "🔇" : "🔊";
  muteLabel.textContent = isMuted ? "Voice Off" : "Voice On";
}

/* 7. EVENT WIRING --------------------------------------- */

function init() {
  recognition = getRecognition();

  // Gracefully degrade if STT is unsupported.
  if (!recognition) {
    micBtn.disabled = true;
    hintEl.textContent = "Speech Recognition not supported in this browser";
    showStatus("Your browser doesn't support Speech Recognition. Use Chrome or Edge.", "error");
  }

  micBtn.addEventListener("click", toggleListening);
  muteBtn.addEventListener("click", toggleMute);
}

document.addEventListener("DOMContentLoaded", init);
