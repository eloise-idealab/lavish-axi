import assert from "node:assert/strict";
import test from "node:test";

import { createChromeHarness, flushPromises } from "./helpers/chrome-harness.js";

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

test("groupThreads keeps id-less optimistic messages as roots", async () => {
  const { groupThreads } = await threading();
  const messages = [{ role: "user", text: "pending", at: 1 }];
  const { roots } = groupThreads(messages);
  assert.equal(roots.length, 1);
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
