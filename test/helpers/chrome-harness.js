import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const sourceUrl = new URL("../../src/chrome-client.js", import.meta.url);

// Deep-convert VM-realm values (Arrays, Maps, plain objects) into host-realm equivalents so that
// assert.deepStrictEqual works across the vm sandbox boundary in tests.
// We cannot use `instanceof Map` across vm realms, so we duck-type using constructor.name.
function toHost(val) {
  if (val === null || val === undefined) return val;
  if (Array.isArray(val)) return Array.from(val, toHost);
  if (typeof val === "object") {
    if (val.constructor && val.constructor.name === "Map") {
      const m = new Map();
      for (const [k, v] of /** @type {Map<unknown, unknown>} */ (val)) m.set(toHost(k), toHost(v));
      return m;
    }
    const o = /** @type {Record<string, unknown>} */ ({});
    for (const k of Object.keys(val)) o[k] = toHost(val[k]);
    return o;
  }
  return val;
}

/** @param {Function} fn */
function wrapVmFn(fn) {
  return /** @type {typeof fn} */ (
    function (...args) {
      return toHost(fn(...args));
    }
  );
}

/** @typedef {{ key: string, file: string, layoutGateEnabled?: boolean, layoutGateMaxHoldMs?: number, modeToggleHotkeyKey?: string }} HarnessSessionData */
/** @type {HarnessSessionData} */
const defaultSessionData = { key: "abc", file: "/tmp/artifact.html", modeToggleHotkeyKey: "i" };

export async function createChromeHarness({
  fetchImpl = async () => ({ ok: true }),
  sessionData = defaultSessionData,
  artifactSrc = "",
} = {}) {
  const source = await readFile(sourceUrl, "utf8");
  const storage = new Map();
  const postedToFrame = [];
  const postedToWhiteboard = [];
  const inlineWhiteboards = [];
  const eventSources = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const elements = new Map();
  const timers = new Map();
  const srcLoads = [];
  let nextTimerId = 1;
  let reloadCount = 0;

  function fakeSetTimeout(fn, ms) {
    const timer = {
      id: nextTimerId++,
      ms,
      fn,
      unref() {},
    };
    timers.set(timer.id, timer);
    return timer;
  }

  function fakeClearTimeout(timer) {
    if (timer && typeof timer === "object") timers.delete(timer.id);
  }

  function runTimers(ms) {
    for (const timer of [...timers.values()]) {
      if (ms !== undefined && timer.ms !== ms) continue;
      timers.delete(timer.id);
      timer.fn();
    }
  }

  function element(id) {
    if (elements.has(id)) return elements.get(id);
    const listeners = new Map();
    const classes = new Set();
    const children = [];
    const el = {
      id,
      hidden: false,
      disabled: false,
      value: "",
      innerHTML: "",
      textContent: "",
      scrollTop: 0,
      scrollHeight: 0,
      scrolledIntoView: null,
      dataset: {},
      onclick: null,
      children,
      get lastElementChild() {
        return children.length ? children[children.length - 1] : null;
      },
      classList: {
        add(...names) {
          for (const name of names) classes.add(name);
        },
        remove(...names) {
          for (const name of names) classes.delete(name);
        },
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : Boolean(force);
          if (enabled) classes.add(name);
          else classes.delete(name);
          return enabled;
        },
        contains(name) {
          return classes.has(name);
        },
        toString() {
          return [...classes].join(" ");
        },
      },
      style: {},
      setAttribute(name, value) {
        this[name] = String(value);
      },
      addEventListener(type, handler) {
        listeners.set(type, handler);
      },
      querySelector(selector) {
        if (selector !== "span") return null;
        const childId = `${id}:span`;
        if (!elements.has(childId)) element(childId);
        return elements.get(childId);
      },
      // Supports the single compound selector renderChat uses to clear old bubbles:
      // ".bubble.user,.bubble.agent:not(.agent-working)"
      querySelectorAll(selector) {
        if (selector === ".bubble.user,.bubble.agent:not(.agent-working)") {
          return children.filter((child) => {
            const cn = String(child.className || "");
            if (!cn.includes("bubble")) return false;
            if (cn.includes("user")) return true;
            return cn.includes("agent") && !cn.includes("agent-working");
          });
        }
        return [];
      },
      appendChild(child) {
        child.parentElement = this;
        this.lastAppendedChild = child;
        children.push(child);
        return child;
      },
      insertBefore(child, ref) {
        child.parentElement = this;
        this.lastAppendedChild = child;
        if (ref) {
          const idx = children.indexOf(ref);
          if (idx !== -1) {
            children.splice(idx, 0, child);
          } else {
            children.push(child);
          }
        } else {
          children.push(child);
        }
        return child;
      },
      remove() {
        const parent = this.parentElement;
        if (parent && parent.children) {
          const idx = parent.children.indexOf(this);
          if (idx !== -1) parent.children.splice(idx, 1);
        }
      },
      click(event = {}) {
        this.clicked = true;
        if (typeof this.onclick === "function") return this.onclick(event);
        return undefined;
      },
      focus() {
        this.focused = true;
      },
      select() {},
      scrollIntoView(options) {
        this.scrolledIntoView = options;
      },
      listeners,
    };
    elements.set(id, el);
    return el;
  }

  element("lavish-session").textContent = JSON.stringify(sessionData);
  const frame = element("artifact");
  frame.dataset.artifactSrc = artifactSrc;
  Object.defineProperty(frame, "src", {
    get() {
      return this.currentSrc || "";
    },
    set(value) {
      this.currentSrc = String(value);
      srcLoads.push({ src: this.currentSrc, hadMessageListener: windowListeners.has("message") });
    },
  });
  frame.contentWindow = {
    postMessage(message) {
      postedToFrame.push(message);
    },
  };
  const whiteboardFrame = element("whiteboardFrame");
  whiteboardFrame.contentWindow = {
    postMessage(message) {
      postedToWhiteboard.push(message);
    },
  };

  const context = {
    clearTimeout: fakeClearTimeout,
    console,
    fetch: fetchImpl,
    location: {
      reload() {
        reloadCount += 1;
      },
    },
    navigator: {},
    setTimeout: fakeSetTimeout,
    URL: {
      createObjectURL() {
        return "blob:lavish-test";
      },
      revokeObjectURL() {},
    },
    __lavishTest: { threading: {} },
    EventSource: class FakeEventSource {
      constructor(url) {
        this.url = url;
        this.listeners = new Map();
        eventSources.push(this);
      }

      addEventListener(type, handler) {
        this.listeners.set(type, handler);
      }
    },
    document: {
      body: element("body"),
      getElementById(id) {
        return element(id);
      },
      addEventListener(type, handler, capture) {
        if (!documentListeners.has(type)) documentListeners.set(type, []);
        documentListeners.get(type).push({ handler, capture: Boolean(capture) });
      },
      createElement(tag) {
        const el = element(`${tag}-${elements.size}`);
        el.tagName = tag.toUpperCase();
        return el;
      },
      execCommand() {
        return true;
      },
    },
    sessionStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
      removeItem(key) {
        storage.delete(key);
      },
    },
    window: {
      addEventListener(type, handler) {
        if (!windowListeners.has(type)) windowListeners.set(type, []);
        windowListeners.get(type).push(handler);
      },
    },
  };

  vm.runInNewContext(source, context, { filename: "chrome-client.js" });

  return {
    element,
    frame,
    postedToFrame,
    postedToWhiteboard,
    eventSource() {
      assert.equal(eventSources.length, 1);
      return eventSources[0];
    },
    createInlineWhiteboard() {
      const posted = [];
      const source = {
        postMessage(message) {
          posted.push(message);
        },
      };
      const whiteboard = { source, posted };
      inlineWhiteboards.push(whiteboard);
      return whiteboard;
    },
    sendFrameMessage(data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      for (const handler of handlers) handler({ source: frame.contentWindow, data });
    },
    sendWhiteboardMessage(data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      for (const handler of handlers) handler({ source: whiteboardFrame.contentWindow, data });
    },
    sendInlineWhiteboardMessage(whiteboard, data) {
      const handlers = windowListeners.get("message") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a message handler");
      for (const handler of handlers) handler({ source: whiteboard.source, data });
    },
    dispatchDocumentKeydown(eventProps) {
      const handlers = documentListeners.get("keydown") || [];
      assert.ok(handlers.length > 0, "chrome-client registered a document keydown handler");
      const event = {
        key: "",
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        isComposing: false,
        defaultPrevented: false,
        ...eventProps,
        preventDefault() {
          this.defaultPrevented = true;
        },
      };
      for (const { handler } of handlers) handler(event);
      return event;
    },
    queued() {
      return JSON.parse(storage.get("lavish-axi:queued:abc") || "[]");
    },
    reloadCount() {
      return reloadCount;
    },
    runTimers,
    srcLoads,
    threading() {
      const raw = context.__lavishTest.threading;
      const wrapped = /** @type {Record<string, Function>} */ ({});
      for (const k of Object.keys(raw)) {
        const v = raw[k];
        wrapped[k] = typeof v === "function" ? wrapVmFn(v) : v;
      }
      return wrapped;
    },
    threadingOpen(id) {
      return context.__lavishTest.openThread(id);
    },
    threadingReplyTo(id, text) {
      return context.__lavishTest.setThreadReplyTarget(id, text);
    },
    threadingBuildBubble(message, opts) {
      return context.__lavishTest.buildBubble(message, opts);
    },
    threadingOrdered() {
      return toHost(context.__lavishTest.orderedMessages());
    },
    threadingUnread(rootId) {
      return context.__lavishTest.threadUnreadCount(rootId);
    },
    // Returns the joined innerHTML of every direct child of #chatLog, so tests
    // can assert on rendered chip markup (e.g. /thread-chip unread/).
    chatLogHtml() {
      return element("chatLog")
        .children.map((c) => c.innerHTML || "")
        .join("");
    },
  };
}

export function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}
