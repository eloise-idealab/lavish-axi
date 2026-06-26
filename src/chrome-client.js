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
// Threading: full client model rebuilt from the authoritative transcript, plus the id of the root
// whose thread is currently open ("" = none).
/** @type {Map<string, ChatMsg>} */
const messagesById = new Map();
/** @type {string[]} */
const messageOrder = [];
let openThreadRootId = "";
/** @type {Map<string, number>} */
const seenReplyCount = new Map();
let seenBaselined = false;
const chatPane = /** @type {HTMLDivElement} */ (document.getElementById("chatPane"));
const panel = chatPane?.parentElement || null;
const threadChat = /** @type {HTMLDivElement} */ (document.getElementById("threadChat"));
const threadTitle = /** @type {HTMLSpanElement} */ (document.getElementById("threadTitle"));
const threadBack = /** @type {HTMLButtonElement} */ (document.getElementById("threadBack"));
const backBadge = /** @type {HTMLSpanElement} */ (document.getElementById("backBadge"));
const threadInput = /** @type {HTMLTextAreaElement} */ (document.getElementById("threadInput"));
const threadSend = /** @type {HTMLButtonElement} */ (document.getElementById("threadSend"));
const threadReplyIndicator = /** @type {HTMLDivElement} */ (document.getElementById("threadReplyIndicator"));
const threadReplyIndicatorText = /** @type {HTMLSpanElement} */ (document.getElementById("threadReplyIndicatorText"));
const threadReplyIndicatorClear = /** @type {HTMLButtonElement} */ (
  document.getElementById("threadReplyIndicatorClear")
);
let threadReplyToId = "";
let localMessageSeq = 0;
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

// Returns true for optimistic/unreconciled messages whose id was minted client-side ("local-<n>").
// These must not be threadable or targetable until a chat-sync round-trip replaces the id with a
// server-assigned durable id.
function isLocalId(id) {
  return typeof id === "string" && id.startsWith("local-");
}

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
/** @param {number|string} at @param {number} now @returns {string} */
function formatRelativeTime(at, now) {
  const t = typeof at === "number" ? at : Date.parse(String(at));
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

// How many replies in a thread the user has not seen yet (never negative).
/** @param {string} rootId @param {number} currentCount @param {Map<string, number>} seenMap @returns {number} */
function unreadReplyCount(rootId, currentCount, seenMap) {
  const seen = seenMap.get(String(rootId)) || 0;
  return Math.max(0, currentCount - seen);
}

/** @param {string} rootId @param {number} currentCount @param {Map<string, number>} seenMap @returns {boolean} */
function isThreadUnread(rootId, currentCount, seenMap) {
  return unreadReplyCount(rootId, currentCount, seenMap) > 0;
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

// Build one chat bubble element. `chip` adds a thread chip to a root that has replies.
// `reply` is a tri-state:
//   false   — no reply button
//   "open"  — Reply button whose click calls openThread (for main-list roots with no replies)
//   "target"— Reply button whose click calls setThreadReplyTarget (for thread bubbles)
/**
 * @param {ChatMsg} message
 * @param {{ chip?: string|null, chipUnread?: boolean, isRoot?: boolean, reply?: false|"open"|"target" }} [opts]
 */
function buildBubble(message, { chip = null, chipUnread = false, isRoot = false, reply = false } = {}) {
  const el = document.createElement("div");
  el.className = "bubble " + message.role + (isRoot ? " thread-root" : "");
  if (message.id) el.dataset.messageId = String(message.id);
  const body = message.role === "agent" ? renderInlineMarkdown(message.text) : escapeHtml(message.text);
  let html = "<small>" + (message.role === "agent" ? "Agent" : "You") + "</small><div>" + body + "</div>";
  if (chip) {
    html +=
      '<button class="thread-chip' +
      (chipUnread ? " unread" : "") +
      '" type="button" data-root-id="' +
      escapeHtml(String(message.id)) +
      '"><span class="dot"></span>' +
      escapeHtml(chip) +
      "</button>";
  }
  if (reply && message.id && !isLocalId(String(message.id))) {
    html +=
      '<button class="reply-button" type="button" data-reply-id="' +
      escapeHtml(String(message.id)) +
      '">Reply</button>';
  }
  el.innerHTML = html;
  const chipButton = el.querySelector(".thread-chip");
  if (chipButton) chipButton.addEventListener("click", () => openThread(String(message.id)));
  const replyButton = el.querySelector(".reply-button");
  if (replyButton) {
    if (reply === "open") {
      replyButton.addEventListener("click", () => openThread(String(message.id)));
    } else {
      replyButton.addEventListener("click", () => setThreadReplyTarget(String(message.id), message.text));
    }
  }
  return el;
}

// Append a message to the in-memory model (used for optimistic local sends and incoming events).
function rememberMessage(message) {
  if (!message) return;
  const id = message.id != null ? String(message.id) : "";
  if (id) {
    if (!messagesById.has(id)) messageOrder.push(id);
    messagesById.set(id, message);
  } else {
    messageOrder.push("");
  }
}

// Rebuild the whole model from the authoritative transcript.
function setMessages(chat) {
  messagesById.clear();
  messageOrder.length = 0;
  for (const item of chat) {
    rememberMessage({
      id: item.id,
      role: item.role,
      text: item.text,
      reply_to: item.reply_to,
      at: item.at,
    });
  }
}

function orderedMessages() {
  const seen = new Set();
  const list = [];
  for (const id of messageOrder) {
    if (id) {
      if (seen.has(id)) continue;
      seen.add(id);
      const m = messagesById.get(id);
      if (m) list.push(m);
    }
  }
  return list;
}

// Render only roots into the main list, each with a thread chip when it has replies.
function renderChat() {
  for (const el of [...chatLog.querySelectorAll(".bubble.user,.bubble.agent:not(.agent-working)")]) {
    el.remove();
  }
  const { roots, repliesByRoot } = groupThreads(orderedMessages());
  const now = Date.now();
  const reference = workingBubble && workingBubble.parentElement === chatLog ? workingBubble : null;
  for (const root of roots) {
    const id = root.id != null ? String(root.id) : "";
    const replies = id ? repliesByRoot.get(id) || [] : [];
    /** @type {false|"open"|"target"} */
    const reply = replies.length ? false : isLocalId(id) ? false : "open";
    let chip = null;
    let chipUnread = false;
    if (replies.length) {
      const unread = unreadReplyCount(id, replies.length, seenReplyCount);
      if (unread > 0) {
        chipUnread = true;
        chip = unread === 1 ? "1 new" : unread + " new";
      } else {
        chip = threadChipLabel(replies.length, replies[replies.length - 1].at, now);
      }
    }
    chatLog.insertBefore(buildBubble(root, { chip, chipUnread, reply }), reference);
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

// Render the open thread: pinned root, a count rule, then replies in time order.
function renderThread(rootId) {
  threadChat.innerHTML = "";
  const root = messagesById.get(String(rootId));
  if (!root) return;
  const { repliesByRoot } = groupThreads(orderedMessages());
  const replies = repliesByRoot.get(String(rootId)) || [];
  threadTitle.textContent = replies.length
    ? threadChipLabel(replies.length, replies[replies.length - 1].at, Date.now())
    : "Thread";
  threadChat.appendChild(buildBubble(root, { isRoot: true, reply: "target" }));
  for (const reply of replies) threadChat.appendChild(buildBubble(reply, { reply: "target" }));
  threadChat.scrollTop = threadChat.scrollHeight;
}

// Current reply count for one root, from the live model.
function replyCountForRoot(rootId) {
  const { repliesByRoot } = groupThreads(orderedMessages());
  return (repliesByRoot.get(String(rootId)) || []).length;
}

function threadUnreadCount(rootId) {
  return unreadReplyCount(String(rootId), replyCountForRoot(rootId), seenReplyCount);
}

// Mark a thread read: the user has now seen all its current replies.
function markThreadSeen(rootId) {
  seenReplyCount.set(String(rootId), replyCountForRoot(rootId));
}

// On the first authoritative transcript with content, treat every existing thread as read.
// Guard is deferred until the model is non-empty so that an initial empty sync doesn't
// lock seenBaselined before real messages arrive.
function baselineSeenOnce() {
  if (seenBaselined) return;
  const { roots } = groupThreads(orderedMessages());
  if (!roots.length) return; // nothing to baseline yet — wait for the real transcript
  seenBaselined = true;
  for (const root of roots) {
    if (root.id != null) markThreadSeen(String(root.id));
  }
}

function setBackBadge(visible) {
  if (!backBadge) return;
  backBadge.hidden = !visible;
  if (visible) backBadge.textContent = "new";
}

function openThread(rootId) {
  openThreadRootId = String(rootId);
  markThreadSeen(openThreadRootId);
  renderChat();
  clearThreadReplyTarget();
  renderThread(openThreadRootId);
  setBackBadge(false);
  if (panel) panel.classList.add("thread-open");
  if (threadInput) threadInput.focus();
}

function closeThread() {
  openThreadRootId = "";
  setBackBadge(false);
  if (panel) panel.classList.remove("thread-open");
}

// Re-render the list and, if a thread is open, the thread view, from the current model.
function syncChat(chat) {
  setMessages(chat);
  // baseline BEFORE renderChat so chips paint with correct read-state on load
  baselineSeenOnce();
  renderChat();
  if (workingBubble) chatLog.appendChild(workingBubble);
  if (openThreadRootId) {
    if (messagesById.has(openThreadRootId)) renderThread(openThreadRootId);
    else closeThread();
  }
  chatLog.scrollTop = chatLog.scrollHeight;
}

function clearThreadReplyTarget() {
  threadReplyToId = "";
  if (threadReplyIndicator) threadReplyIndicator.hidden = true;
}

// Collapse whitespace and truncate long text for the reply indicator quote label.
function truncateQuote(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > 120 ? flat.slice(0, 120) + "…" : flat;
}

// Point the thread composer at a specific message. Shows the reply indicator so the user sees
// what they are replying to, then focuses the thread input.
function setThreadReplyTarget(id, text) {
  if (isLocalId(String(id))) return;
  threadReplyToId = String(id);
  if (threadReplyIndicator) {
    if (threadReplyIndicatorText) threadReplyIndicatorText.textContent = truncateQuote(text);
    threadReplyIndicator.hidden = false;
  }
  if (threadInput) threadInput.focus();
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
    queued.push(message);
    persistQueuedPrompts();
    rememberMessage({ id: "local-" + ++localMessageSeq, role: "user", text, at: Date.now() });
    renderChat();
    if (workingBubble) chatLog.appendChild(workingBubble);
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

// Send a reply from the thread composer. Carries reply_to (the targeted sub-message, or the open
// thread's root) so the server threads it and the agent sees what it answered.
function sendThreadReply() {
  if (ended || !openThreadRootId) return;
  const text = threadInput.value.trim();
  if (!text) return;
  const replyTo = threadReplyToId || openThreadRootId;
  // Defense-in-depth: never forward a local (optimistic) id as reply_to to the server.
  // In normal flow setThreadReplyTarget already rejects local ids, but guard here too.
  const safeReplyTo = isLocalId(replyTo) ? undefined : replyTo;
  const message = {
    uid: "",
    prompt: text,
    selector: "",
    tag: "message",
    text: "Freeform message",
    reply_to: safeReplyTo,
  };
  if (!safeReplyTo) delete message.reply_to;
  queued.push(message);
  persistQueuedPrompts();
  const localMsg = { id: "local-" + ++localMessageSeq, role: "user", text, at: Date.now() };
  if (safeReplyTo) localMsg.reply_to = safeReplyTo;
  rememberMessage(localMsg);
  // Mark the open thread seen BEFORE renderChat so the chip paints as read.
  markThreadSeen(openThreadRootId);
  renderChat();
  if (workingBubble) chatLog.appendChild(workingBubble);
  renderThread(openThreadRootId);
  threadInput.value = "";
  clearThreadReplyTarget();
  render();
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
if (threadSend) threadSend.onclick = () => sendThreadReply();
if (threadInput) {
  threadInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendThreadReply();
    }
  });
}
if (threadReplyIndicatorClear) threadReplyIndicatorClear.onclick = () => clearThreadReplyTarget();
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

function ingestIncoming(message) {
  if (!message || !message.text) return;
  // Build a lookahead map that includes the incoming message so resolveRootId can follow its
  // reply_to chain even though rememberMessage hasn't run yet.
  const lookahead = message.id != null ? new Map([...messagesById, [String(message.id), message]]) : messagesById;
  const flagBadge = shouldFlagBackBadge(openThreadRootId, message, lookahead) || flagsNewRoot(message);
  rememberMessage(message);
  // Startup-race guard: if the initial sync was empty and content arrives live,
  // lock seenBaselined so a later non-empty chat-sync baseline cannot erase the
  // unread signal on a reply the user never opened.
  if (!seenBaselined) seenBaselined = true;
  // Mark the open thread seen BEFORE renderChat so the chip paints as read.
  // A reply into a closed thread must still paint unread — only the open root is marked.
  if (openThreadRootId) markThreadSeen(openThreadRootId);
  renderChat();
  if (workingBubble) chatLog.appendChild(workingBubble);
  if (openThreadRootId) {
    renderThread(openThreadRootId);
    if (flagBadge) setBackBadge(true);
  }
}

// A brand-new root (no reply_to, not yet in the model) is "outside" any open thread, so it should
// also flag the badge. shouldFlagBackBadge already covers replies to other roots.
function flagsNewRoot(message) {
  if (!openThreadRootId) return false;
  const id = message.id != null ? String(message.id) : "";
  return !message.reply_to && id !== openThreadRootId;
}

const events = new EventSource("/events/" + key);
events.addEventListener("reload", () => resetFrame());
events.addEventListener("chrome-reload", () => reloadAfterServerRestart());
events.addEventListener("agent-reply", (event) => {
  const data = JSON.parse(event.data);
  ingestIncoming({ id: data.id, role: "agent", text: data.text, reply_to: data.reply_to, at: data.at });
});
events.addEventListener("chat-sync", (event) => syncChat(JSON.parse(event.data).chat || []));
events.addEventListener("agent-presence", (event) => setAgentPresence(JSON.parse(event.data).state));

if (threadBack) threadBack.addEventListener("click", () => closeThread());

render();
syncChat(initialChat);
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
    unreadReplyCount,
    isThreadUnread,
  };
  globalThis.__lavishTest.openThread = openThread;
  globalThis.__lavishTest.setThreadReplyTarget = setThreadReplyTarget;
  globalThis.__lavishTest.buildBubble = buildBubble;
  globalThis.__lavishTest.orderedMessages = orderedMessages;
  globalThis.__lavishTest.unreadReplyCount = unreadReplyCount;
  globalThis.__lavishTest.isThreadUnread = isThreadUnread;
  globalThis.__lavishTest.threadUnreadCount = threadUnreadCount;
}
