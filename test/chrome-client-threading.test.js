import assert from "node:assert/strict";
import test from "node:test";

import { createChromeHarness, defaultSessionData, flushPromises } from "./helpers/chrome-harness.js";

async function threading() {
  const chrome = await createChromeHarness();
  return chrome.threading();
}

function msg(id, text, replyTo, at) {
  const m = { id, role: "agent", text, at: at ?? 0 };
  if (replyTo) m.reply_to = replyTo;
  return m;
}

test("resolveRootId returns the message id when it has no reply_to", async () => {
  const { resolveRootId } = await threading();
  const byId = new Map([["a", msg("a", "root")]]);
  assert.equal(resolveRootId("a", byId), "a");
});

test("resolveRootId walks a reply chain up to the root", async () => {
  const { resolveRootId } = await threading();
  const byId = new Map([
    ["a", msg("a", "root")],
    ["b", msg("b", "reply", "a")],
    ["c", msg("c", "reply to reply", "b")],
  ]);
  assert.equal(resolveRootId("c", byId), "a");
});

test("resolveRootId is cycle-safe", async () => {
  const { resolveRootId } = await threading();
  const byId = new Map([
    ["a", msg("a", "x", "b")],
    ["b", msg("b", "y", "a")],
  ]);
  // Returns one of the two ids without infinite looping.
  assert.ok(["a", "b"].includes(resolveRootId("a", byId)));
});

test("resolveRootId treats a dangling reply_to as a root", async () => {
  const { resolveRootId } = await threading();
  const byId = new Map([["b", msg("b", "orphan reply", "missing")]]);
  assert.equal(resolveRootId("b", byId), "b");
});

test("groupThreads separates roots from replies and flattens nesting", async () => {
  const { groupThreads } = await threading();
  const messages = [
    msg("a", "root A"),
    msg("b", "reply to A", "a"),
    msg("c", "root C"),
    msg("d", "reply to reply", "b"),
  ];
  const { roots, repliesByRoot } = groupThreads(messages);
  assert.deepEqual(
    roots.map((m) => m.id),
    ["a", "c"],
  );
  assert.deepEqual(
    (repliesByRoot.get("a") || []).map((m) => m.id),
    ["b", "d"],
  );
  assert.equal((repliesByRoot.get("c") || []).length, 0);
});

test("optimistic user send renders immediately (before chat-sync)", async () => {
  const chrome = await createChromeHarness();
  chrome.element("chatInput").value = "hello";
  chrome.element("send").onclick();
  // No chat-sync sent — assert the message is already in the render set.
  assert.ok(
    chrome.threadingOrdered().some((m) => m.text === "hello"),
    "optimistic message should be in ordered list",
  );
  assert.ok(chrome.threadingOrdered().length >= 1, "should have at least one message");
});

test("user's own message survives the agent draining the queue + chat-sync (disappearing-message regression)", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  // 1. User types and sends — the message is optimistically echoed into the transcript.
  chrome.element("chatInput").value = "hello agent";
  chrome.element("send").onclick();
  assert.equal(
    chrome.threadingOrdered().filter((m) => m.text === "hello agent").length,
    1,
    "optimistic message renders immediately",
  );

  // 2. The snapshot round-trip drives POST /prompts (the message enters the agent's queue).
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();
  assert.ok(
    posts.some((p) => p.url === "/api/abc/prompts"),
    "the message was posted to the agent queue",
  );

  // 3. The agent consumes the queue and starts working (presence -> "working"). This is the moment
  //    the message used to vanish; it MUST stay in the visible transcript.
  chrome.eventSource().listeners.get("agent-presence")({ data: JSON.stringify({ state: "working" }) });
  assert.equal(
    chrome.threadingOrdered().filter((m) => m.text === "hello agent").length,
    1,
    "message stays visible while the agent works on it",
  );

  // 4. The server re-broadcasts the authoritative transcript. Because queuePrompts mirrored the user
  //    message into session.chat with a durable id and takeFeedback never clears chat, the sync still
  //    carries it. Reconciliation must keep it (now with the server id), never drop it or duplicate it.
  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({ chat: [{ id: "S1", role: "user", text: "hello agent", at: 1 }] }),
  });
  const afterSync = chrome.threadingOrdered().filter((m) => m.text === "hello agent");
  assert.equal(afterSync.length, 1, "message persists through chat-sync (no disappearance, no dupe)");
  assert.equal(afterSync[0].id, "S1", "optimistic local id reconciled to the durable server id");
});

test("id-less legacy chat entries render as un-threadable roots (pre-merge session upgrade)", async () => {
  const chrome = await createChromeHarness();

  // A session persisted by the pre-merge server has chat entries without server-assigned ids.
  // After upgrading they must still show in the panel, just as plain un-threadable roots.
  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({
      chat: [
        { role: "user", text: "legacy one", at: 1 },
        { role: "agent", text: "legacy two", at: 2 },
      ],
    }),
  });

  assert.deepEqual(
    chrome.threadingOrdered().map((m) => m.text),
    ["legacy one", "legacy two"],
    "id-less legacy messages are kept in the render set, not dropped",
  );
  const html = chrome.chatLogHtml();
  assert.ok(html.includes("legacy one") && html.includes("legacy two"), "both legacy messages render");
  assert.ok(!html.includes("thread-chip"), "id-less roots have no thread chip");
  assert.ok(!html.includes("reply-button"), "id-less roots expose no reply affordance");
});

test("Send button stays active and still posts while the agent is working (change #2)", async () => {
  const chrome = await createChromeHarness();

  // The agent took the previous batch and is busy: presence flips to "working".
  chrome.eventSource().listeners.get("agent-presence")({ data: JSON.stringify({ state: "working" }) });
  assert.equal(chrome.element("send").disabled, false, "Send button is never grayed out while working");

  // A message typed while "working" is still echoed into the transcript and queued for delivery.
  chrome.element("chatInput").value = "another message";
  chrome.element("send").onclick();
  assert.equal(
    chrome.threadingOrdered().filter((m) => m.text === "another message").length,
    1,
    "message sent while working is echoed into the transcript",
  );
  assert.equal(chrome.queued().length, 1, "message sent while working is queued for delivery");

  // Ending the session is the ONLY thing that closes sending: no later poll can carry a batch.
  chrome.eventSource().listeners.get("ended")({ data: JSON.stringify({ ended_by: "user" }) });
  assert.equal(chrome.element("send").disabled, true, "an ended session disables Send");
  assert.equal(chrome.element("sendAndEnd").disabled, true, "an ended session disables Send & End");
});

test("persisted chat history renders on boot, threads and all", async () => {
  const chrome = await createChromeHarness({
    sessionData: {
      ...defaultSessionData,
      initialChat: [
        { id: "root1", role: "agent", text: "Persisted root", at: 1 },
        { id: "r1", role: "agent", text: "Persisted reply", reply_to: "root1", at: 2 },
        { id: "u1", role: "user", text: "Persisted question", at: 3 },
      ],
    },
  });

  assert.deepEqual(
    chrome.threadingOrdered().map((m) => m.id),
    ["root1", "r1", "u1"],
    "the bootstrapped transcript is the live model, not just markup",
  );
  const html = chrome.chatLogHtml();
  assert.ok(html.includes("Persisted root"), "a persisted root renders");
  assert.ok(html.includes("Persisted question"), "a persisted user message renders");
  assert.ok(!html.includes("Persisted reply"), "a persisted reply collapses into its thread");
  assert.ok(html.includes("thread-chip"), "the persisted thread gets a chip");
  assert.equal(
    chrome.threadingUnread("root1"),
    0,
    "history the user has already had a chance to read is not counted unread",
  );
});

test("the served chrome carries a thread pane the client can open and close", async () => {
  const chrome = await createChromeHarness();

  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({
      chat: [
        { id: "root1", role: "agent", text: "Root message", at: 1 },
        { id: "r1", role: "agent", text: "Threaded reply", reply_to: "root1", at: 2 },
      ],
    }),
  });
  assert.equal(chrome.element("panel").classList.contains("thread-open"), false);

  chrome.threadingOpen("root1");
  assert.equal(chrome.element("panel").classList.contains("thread-open"), true);
  const threadHtml = chrome
    .element("threadChat")
    .children.map((c) => c.innerHTML || "")
    .join("");
  assert.ok(threadHtml.includes("Root message"), "the thread shows its root");
  assert.ok(threadHtml.includes("Threaded reply"), "the thread shows its replies");
  assert.equal(chrome.element("threadTitle").textContent.startsWith("1 reply"), true);

  chrome.element("threadBack").dispatch("click", {});
  assert.equal(chrome.element("panel").classList.contains("thread-open"), false);
  assert.equal(chrome.element("backBadge").hidden, true);
});

test("a docked phone sheet takes the open thread out of reach with the rest of it", async () => {
  const chrome = await createChromeHarness({ mobile: true });

  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({ chat: [{ id: "root1", role: "agent", text: "Root message", at: 1 }] }),
  });
  // Raise the sheet, then open a thread inside it.
  chrome.element("panelHead").dispatch("click", {});
  chrome.threadingOpen("root1");
  assert.equal(chrome.element("body").classList.contains("sheet-open"), true);
  assert.equal(Boolean(chrome.element("threadPane").inert), false, "an open thread on a raised sheet is reachable");

  // Lowering the sheet leaves only the dock on screen: the thread pane goes off-screen with the
  // list and composer, so it must leave the tab order with them.
  chrome.element("panelScrim").dispatch("click", {});
  assert.equal(chrome.element("body").classList.contains("sheet-open"), false);
  assert.equal(chrome.element("threadPane").inert, true, "a docked sheet's thread pane is unreachable");
  assert.equal(Boolean(chrome.element("panelScroll").inert), true);
  assert.equal(Boolean(chrome.element("chatComposer").inert), true);

  // The dock is still the control that raises it again, thread open or not.
  assert.equal(Boolean(chrome.element("panelHead").inert), false, "the dock never leaves the tab order");
  assert.equal(chrome.element("panelToggle")["aria-label"], "Show conversation");
  chrome.element("panelHead").dispatch("click", {});
  assert.equal(chrome.element("body").classList.contains("sheet-open"), true);
  assert.equal(chrome.element("panel").classList.contains("thread-open"), true, "raising the sheet keeps the thread");
  assert.equal(Boolean(chrome.element("threadPane").inert), false);
});

test("formatRelativeTime renders coarse buckets", async () => {
  const { formatRelativeTime } = await threading();
  assert.equal(formatRelativeTime(1000, 1000), "just now");
  assert.equal(formatRelativeTime(0, 30_000), "30s");
  assert.equal(formatRelativeTime(0, 5 * 60_000), "5m");
  assert.equal(formatRelativeTime(0, 3 * 3_600_000), "3h");
  assert.equal(formatRelativeTime(0, 2 * 86_400_000), "2d");
  assert.equal(formatRelativeTime(undefined, 1000), "");
});

test("threadChipLabel pluralizes and appends the last-reply time", async () => {
  const { threadChipLabel } = await threading();
  assert.equal(threadChipLabel(1, 0, 30_000), "1 reply · 30s");
  assert.equal(threadChipLabel(3, 0, 5 * 60_000), "3 replies · 5m");
  assert.equal(threadChipLabel(2, undefined, 0), "2 replies");
});

test("shouldFlagBackBadge is true only for activity outside the open thread", async () => {
  const { shouldFlagBackBadge } = await threading();
  const byId = new Map([
    ["a", msg("a", "root A")],
    ["b", msg("b", "reply to A", "a")],
    ["c", msg("c", "root C")],
  ]);
  assert.equal(shouldFlagBackBadge("a", byId.get("b"), byId), false); // same thread
  assert.equal(shouldFlagBackBadge("a", byId.get("c"), byId), true); // different root
  assert.equal(shouldFlagBackBadge("", byId.get("c"), byId), false); // no thread open
});

test("thread composer posts a reply carrying reply_to", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  // Seed a root via the transcript, open its thread, type a reply, send through the snapshot path.
  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({ chat: [{ id: "root1", role: "agent", text: "Root message", at: 1 }] }),
  });
  chrome.threadingOpen("root1");
  chrome.element("threadInput").value = "A threaded reply";
  chrome.element("threadSend").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();

  const replyPost = posts.find((p) => p.url === "/api/abc/prompts");
  assert.ok(replyPost, "a prompts POST was made");
  assert.equal(replyPost.body.prompts[0].reply_to, "root1");
});

test("incoming reply to the open thread does not flag the Back badge", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({ chat: [{ id: "root1", role: "agent", text: "Root", at: 1 }] }),
  });
  chrome.threadingOpen("root1");
  chrome.eventSource().listeners.get("agent-reply")({
    data: JSON.stringify({ id: "r2", role: "agent", text: "in-thread reply", reply_to: "root1", at: 2 }),
  });
  assert.equal(chrome.element("backBadge").hidden, true);
});

test("incoming activity outside the open thread flags the Back badge", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({ chat: [{ id: "root1", role: "agent", text: "Root", at: 1 }] }),
  });
  chrome.threadingOpen("root1");
  chrome.eventSource().listeners.get("agent-reply")({
    data: JSON.stringify({ id: "root2", role: "agent", text: "a new root", at: 2 }),
  });
  assert.equal(chrome.element("backBadge").hidden, false);
});

test("thread reply targets a specific sub-message when set", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  // Seed a root + a sub-reply via the transcript.
  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({
      chat: [
        { id: "root1", role: "agent", text: "Root message", at: 1 },
        { id: "r2", role: "agent", text: "the reply text", reply_to: "root1", at: 2 },
      ],
    }),
  });
  chrome.threadingOpen("root1");
  // Target the sub-reply instead of the root.
  chrome.threadingReplyTo("r2", "the reply text");
  chrome.element("threadInput").value = "answering r2";
  chrome.element("threadSend").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();

  const replyPost = posts.find((p) => p.url === "/api/abc/prompts");
  assert.ok(replyPost, "a prompts POST was made");
  assert.equal(replyPost.body.prompts[0].reply_to, "r2", "reply_to should target the sub-reply, not the root");
});

test("opening a thread clears any prior reply target", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({ chat: [{ id: "root1", role: "agent", text: "Root", at: 1 }] }),
  });
  chrome.threadingOpen("root1");
  // Set a reply target then re-open the thread — it should be cleared.
  chrome.threadingReplyTo("root1", "Root");
  chrome.threadingOpen("root1");
  assert.equal(chrome.element("threadReplyIndicator").hidden, true);
});

test("formatRelativeTime parses ISO-string timestamps", async () => {
  const { formatRelativeTime } = await threading();
  // Fixed pair: epoch + 30s window.
  assert.equal(formatRelativeTime("1970-01-01T00:00:00.000Z", 30_000), "30s");
  // Non-empty, ends with "m" for a ~5-min-ago ISO string.
  const isoFiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
  const result = formatRelativeTime(isoFiveMinAgo, Date.now());
  assert.ok(result.length > 0, "should return a non-empty string for ISO timestamps");
  assert.ok(result.endsWith("m"), `expected result ending in "m", got "${result}"`);
});

test("a reply-less root renders a Reply affordance wired to open its thread", async () => {
  const chrome = await createChromeHarness();
  const el = chrome.threadingBuildBubble({ id: "r1", role: "agent", text: "hi" }, { reply: "open" });
  assert.ok(el.innerHTML.includes("reply-button"), 'innerHTML should include "reply-button"');
  assert.ok(el.innerHTML.includes('data-reply-id="r1"'), 'innerHTML should include data-reply-id="r1"');
});

test("optimistic (local-) bubbles render no reply affordance for reply:open", async () => {
  const chrome = await createChromeHarness();
  const el = chrome.threadingBuildBubble({ id: "local-7", role: "user", text: "pending" }, { reply: "open" });
  assert.ok(
    !el.innerHTML.includes("reply-button"),
    'optimistic bubble should NOT include "reply-button" for reply:open',
  );
});

test("optimistic (local-) bubbles render no reply affordance for reply:target", async () => {
  const chrome = await createChromeHarness();
  const el = chrome.threadingBuildBubble({ id: "local-7", role: "user", text: "pending" }, { reply: "target" });
  assert.ok(
    !el.innerHTML.includes("reply-button"),
    'optimistic bubble should NOT include "reply-button" for reply:target',
  );
});

test("a durable root still renders its reply affordance", async () => {
  const chrome = await createChromeHarness();
  const el = chrome.threadingBuildBubble({ id: "root1", role: "agent", text: "hi" }, { reply: "open" });
  assert.ok(el.innerHTML.includes("reply-button"), 'durable root should include "reply-button"');
  assert.ok(el.innerHTML.includes('data-reply-id="root1"'), 'durable root should include data-reply-id="root1"');
});

test("unreadReplyCount is the count beyond seen, never negative", async () => {
  const { unreadReplyCount } = await threading();
  const seen = new Map([["a", 2]]);
  assert.equal(unreadReplyCount("a", 3, seen), 1);
  assert.equal(unreadReplyCount("a", 2, seen), 0);
  assert.equal(unreadReplyCount("a", 1, seen), 0); // seen ahead of count → clamp 0
  assert.equal(unreadReplyCount("b", 2, seen), 2); // unseen root → all unread
});

test("threads are read at load baseline, unread on a later reply, read again on open", async () => {
  const chrome = await createChromeHarness();
  const sync = chrome.eventSource().listeners.get("chat-sync");
  // Baseline load: a root with one existing reply.
  sync({
    data: JSON.stringify({
      chat: [
        { id: "root1", role: "agent", text: "Root", at: 1 },
        { id: "r1", role: "agent", text: "first reply", reply_to: "root1", at: 2 },
      ],
    }),
  });
  assert.equal(chrome.threadingUnread("root1"), 0); // existing replies are read at load

  // A new reply arrives into the (closed) thread → unread.
  chrome.eventSource().listeners.get("agent-reply")({
    data: JSON.stringify({ id: "r2", role: "agent", text: "new reply", reply_to: "root1", at: 3 }),
  });
  assert.equal(chrome.threadingUnread("root1"), 1);

  // Opening the thread marks it read.
  chrome.threadingOpen("root1");
  assert.equal(chrome.threadingUnread("root1"), 0);
});

test("a reply into the currently open thread does not become unread", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({ chat: [{ id: "root1", role: "agent", text: "Root", at: 1 }] }),
  });
  chrome.threadingOpen("root1");
  chrome.eventSource().listeners.get("agent-reply")({
    data: JSON.stringify({ id: "r1", role: "agent", text: "in-thread", reply_to: "root1", at: 2 }),
  });
  assert.equal(chrome.threadingUnread("root1"), 0);
});

test("an unread chip renders the unread class, a dot, and an 'N new' label", async () => {
  const chrome = await createChromeHarness();
  const el = chrome.threadingBuildBubble(
    { id: "root1", role: "agent", text: "Root" },
    { chip: "2 new", chipUnread: true },
  );
  assert.match(el.innerHTML, /thread-chip unread/);
  assert.match(el.innerHTML, /class="dot"/);
  assert.match(el.innerHTML, /2 new/);
});

test("a read chip has no unread class and keeps the replies label", async () => {
  const chrome = await createChromeHarness();
  const el = chrome.threadingBuildBubble(
    { id: "root1", role: "agent", text: "Root" },
    { chip: "3 replies · 5m", chipUnread: false },
  );
  assert.doesNotMatch(el.innerHTML, /thread-chip unread/);
  assert.match(el.innerHTML, /3 replies · 5m/);
});

// ── DOM-render order tests ──────────────────────────────────────────────────
// These assert on the rendered #chatLog HTML, not just the read-model, so they
// catch the class of bug where seenReplyCount is mutated AFTER renderChat().

test("on load, existing threads render as READ (no unread chip)", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({
      chat: [
        { id: "root1", role: "agent", text: "Root", at: 1 },
        { id: "r1", role: "agent", text: "first reply", reply_to: "root1", at: 2 },
      ],
    }),
  });
  assert.doesNotMatch(chrome.chatLogHtml(), /thread-chip unread/);
  assert.match(chrome.chatLogHtml(), /1 reply|replies/);
});

test("a reply into a CLOSED thread renders the chip unread", async () => {
  const chrome = await createChromeHarness();
  // Load baseline: root + one existing reply (both become read).
  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({
      chat: [
        { id: "root1", role: "agent", text: "Root", at: 1 },
        { id: "r1", role: "agent", text: "first reply", reply_to: "root1", at: 2 },
      ],
    }),
  });
  // A second reply arrives while no thread is open → must show as unread.
  chrome.eventSource().listeners.get("agent-reply")({
    data: JSON.stringify({ id: "r2", role: "agent", text: "new reply", reply_to: "root1", at: 3 }),
  });
  assert.match(chrome.chatLogHtml(), /thread-chip unread/);
  assert.match(chrome.chatLogHtml(), /1 new/);
});

test("a reply into the OPEN thread does NOT render the chip unread", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({
      chat: [
        { id: "root1", role: "agent", text: "Root", at: 1 },
        { id: "r1", role: "agent", text: "first reply", reply_to: "root1", at: 2 },
      ],
    }),
  });
  chrome.threadingOpen("root1");
  // A new reply arrives into the thread that is currently open → chip stays read.
  chrome.eventSource().listeners.get("agent-reply")({
    data: JSON.stringify({ id: "r2", role: "agent", text: "in-thread", reply_to: "root1", at: 3 }),
  });
  assert.doesNotMatch(chrome.chatLogHtml(), /thread-chip unread/);
});

// ── end DOM-render order tests ──────────────────────────────────────────────

test("opening an unread thread repaints its chip as read in the list", async () => {
  const chrome = await createChromeHarness();
  const sync = chrome.eventSource().listeners.get("chat-sync");

  // Baseline load: root + one existing reply (both become read at load).
  sync({
    data: JSON.stringify({
      chat: [
        { id: "root1", role: "agent", text: "Root", at: 1 },
        { id: "r1", role: "agent", text: "first reply", reply_to: "root1", at: 2 },
      ],
    }),
  });

  // A new reply arrives while no thread is open → chip becomes unread.
  chrome.eventSource().listeners.get("agent-reply")({
    data: JSON.stringify({ id: "r2", role: "agent", text: "new reply", reply_to: "root1", at: 3 }),
  });

  // Precondition: chip is unread before opening.
  assert.match(chrome.chatLogHtml(), /thread-chip unread/, "precondition: chip is unread before opening");

  // Open the thread — marks it seen AND must repaint the list immediately.
  chrome.threadingOpen("root1");

  // Chip should now be read in the rendered list (no re-render event needed).
  assert.doesNotMatch(chrome.chatLogHtml(), /thread-chip unread/, "chip should be read after opening the thread");
});

test("setThreadReplyTarget ignores a local id and post uses the open root id", async () => {
  const posts = [];
  const chrome = await createChromeHarness({
    fetchImpl: async (url, init) => {
      posts.push({ url, body: JSON.parse(init.body) });
      return { ok: true };
    },
  });

  // Seed a root, open its thread.
  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({ chat: [{ id: "root1", role: "agent", text: "Root message", at: 1 }] }),
  });
  chrome.threadingOpen("root1");

  // Attempt to target a local (optimistic) id — should be silently ignored.
  chrome.threadingReplyTo("local-9", "pending message");

  // Send a reply — should fall back to the open root id.
  chrome.element("threadInput").value = "my reply";
  chrome.element("threadSend").onclick();
  chrome.sendFrameMessage({ type: "lavish:snapshot", snapshot: "uid=1 body" });
  await flushPromises();

  const replyPost = posts.find((p) => p.url === "/api/abc/prompts");
  assert.ok(replyPost, "a prompts POST was made");
  // reply_to must be the open root id, NOT "local-9".
  assert.equal(replyPost.body.prompts[0].reply_to, "root1", "reply_to should be the root id, not the local id");
});

// An ended session drops a read-only overlay over the panel and disables the chat composer, but
// the thread composer sits in the same panel behind that overlay. Left enabled it stays in the tab
// order, accepts a reply nobody will ever receive, and swallows Cmd+Enter with no disabled state
// and no message - the one failure mode the ended overlay exists to prevent.
test("ending the session locks the thread composer, not just the chat composer", async () => {
  const chrome = await createChromeHarness();
  chrome.eventSource().listeners.get("chat-sync")({
    data: JSON.stringify({
      chat: [
        { id: "root1", role: "agent", text: "Root message", at: 1 },
        { id: "r1", role: "agent", text: "Threaded reply", reply_to: "root1", at: 2 },
      ],
    }),
  });
  chrome.threadingOpen("root1");
  assert.equal(chrome.element("panel").classList.contains("thread-open"), true);
  assert.equal(Boolean(chrome.element("threadInput").disabled), false);
  assert.equal(Boolean(chrome.element("threadSend").disabled), false);
  assert.equal(Boolean(chrome.element("threadPane").inert), false);

  chrome.eventSource().listeners.get("ended")({ data: JSON.stringify({ ended_by: "agent" }) });

  // The thread stays on screen - the user is still reading it - but nothing in it takes input.
  assert.equal(chrome.element("panel").classList.contains("thread-open"), true);
  assert.equal(chrome.element("threadInput").disabled, true, "the thread input closes with the chat input");
  assert.equal(chrome.element("threadSend").disabled, true, "the thread send button closes with Send");
  assert.equal(chrome.element("threadPane").inert, true, "and the whole pane leaves the tab order");
  assert.equal(chrome.element("chatInput").disabled, true);
  assert.equal(chrome.element("send").disabled, true);
});
