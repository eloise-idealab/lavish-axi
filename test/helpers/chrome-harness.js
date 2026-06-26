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

/** @typedef {{ key: string, file: string, layoutGateEnabled?: boolean, layoutGateMaxHoldMs?: number }} HarnessSessionData */
/** @type {HarnessSessionData} */
const defaultSessionData = { key: "abc", file: "/tmp/artifact.html" };

export async function createChromeHarness({
  fetchImpl = async () => ({ ok: true }),
  sessionData = defaultSessionData,
  artifactSrc = "",
} = {}) {
  const source = await readFile(sourceUrl, "utf8");
  const storage = new Map();
  const postedToFrame = [];
  const eventSources = [];
  const windowListeners = new Map();
  const elements = new Map();
  const timers = new Map();
  const srcLoads = [];
  let nextTimerId = 1;

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
    const el = {
      id,
      hidden: false,
      disabled: false,
      value: "",
      innerHTML: "",
      textContent: "",
      scrollTop: 0,
      scrollHeight: 0,
      dataset: {},
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
      querySelector() {
        return null;
      },
      querySelectorAll() {
        return [];
      },
      appendChild(child) {
        child.parentElement = this;
        return child;
      },
      insertBefore(child) {
        child.parentElement = this;
        return child;
      },
      remove() {},
      focus() {
        this.focused = true;
      },
      select() {},
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

  const context = {
    clearTimeout: fakeClearTimeout,
    console,
    fetch: fetchImpl,
    location: { reload() {} },
    navigator: {},
    setTimeout: fakeSetTimeout,
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
      addEventListener() {},
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
        windowListeners.set(type, handler);
      },
    },
  };

  vm.runInNewContext(source, context, { filename: "chrome-client.js" });

  return {
    element,
    frame,
    postedToFrame,
    eventSource() {
      assert.equal(eventSources.length, 1);
      return eventSources[0];
    },
    sendFrameMessage(data) {
      const handler = windowListeners.get("message");
      assert.ok(handler, "chrome-client registered a message handler");
      handler({ source: frame.contentWindow, data });
    },
    queued() {
      return JSON.parse(storage.get("lavish-axi:queued:abc") || "[]");
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
  };
}

export function flushPromises() {
  return new Promise((resolve) => setImmediate(resolve));
}
