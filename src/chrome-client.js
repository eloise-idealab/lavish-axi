/* global EventSource, document, location, window */

const sessionDataElement = document.getElementById("lavish-session");
const sessionData = JSON.parse(sessionDataElement?.textContent || "{}");
const key = String(sessionData.key || "");
const filePath = String(sessionData.file || "");
const queueStorageKey = "lavish-axi:queued:" + key;
const internalQueueKeyField = "_lavishQueueKey";
const initialChat = Array.isArray(sessionData.initialChat) ? sessionData.initialChat : [];

const frame = /** @type {HTMLIFrameElement} */ (document.getElementById("artifact"));
const annotationPills = /** @type {HTMLDivElement} */ (document.getElementById("annotationPills"));
const chatLog = /** @type {HTMLDivElement} */ (document.getElementById("chatLog"));
const chatInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("chatInput"));
const sendButton = /** @type {HTMLButtonElement} */ (document.getElementById("send"));
const sendCaret = /** @type {HTMLButtonElement} */ (document.getElementById("sendCaret"));
const sendActions = /** @type {HTMLDivElement} */ (document.getElementById("sendActions"));
const sendMenu = /** @type {HTMLDivElement} */ (document.getElementById("sendMenu"));
const sendFromMenuButton = /** @type {HTMLButtonElement} */ (document.getElementById("sendFromMenu"));
const sendAndEndButton = /** @type {HTMLButtonElement} */ (document.getElementById("sendAndEnd"));
const annotationSwitch = /** @type {HTMLButtonElement} */ (document.getElementById("annotation"));
const moreWrap = /** @type {HTMLDivElement} */ (document.getElementById("moreWrap"));
const moreButton = /** @type {HTMLButtonElement} */ (document.getElementById("moreButton"));
const moreMenu = /** @type {HTMLDivElement} */ (document.getElementById("moreMenu"));
const reloadArtifactButton = /** @type {HTMLButtonElement} */ (document.getElementById("reloadArtifact"));
const copySnapshotButton = /** @type {HTMLButtonElement} */ (document.getElementById("copySnapshot"));
const endButton = /** @type {HTMLButtonElement} */ (document.getElementById("end"));
const copyPathButton = /** @type {HTMLButtonElement} */ (document.getElementById("copyPath"));
const copyHint = /** @type {HTMLSpanElement} */ (document.getElementById("copyHint"));
const copyHintText = /** @type {HTMLSpanElement} */ (document.getElementById("copyHintText"));
const presenceBanner = /** @type {HTMLDivElement} */ (document.getElementById("presenceBanner"));
const endedOverlay = /** @type {HTMLDivElement} */ (document.getElementById("endedOverlay"));
const layoutGateOverlay = /** @type {HTMLDivElement} */ (document.getElementById("layoutGateOverlay"));
const layoutGateTitle = /** @type {HTMLDivElement} */ (document.getElementById("layoutGateTitle"));
const layoutGateCopy = /** @type {HTMLParagraphElement} */ (document.getElementById("layoutGateCopy"));
const layoutGateAction = /** @type {HTMLButtonElement} */ (document.getElementById("layoutGateAction"));
const layoutIssueBanner = /** @type {HTMLDivElement} */ (document.getElementById("layoutIssueBanner"));
const sendHint = /** @type {HTMLSpanElement} */ (document.getElementById("sendHint"));
const artifactSrc = frame.dataset.artifactSrc || frame.getAttribute?.("data-artifact-src") || frame.src || "";

const queued = loadQueuedPrompts();
let annotation = true;
let ended = false;
let agentPresence = "waiting";
let pendingSnapshot = "";
// Change #3 (threading): id of the agent message the next user message replies to ("" = no thread),
// and a lookup of rendered agent message text by id for the quoted-snippet preview.
let replyToId = "";
const chatMessages = new Map();
const replyIndicator = /** @type {HTMLDivElement} */ (document.getElementById("replyIndicator"));
const replyIndicatorText = /** @type {HTMLSpanElement} */ (document.getElementById("replyIndicatorText"));
const replyIndicatorClear = /** @type {HTMLButtonElement} */ (document.getElementById("replyIndicatorClear"));
const layoutGateEnabled = sessionData.layoutGateEnabled !== false;
const configuredLayoutGateMaxHoldMs = Number(sessionData.layoutGateMaxHoldMs);
const layoutGateMaxHoldMs =
  Number.isFinite(configuredLayoutGateMaxHoldMs) && configuredLayoutGateMaxHoldMs > 0
    ? Math.min(configuredLayoutGateMaxHoldMs, 60_000)
    : 12_000;
let layoutGateVisible = false;
let layoutGateArmed = false;
let layoutGateManuallyBypassed = !layoutGateEnabled;
let layoutGateCycle = 0;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let layoutGateTimer;
const snapshotRequests = [];
let endAfterSubmit = false;
let workingBubble = null;
let submitQueuedPromise = null;
let submitQueuedAgain = false;
let lastScroll = { x: 0, y: 0 };
/** @type {ReturnType<typeof setTimeout> | undefined} */
let copyHintTimer;
/** @type {ReturnType<typeof setTimeout> | undefined} */
let sendHintTimer;

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );
}

// Render a safe subset of inline markdown for agent messages: **bold**, *italic* / _italic_, and
// `code`. HTML is escaped FIRST, then the markdown tokens are applied to the escaped string, so the
// only tags introduced are the ones added here — no injection from message text.
function renderInlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*\n]+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/(^|[\s(])\*([^*\s][^*\n]*?)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  html = html.replace(/(^|[\s(])_([^_\s][^_\n]*?)_(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  html = html.replace(/\n/g, "<br>");
  return html;
}

/**
 * @typedef {{ id?: string, role: string, text: string, reply_to?: string, at?: number }} ChatMsg
 */

// Walk reply_to up to the thread root id. Cycle- and dangling-safe: returns the topmost id with no
// reply_to, or the current id if the chain loops or points at a missing message.
/** @param {string} id @param {Map<string, ChatMsg>} byId @returns {string} */
function resolveRootId(id, byId) {
  const seen = new Set();
  let curId = String(id);
  for (;;) {
    if (seen.has(curId)) return curId;
    seen.add(curId);
    const current = byId.get(curId);
    if (!current || !current.reply_to) return curId;
    const parentId = String(current.reply_to);
    if (!byId.has(parentId)) return curId;
    curId = parentId;
  }
}

// Split a flat, chronological transcript into roots (no reply_to) and replies grouped under their
// resolved root. One level deep: nested replies land flat under the same root.
/** @param {ChatMsg[]} messages @returns {{ roots: ChatMsg[], repliesByRoot: Map<string, ChatMsg[]> }} */
function groupThreads(messages) {
  const byId = new Map();
  for (const m of messages) {
    if (m && m.id != null && m.id !== "") byId.set(String(m.id), m);
  }
  const roots = [];
  const repliesByRoot = new Map();
  for (const m of messages) {
    if (!m) continue;
    const id = m.id != null ? String(m.id) : "";
    const rootId = id ? resolveRootId(id, byId) : "";
    if (!id || !m.reply_to || rootId === id) {
      roots.push(m);
      if (id && !repliesByRoot.has(id)) repliesByRoot.set(id, []);
      continue;
    }
    if (!repliesByRoot.has(rootId)) repliesByRoot.set(rootId, []);
    (repliesByRoot.get(rootId) || []).push(m);
  }
  return { roots, repliesByRoot };
}

// Coarse relative time for thread chips ("just now", "30s", "5m", "3h", "2d").
/** @param {number} at @param {number} now @returns {string} */
function formatRelativeTime(at, now) {
  const t = Number(at);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** @param {number} count @param {number} lastAt @param {number} now @returns {string} */
function threadChipLabel(count, lastAt, now) {
  const noun = count === 1 ? "reply" : "replies";
  const rel = formatRelativeTime(lastAt, now);
  return rel ? `${count} ${noun} · ${rel}` : `${count} ${noun}`;
}

// True when a thread is open and an incoming message belongs to a different thread/root, so the
// Back button should show an unread badge.
/** @param {string} openRootId @param {ChatMsg} message @param {Map<string, ChatMsg>} byId @returns {boolean} */
function shouldFlagBackBadge(openRootId, message, byId) {
  if (!openRootId) return false;
  const id = message && message.id != null ? String(message.id) : "";
  if (!id) return false;
  return resolveRootId(id, byId) !== String(openRootId);
}

function loadQueuedPrompts() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(queueStorageKey) || "[]");
    return Array.isArray(parsed) ? parsed.filter((prompt) => prompt && typeof prompt === "object") : [];
  } catch {
    return [];
  }
}

function persistQueuedPrompts() {
  try {
    if (queued.length) {
      sessionStorage.setItem(queueStorageKey, JSON.stringify(queued));
    } else {
      sessionStorage.removeItem(queueStorageKey);
    }
  } catch {
    // The in-memory queue still works if browser storage is unavailable.
  }
}

function render() {
  annotationPills.innerHTML = queued
    .map(
      (prompt, index) =>
        '<div class="pill-wrap"><div class="pill"><span class="pill-preview">' +
        escapeHtml(prompt.prompt) +
        '</span><button class="pill-close" type="button" aria-label="Remove queued prompt" data-index="' +
        index +
        '">×</button></div><div class="pill-tooltip">' +
        (prompt.selector
          ? '<div class="tooltip-label">Target</div><div class="pill-tooltip-target">' +
            escapeHtml(prompt.selector) +
            "</div>"
          : "") +
        '<div class="tooltip-label">Prompt</div><div class="pill-tooltip-prompt">' +
        escapeHtml(prompt.prompt) +
        "</div></div></div>",
    )
    .join("");

  for (const button of annotationPills.querySelectorAll(".pill-close")) {
    const closeButton = /** @type {HTMLButtonElement} */ (button);
    closeButton.addEventListener("click", (event) => removeQueuedPrompt(Number(closeButton.dataset.index), event));
  }
  updateSendState();
}

function updateSendState() {
  // Change #2: the Send button (and in-page chat input) are never disabled just because the agent
  // is "working". A queued/streamed message is always accepted and delivered, so blocking the UI
  // mid-task only adds friction. Still disable on a genuinely ended session.
  sendButton.disabled = ended;
  sendCaret.disabled = ended;
  sendFromMenuButton.disabled = sendButton.disabled;
}

function showSendHint() {
  sendHint.hidden = false;
  clearTimeout(sendHintTimer);
  sendHintTimer = setTimeout(() => {
    sendHint.hidden = true;
  }, 2600);
  chatInput.focus();
}

function hideSendHint() {
  clearTimeout(sendHintTimer);
  sendHint.hidden = true;
}

function setMenuOpen(button, menu, open) {
  menu.hidden = !open;
  button.setAttribute("aria-expanded", String(open));
}

function closeMenus() {
  setMenuOpen(moreButton, moreMenu, false);
  setMenuOpen(sendCaret, sendMenu, false);
}

function toggleMenu(button, menu) {
  const open = menu.hidden;
  closeMenus();
  setMenuOpen(button, menu, open);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the textarea-based fallback below.
  }
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.style.position = "fixed";
  helper.style.opacity = "0";
  document.body.appendChild(helper);
  helper.select();
  document.execCommand("copy");
  helper.remove();
  return true;
}

function addChat(role, text, meta = {}) {
  if (!text) return;

  const el = document.createElement("div");
  el.className = "bubble " + role;
  if (meta.id) {
    el.dataset.messageId = String(meta.id);
    // Store every message (user and agent) so any of them can be quoted and replied to.
    chatMessages.set(String(meta.id), text);
  }
  // Change #3 (threading): show which earlier message this one replies to, as a quoted snippet.
  let threadHtml = "";
  if (meta.reply_to) {
    const quoted = chatMessages.get(String(meta.reply_to));
    if (quoted) {
      threadHtml = '<div class="reply-quote">' + escapeHtml(truncateQuote(quoted)) + "</div>";
    }
  }
  // Every message with an id gets a Reply affordance so you can thread under your own messages too.
  const replyHtml = meta.id
    ? '<button class="reply-button" type="button" data-reply-id="' + escapeHtml(String(meta.id)) + '">Reply</button>'
    : "";
  // Agent messages render a safe subset of markdown (**bold**, *italic*, `code`); user text stays plain.
  const body = role === "agent" ? renderInlineMarkdown(text) : escapeHtml(text);
  el.innerHTML =
    "<small>" + (role === "agent" ? "Agent" : "You") + "</small>" + threadHtml + "<div>" + body + "</div>" + replyHtml;
  const replyButton = el.querySelector(".reply-button");
  if (replyButton) {
    replyButton.addEventListener("click", () => setReplyTarget(String(meta.id), text));
  }
  chatLog.appendChild(el);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function truncateQuote(text) {
  const trimmed = String(text).replace(/\s+/g, " ").trim();
  return trimmed.length > 120 ? trimmed.slice(0, 117) + "..." : trimmed;
}

function setReplyTarget(id, text) {
  replyToId = id;
  if (replyIndicator) {
    replyIndicatorText.textContent = truncateQuote(text);
    replyIndicator.hidden = false;
  }
  chatInput.focus();
}

function clearReplyTarget() {
  replyToId = "";
  if (replyIndicator) replyIndicator.hidden = true;
}

function syncChat(chat) {
  for (const el of [...chatLog.querySelectorAll(".bubble.user,.bubble.agent:not(.agent-working)")]) {
    el.remove();
  }

  chatMessages.clear();
  for (const item of chat) addChat(item.role, item.text, { id: item.id, reply_to: item.reply_to });
  if (workingBubble) chatLog.appendChild(workingBubble);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function setAgentPresence(state) {
  agentPresence = state === "listening" || state === "working" ? state : "waiting";
  updateSendState();
  if (presenceBanner) presenceBanner.hidden = ended || agentPresence !== "waiting";

  if (agentPresence !== "working") {
    if (workingBubble) workingBubble.remove();
    workingBubble = null;
    return;
  }

  if (!workingBubble) {
    workingBubble = document.createElement("div");
    workingBubble.className = "bubble agent agent-working";
    workingBubble.innerHTML = '<span class="spinner"></span><span>Working...</span>';
    chatLog.appendChild(workingBubble);
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

function removeQueuedPrompt(index, event) {
  if (event) event.stopPropagation();
  queued.splice(index, 1);
  persistQueuedPrompts();
  render();
}

function promptQueueKey(prompt) {
  return prompt && typeof prompt[internalQueueKeyField] === "string" ? prompt[internalQueueKeyField].trim() : "";
}

function enqueuePrompt(prompt) {
  if (!prompt || typeof prompt !== "object") return;

  const queueKey = promptQueueKey(prompt);
  if (queueKey) {
    const index = queued.findIndex((item) => promptQueueKey(item) === queueKey);
    if (index !== -1) {
      queued[index] = prompt;
    } else {
      queued.push(prompt);
    }
  } else {
    queued.push(prompt);
  }

  persistQueuedPrompts();
  render();
}

function stripInternalPromptFields(prompt) {
  if (!prompt || typeof prompt !== "object") return prompt;
  const clean = { ...prompt };
  delete clean[internalQueueKeyField];
  return clean;
}

function postToFrame(message) {
  if (frame.contentWindow) frame.contentWindow.postMessage(message, "*");
}

function requestSnapshot(action) {
  snapshotRequests.push(action);
  postToFrame({ type: "lavish:requestSnapshot" });
}

function sendQueued(endAfter) {
  // Change #2: only an ended session blocks sending; "working" no longer early-returns, so a stream
  // of messages can be fired while the agent is still acting on the previous one.
  if (ended) return;
  closeMenus();

  const text = chatInput.value.trim();
  if (text) {
    const message = { uid: "", prompt: text, selector: "", tag: "message", text: "Freeform message" };
    // Change #3 (threading): if the user is replying to a specific agent bubble, carry its id so the
    // agent receives `reply_to` and the transcript renders the message under that thread.
    if (replyToId) {
      message.reply_to = replyToId;
    }
    queued.push(message);
    persistQueuedPrompts();
    addChat("user", text, { reply_to: replyToId });
    clearReplyTarget();
    chatInput.value = "";
    render();
  }
  if (!queued.length) {
    if (endAfter) {
      endSession();
    } else {
      showSendHint();
    }
    return;
  }
  hideSendHint();

  if (endAfter) endAfterSubmit = true;
  requestSnapshot("submit");
}

async function submitQueued() {
  if (submitQueuedPromise) {
    submitQueuedAgain = true;
    return submitQueuedPromise;
  }

  let succeeded = false;
  submitQueuedPromise = submitQueuedOnce();
  try {
    const result = await submitQueuedPromise;
    succeeded = true;
    return result;
  } finally {
    submitQueuedPromise = null;
    const shouldSubmitAgain = submitQueuedAgain;
    submitQueuedAgain = false;
    if (!succeeded) {
      endAfterSubmit = false;
    } else if (shouldSubmitAgain && queued.length) {
      submitQueued();
    } else if (endAfterSubmit) {
      endAfterSubmit = false;
      await endSession();
    }
  }
}

async function submitQueuedOnce() {
  const prompts = queued.slice();
  const response = await fetch("/api/" + key + "/prompts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompts: prompts.map(stripInternalPromptFields), domSnapshot: pendingSnapshot }),
  });
  if (!response.ok) throw new Error("failed to submit queued prompts");
  for (const prompt of prompts) {
    const index = queued.indexOf(prompt);
    if (index !== -1) queued.splice(index, 1);
  }
  persistQueuedPrompts();
  render();
  if (agentPresence === "listening") setAgentPresence("working");
}

function normalizeLayoutWarningsPayload(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

function isErrorLayoutWarning(warning) {
  return String(warning?.severity || "").toLowerCase() === "error";
}

function setLayoutIssueBanner(visible, text = "This surface may have layout issues. Your agent has been notified.") {
  if (!layoutIssueBanner) return;
  layoutIssueBanner.textContent = text;
  layoutIssueBanner.hidden = !visible;
}

function clearLayoutGateTimer() {
  if (layoutGateTimer) clearTimeout(layoutGateTimer);
  layoutGateTimer = undefined;
}

function setLayoutGateCard(state) {
  if (!layoutGateTitle || !layoutGateCopy) return;

  if (state === "held") {
    layoutGateTitle.innerHTML = "Fixing a layout issue...";
    layoutGateCopy.textContent =
      "The real browser found overflow or overlapping content. Your agent has been notified and this will reveal after the next clean reload.";
    return;
  }

  layoutGateTitle.innerHTML = "Checking layout.<br>One moment.";
  layoutGateCopy.textContent = "Lavish is waiting for fonts and final geometry before revealing this artifact.";
}

function setLayoutGateActive(active) {
  layoutGateVisible = active;
  if (layoutGateOverlay) layoutGateOverlay.hidden = !active;
  document.body?.classList?.toggle("layout-gate-active", active);
}

function revealLayoutGate({ showBanner = false, bannerText = undefined } = {}) {
  clearLayoutGateTimer();
  layoutGateArmed = false;
  setLayoutGateActive(false);
  setLayoutIssueBanner(showBanner, bannerText);
}

function forceRevealLayoutGate(reason) {
  if (!layoutGateEnabled || ended) return;
  if (reason === "manual") layoutGateManuallyBypassed = true;
  const bannerText =
    reason === "timeout"
      ? "This surface may have layout issues. Lavish revealed it after the safety timeout so review is never blocked."
      : "This surface may have layout issues. You chose to show it before the layout check passed.";
  revealLayoutGate({ showBanner: true, bannerText });
}

function startLayoutGateCycle() {
  if (!layoutGateEnabled || layoutGateManuallyBypassed || ended) return;

  layoutGateCycle += 1;
  layoutGateArmed = true;
  setLayoutIssueBanner(false);
  setLayoutGateCard("checking");
  setLayoutGateActive(true);
  clearLayoutGateTimer();

  const cycle = layoutGateCycle;
  layoutGateTimer = setTimeout(() => {
    if (cycle !== layoutGateCycle || !layoutGateVisible || ended) return;
    forceRevealLayoutGate("timeout");
  }, layoutGateMaxHoldMs);
  layoutGateTimer?.unref?.();
}

function handleLayoutWarningsForGate(layoutWarnings) {
  const warnings = normalizeLayoutWarningsPayload(layoutWarnings);
  const hasErrors = warnings.some(isErrorLayoutWarning);

  if (!layoutGateEnabled) return;

  if (layoutGateManuallyBypassed) {
    setLayoutIssueBanner(hasErrors);
    return;
  }

  if (!layoutGateArmed && !layoutGateVisible) return;

  if (!hasErrors) {
    revealLayoutGate();
    return;
  }

  setLayoutGateCard("held");
  setLayoutGateActive(true);
}

function initializeLayoutGate() {
  if (!layoutGateEnabled) {
    setLayoutGateActive(false);
    setLayoutIssueBanner(false);
    return;
  }

  if (layoutGateAction) layoutGateAction.onclick = () => forceRevealLayoutGate("manual");
  startLayoutGateCycle();
}

async function submitLayoutWarnings(layoutWarnings) {
  const response = await fetch("/api/" + key + "/layout-warnings", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ layout_warnings: normalizeLayoutWarningsPayload(layoutWarnings) }),
  });
  if (!response.ok) throw new Error("failed to submit layout warnings");
}

async function endSession() {
  if (ended) return;
  const response = await fetch("/api/" + key + "/end", { method: "POST" });
  if (!response.ok) throw new Error("failed to end session");
  ended = true;
  closeMenus();
  annotationSwitch.disabled = true;
  moreButton.disabled = true;
  chatInput.disabled = true;
  updateSendState();
  if (presenceBanner) presenceBanner.hidden = true;
  layoutGateManuallyBypassed = true;
  revealLayoutGate();
  postToFrame({ type: "lavish:setAnnotationMode", enabled: false });
  endedOverlay.hidden = false;
}

function copyFilePath() {
  copyText(filePath);
  copyHint.classList.add("copied");
  copyHintText.textContent = "Copied";
  clearTimeout(copyHintTimer);
  copyHintTimer = setTimeout(() => {
    copyHint.classList.remove("copied");
    copyHintText.textContent = "Copy";
  }, 1600);
}

function copyDomSnapshot() {
  closeMenus();
  requestSnapshot("copy");
}

function resetFrame() {
  startLayoutGateCycle();
  // The iframe is sandboxed, so reload by resetting the iframe URL from chrome.
  frame.src = artifactSrc || frame.src;
}

function loadFrame() {
  if (artifactSrc) frame.src = artifactSrc;
}

function reloadArtifact() {
  closeMenus();
  resetFrame();
}

async function reloadAfterServerRestart() {
  let sawOutage = false;
  const deadline = Date.now() + 5000;

  while (Date.now() < deadline) {
    try {
      const res = await fetch("/health", { cache: "no-store" });
      if (sawOutage && res.ok) {
        location.reload();
        return;
      }
    } catch {
      sawOutage = true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  location.reload();
}

window.addEventListener("message", (event) => {
  if (event.source !== frame.contentWindow) return;

  const msg = event.data || {};
  if (msg.type === "lavish:queuePrompt") {
    enqueuePrompt(msg.prompt);
  }
  if (msg.type === "lavish:snapshot") {
    const snapshotAction = snapshotRequests.shift() || "submit";
    if (snapshotAction === "copy") {
      copyText(msg.snapshot || "");
    } else {
      pendingSnapshot = msg.snapshot || "";
      submitQueued();
    }
  }
  if (msg.type === "lavish:scroll") {
    lastScroll = { x: Number(msg.x) || 0, y: Number(msg.y) || 0 };
  }
  if (msg.type === "lavish:layoutWarnings") {
    handleLayoutWarningsForGate(msg.layout_warnings);
    submitLayoutWarnings(msg.layout_warnings).catch(() => {});
  }
  if (msg.type === "lavish:sendQueuedPrompts") sendQueued();
  if (msg.type === "lavish:endSession") endSession();
});

loadFrame();

annotationSwitch.onclick = () => {
  annotation = !annotation;
  annotationSwitch.setAttribute("aria-pressed", String(annotation));
  postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation });
};

sendButton.onclick = () => sendQueued(false);
sendFromMenuButton.onclick = () => sendQueued(false);
sendAndEndButton.onclick = () => sendQueued(true);
sendCaret.onclick = () => toggleMenu(sendCaret, sendMenu);
moreButton.onclick = () => toggleMenu(moreButton, moreMenu);
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    sendQueued(false);
  }
});
chatInput.addEventListener("input", hideSendHint);
copyPathButton.onclick = copyFilePath;
reloadArtifactButton.onclick = reloadArtifact;
copySnapshotButton.onclick = copyDomSnapshot;
endButton.onclick = () => {
  closeMenus();
  endSession();
};
document.addEventListener("mousedown", (event) => {
  const target = /** @type {Node} */ (event.target);
  if (!moreMenu.hidden && !moreWrap.contains(target)) setMenuOpen(moreButton, moreMenu, false);
  if (!sendMenu.hidden && !sendActions.contains(target)) setMenuOpen(sendCaret, sendMenu, false);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenus();
});
frame.addEventListener("load", () => {
  postToFrame({ type: "lavish:setAnnotationMode", enabled: annotation && !ended });
  // Replay the pre-reload scroll position so hot reloads don't jump the artifact to the top.
  postToFrame({ type: "lavish:restoreScroll", x: lastScroll.x, y: lastScroll.y });
});

initializeLayoutGate();

const events = new EventSource("/events/" + key);
events.addEventListener("reload", () => resetFrame());
events.addEventListener("chrome-reload", () => reloadAfterServerRestart());
events.addEventListener("agent-reply", (event) => {
  const data = JSON.parse(event.data);
  addChat("agent", data.text, { id: data.id, reply_to: data.reply_to });
});
events.addEventListener("chat-sync", (event) => syncChat(JSON.parse(event.data).chat || []));
events.addEventListener("agent-presence", (event) => setAgentPresence(JSON.parse(event.data).state));

if (replyIndicatorClear) replyIndicatorClear.onclick = () => clearReplyTarget();

render();
initialChat.forEach((item) => addChat(item.role, item.text, { id: item.id, reply_to: item.reply_to }));
setAgentPresence("waiting");

// Test seam: a harness pre-seeds globalThis.__lavishTest, letting the pure threading helpers be
// unit-tested without a DOM. No-op in the browser, where the key is never set.
if (globalThis.__lavishTest) {
  globalThis.__lavishTest.threading = {
    resolveRootId,
    groupThreads,
    formatRelativeTime,
    threadChipLabel,
    shouldFlagBackBadge,
  };
}
