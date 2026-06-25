import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { SessionStore } from "../src/session-store.js";

function feedbackResult(result) {
  assert.equal(result.status, "feedback");
  return /** @type {{ status: string, dom_snapshot: string, prompts: any[], layout_warnings?: any[] }} */ (result);
}

test("queued prompts are returned with DOM snapshot context and then cleared", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      prompts: [{ uid: "1", prompt: "Make this warmer", selector: "h1", tag: "h1", text: "Hello" }],
    });

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.dom_snapshot, 'uid=1 h1 "Hello"');
    assert.deepEqual(first.prompts, [
      { uid: "1", prompt: "Make this warmer", selector: "h1", tag: "h1", text: "Hello" },
    ]);

    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queued text selection prompts preserve range anchors", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<p id='intro'>Hello <strong>bright</strong> world</p>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const target = {
      type: "text-range",
      text: "lo bright wo",
      selector: "p#intro",
      start: { selector: "p#intro", path: [0], offset: 3 },
      end: { selector: "p#intro", path: [2], offset: 3 },
    };

    await store.queuePrompts(session.key, {
      prompts: [
        { uid: "", prompt: "Make this phrase punchier", selector: "p#intro", tag: "text", text: target.text, target },
      ],
    });

    const result = feedbackResult(await store.takeFeedback(session.key));
    assert.deepEqual(result.prompts, [
      { uid: "", prompt: "Make this phrase punchier", selector: "p#intro", tag: "text", text: target.text, target },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("layout warnings are returned as feedback and then cleared", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const result = await store.recordLayoutWarnings(session.key, {
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          overflowPx: 24.5,
          viewportWidth: 720,
          severity: "error",
        },
      ],
    });

    assert.equal(result.changed, true);
    assert.equal(result.hasWarnings, true);

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.deepEqual(first.prompts, []);
    assert.deepEqual(first.layout_warnings, [
      {
        selector: "html",
        kind: "page-horizontal-overflow",
        overflowPx: 24.5,
        viewportWidth: 720,
        severity: "error",
      },
    ]);

    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("reopening a session clears stale layout warnings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.recordLayoutWarnings(session.key, {
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          overflowPx: 24,
          viewportWidth: 720,
          severity: "error",
        },
      ],
    });

    const reopened = await store.upsertSession(artifact, "http://localhost:4387/session/test");

    assert.equal(reopened.status, "open");
    assert.deepEqual(reopened.layout_warnings, []);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty layout warning reports clear pending warnings without waking feedback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.recordLayoutWarnings(session.key, {
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          overflowPx: 24,
          viewportWidth: 720,
          severity: "error",
        },
      ],
    });
    const cleared = await store.recordLayoutWarnings(session.key, { layout_warnings: [] });

    assert.equal(cleared.changed, true);
    assert.equal(cleared.hasWarnings, false);
    assert.equal((await store.takeFeedback(session.key)).status, "waiting");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("ending a session makes feedback return ended", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.endSession(session.key);

    const result = await store.takeFeedback(session.key);
    assert.equal(result.status, "ended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("late layout warnings do not reopen ended sessions", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.endSession(session.key);
    await store.recordLayoutWarnings(session.key, {
      layout_warnings: [
        {
          selector: "html",
          kind: "page-horizontal-overflow",
          overflowPx: 24,
          viewportWidth: 720,
          severity: "error",
        },
      ],
    });

    const updated = await store.findByKey(session.key);
    assert.equal(updated.status, "ended");

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.layout_warnings.length, 1);
    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "ended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("prompts queued before ending are still delivered before the ended status", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    // "Send & end session" with no agent listening: prompts land first, then the session ends.
    await store.queuePrompts(session.key, {
      domSnapshot: 'uid=1 h1 "Hello"',
      prompts: [{ uid: "", prompt: "Parting feedback", selector: "", tag: "message", text: "Freeform message" }],
    });
    await store.endSession(session.key);

    const first = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(first.prompts.length, 1);
    assert.equal(first.prompts[0].prompt, "Parting feedback");
    assert.equal(first.dom_snapshot, 'uid=1 h1 "Hello"');

    // Delivering the final batch must not resurrect the session.
    const second = await store.takeFeedback(session.key);
    assert.equal(second.status, "ended");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("agent replies are stored in session chat history", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.addAgentReply(session.key, "Applied the requested changes.");

    const updated = await store.findByKey(session.key);
    assert.deepEqual(
      updated.chat.map((item) => [item.role, item.text]),
      [["agent", "Applied the requested changes."]],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("freeform user prompts are stored in session chat history", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      prompts: [
        { uid: "", prompt: "Please make this clearer", selector: "", tag: "message", text: "Freeform message" },
      ],
    });

    const updated = await store.findByKey(session.key);
    assert.deepEqual(
      updated.chat.map((item) => [item.role, item.text]),
      [["user", "Please make this clearer"]],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent takeFeedback and queuePrompts never drop or duplicate messages (BLOCKER regression)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-race-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");

    const collect = (result, into) => {
      if (result.status === "feedback") {
        for (const prompt of result.prompts) if (prompt.tag === "message") into.push(prompt.prompt);
      }
    };
    const drainAll = async (into) => {
      let next = await store.takeFeedback(session.key);
      while (next.status === "feedback") {
        collect(next, into);
        next = await store.takeFeedback(session.key);
      }
    };

    // Race a stream drain (takeFeedback) against an always-on Send (queuePrompts) many times. The
    // un-serialized read-modify-write loses or duplicates a message in at least one iteration; a
    // serialized store always delivers each message exactly once.
    for (let i = 0; i < 30; i++) {
      await drainAll([]); // clear any residue from a previous iteration
      await store.queuePrompts(session.key, { prompts: [{ tag: "message", prompt: "A" }] });

      const delivered = [];
      const drain = store.takeFeedback(session.key);
      const send = store.queuePrompts(session.key, { prompts: [{ tag: "message", prompt: "B" }] });
      const [drainResult] = await Promise.all([drain, send]);
      collect(drainResult, delivered);
      await drainAll(delivered);

      assert.deepEqual(
        [...delivered].sort(),
        ["A", "B"],
        `iteration ${i}: messages dropped or duplicated -> ${JSON.stringify(delivered)}`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("user and agent messages get stable ids and carry reply_to for threading (change #3)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-thread-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");
    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");

    const { message: agentMessage } = await store.addAgentReply(session.key, "Draft ready");
    assert.ok(typeof agentMessage.id === "string" && agentMessage.id.length > 0);

    await store.queuePrompts(session.key, {
      prompts: [{ tag: "message", prompt: "Tweak the heading", reply_to: agentMessage.id }],
    });
    const updated = await store.findByKey(session.key);
    const userMsg = updated.chat.find((m) => m.role === "user");
    assert.ok(typeof userMsg.id === "string" && userMsg.id.length > 0, "user message has an id");
    assert.equal(userMsg.reply_to, agentMessage.id, "user message threads under the agent message");

    // takeFeedback preserves the reply_to on the delivered prompt.
    const feedback = feedbackResult(await store.takeFeedback(session.key));
    const delivered = feedback.prompts.find((p) => p.tag === "message");
    assert.equal(delivered.reply_to, agentMessage.id);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queuePrompts assigns server-side message ids and ignores caller-supplied ids (MEDIUM regression)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-id-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    // A caller-forged id (and a duplicate of it) must not become the message id: the server owns ids.
    await store.queuePrompts(session.key, {
      prompts: [
        { tag: "message", prompt: "first", id: "forged-1" },
        { tag: "message", prompt: "second", id: "forged-1" },
      ],
    });

    const updated = await store.findByKey(session.key);
    const userMsgs = updated.chat.filter((m) => m.role === "user");
    assert.equal(userMsgs.length, 2);
    for (const msg of userMsgs) {
      assert.notEqual(msg.id, "forged-1", "server ignores the caller-supplied id");
      assert.match(msg.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }
    assert.notEqual(userMsgs[0].id, userMsgs[1].id, "duplicate forged ids resolve to distinct server ids");

    // The delivered prompt carries the same server id as the chat entry.
    const feedback = feedbackResult(await store.takeFeedback(session.key));
    const deliveredIds = feedback.prompts.filter((p) => p.tag === "message").map((p) => p.id);
    assert.deepEqual([...deliveredIds].sort(), [...userMsgs.map((m) => m.id)].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("queuePrompts drops a reply_to that targets no known message (MEDIUM regression)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-reply-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, {
      prompts: [{ tag: "message", prompt: "reply to a ghost", reply_to: "does-not-exist" }],
    });

    const updated = await store.findByKey(session.key);
    const userMsg = updated.chat.find((m) => m.role === "user");
    assert.equal(userMsg.reply_to, undefined, "unknown reply_to is stripped from the chat entry");
    const feedback = feedbackResult(await store.takeFeedback(session.key));
    const delivered = feedback.prompts.find((p) => p.tag === "message");
    assert.equal(delivered.reply_to, undefined, "unknown reply_to is stripped from the delivered prompt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("addAgentReply drops an unknown reply_to but keeps a valid one (MEDIUM regression)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-areply-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    // A user message exists; replying to it threads, replying to a ghost does not.
    await store.queuePrompts(session.key, { prompts: [{ tag: "message", prompt: "the question" }] });
    const afterUser = await store.findByKey(session.key);
    const userId = afterUser.chat.find((m) => m.role === "user").id;

    const ghost = await store.addAgentReply(session.key, "answering nothing", { reply_to: "ghost-id" });
    assert.equal(ghost.message.reply_to, undefined, "unknown reply_to is stripped");

    const threaded = await store.addAgentReply(session.key, "answering the question", { reply_to: userId });
    assert.equal(threaded.message.reply_to, userId, "valid reply_to is preserved");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("requeueFeedback restores an undelivered batch at the front so a dropped stream loses nothing (C1 regression)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-requeue-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    await store.queuePrompts(session.key, { prompts: [{ tag: "message", prompt: "A" }] });

    // The stream took the batch atomically (store now empty), then the client dropped before it was
    // delivered. Meanwhile B was queued. Requeue must restore A ahead of B, losing nothing.
    const taken = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(taken.prompts.find((p) => p.tag === "message").prompt, "A");
    await store.queuePrompts(session.key, { prompts: [{ tag: "message", prompt: "B" }] });
    await store.requeueFeedback(session.key, taken);

    const next = feedbackResult(await store.takeFeedback(session.key));
    assert.deepEqual(
      next.prompts.filter((p) => p.tag === "message").map((p) => p.prompt),
      ["A", "B"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("requeueFeedback restores layout warnings only when none arrived since (C1 regression)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-store-requeue-lw-"));
  try {
    const stateFile = path.join(dir, "state.json");
    const artifact = path.join(dir, "artifact.html");
    await writeFile(artifact, "<h1>Hello</h1>");

    const store = new SessionStore(stateFile);
    const session = await store.upsertSession(artifact, "http://localhost:4387/session/test");
    const warn = (kind) => ({ selector: "html", kind, overflowPx: 1, viewportWidth: 720, severity: "error" });

    // Nothing fresher arrived after the take -> the taken warning is restored.
    await store.recordLayoutWarnings(session.key, { layout_warnings: [warn("overflow-a")] });
    const taken = feedbackResult(await store.takeFeedback(session.key));
    assert.equal(taken.layout_warnings.length, 1);
    await store.requeueFeedback(session.key, taken);
    assert.equal(feedbackResult(await store.takeFeedback(session.key)).layout_warnings[0].kind, "overflow-a");

    // A fresh report arrived after the take -> requeue must NOT clobber it (replace-semantics).
    await store.recordLayoutWarnings(session.key, { layout_warnings: [warn("overflow-old")] });
    const stale = feedbackResult(await store.takeFeedback(session.key));
    await store.recordLayoutWarnings(session.key, { layout_warnings: [warn("overflow-fresh")] });
    await store.requeueFeedback(session.key, stale);
    assert.equal(feedbackResult(await store.takeFeedback(session.key)).layout_warnings[0].kind, "overflow-fresh");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
