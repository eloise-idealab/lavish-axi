# Render-ordering fix report — baseline/mark-seen before renderChat

## Summary

Three places in `src/chrome-client.js` mutated `seenReplyCount` AFTER calling
`renderChat()`, so chips were painted with stale seen-state.
All three are now fixed by moving the mutation before the render call.

---

## Per-fix changes

### Fix 1 — `syncChat` (load baseline)

**File:** `src/chrome-client.js`

**Before:**
```js
function syncChat(chat) {
  setMessages(chat);
  renderChat();
  baselineSeenOnce();
```

**After:**
```js
function syncChat(chat) {
  setMessages(chat);
  // baseline BEFORE renderChat so chips paint with correct read-state on load
  baselineSeenOnce();
  renderChat();
```

`setMessages` already populated the model, so `baselineSeenOnce` can safely read
it.
The `seenBaselined` guard makes subsequent syncs a no-op.

---

### Fix 2 — `ingestIncoming` (incoming agent reply)

**Before:**
```js
rememberMessage(message);
renderChat();
if (openThreadRootId) {
  renderThread(openThreadRootId);
  markThreadSeen(openThreadRootId);
  ...
}
```

**After:**
```js
rememberMessage(message);
// Startup-race guard
if (!seenBaselined) seenBaselined = true;
// Mark open thread seen BEFORE renderChat
if (openThreadRootId) markThreadSeen(openThreadRootId);
renderChat();
if (openThreadRootId) {
  renderThread(openThreadRootId);
  if (flagBadge) setBackBadge(true);
}
```

Only the open root is pre-marked; a reply into a closed thread still paints unread.

The startup-race guard (`if (!seenBaselined) seenBaselined = true`) prevents a
later non-empty `chat-sync` from calling `baselineSeenOnce()` and wiping the
unread signal for a live reply the user never opened during a session that started
with an empty initial sync.

---

### Fix 3 — `sendThreadReply` (user sends a threaded reply)

**Before:**
```js
rememberMessage(localMsg);
renderChat();
if (workingBubble) chatLog.appendChild(workingBubble);
renderThread(openThreadRootId);
markThreadSeen(openThreadRootId);
```

**After:**
```js
rememberMessage(localMsg);
// Mark open thread seen BEFORE renderChat so chip paints as read
markThreadSeen(openThreadRootId);
renderChat();
if (workingBubble) chatLog.appendChild(workingBubble);
renderThread(openThreadRootId);
```

---

## TDD — RED / GREEN

### RED (tests written first, before fixes)

```
$ node --test test/chrome-client-threading.test.js
ℹ tests 30
ℹ pass 28
ℹ fail 2

✖ on load, existing threads render as READ (no unread chip)
  AssertionError: input matched /thread-chip unread/ — rendered "1 new" unread chip

✖ a reply into the OPEN thread does NOT render the chip unread
  AssertionError: input matched /thread-chip unread/ — painted chip unread before markThreadSeen ran
```

The third new test ("a reply into a CLOSED thread renders the chip unread") passed
immediately — the closed-thread path was already correct.

### GREEN (after fixes)

```
$ node --test test/chrome-client-threading.test.js
ℹ tests 30
ℹ pass 30
ℹ fail 0
```

Full suite:
```
$ node --test
ℹ tests 271
ℹ pass 271
ℹ fail 0
```

`npm run check` (build + lint + format + typecheck + test + skill check): green.

---

## Harness change — `test/helpers/chrome-harness.js`

The fake DOM element factory was enhanced so the rendered `#chatLog` DOM is
observable from tests:

- Each element now owns a `children: []` array.
- `appendChild(child)` pushes the child into `children` (was: only set `parentElement`).
- `insertBefore(child, ref)` inserts before `ref` if found in `children`, else appends
  (was: only set `parentElement`, ignored `ref`).
- `remove()` detaches the node from its `parent.children` array (was: no-op).
- `querySelectorAll(selector)` handles the exact selector `renderChat` uses to
  clear old bubbles: `".bubble.user,.bubble.agent:not(.agent-working)"`.
  Matches by `className` string; returns an array.
- Harness exposes `chatLogHtml()` → joined `innerHTML` of `chatLog.children`,
  enabling assertions like `assert.match(chrome.chatLogHtml(), /thread-chip unread/)`.

These changes are additive; no existing tests were broken (271/271 green before and after).

---

## Files changed

| File | Change |
|---|---|
| `src/chrome-client.js` | Fix 1: baseline before render in `syncChat`; Fix 2: mark-seen + race-guard before render in `ingestIncoming`; Fix 3: mark-seen before render in `sendThreadReply` |
| `test/helpers/chrome-harness.js` | DOM child-tracking + `querySelectorAll` + `chatLogHtml()` |
| `test/chrome-client-threading.test.js` | 3 new render-order tests |

---

## Concerns

None.
The changes are minimal and surgical; logic inside the affected functions is
otherwise unchanged.
The startup-race guard (`seenBaselined = true` on first live message) is a one-line
low-priority addition that mirrors the intent of `baselineSeenOnce` — it just covers
the edge case where the initial sync was empty.
