import crypto from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

const noop = () => {};

export class SessionStore {
  constructor(file) {
    this.file = file;
    // All sessions live in one JSON file that every operation reads in full, edits, and writes
    // back. Without serialization a stream drain (takeFeedback) and a concurrent always-on Send
    // (queuePrompts) can interleave their read-modify-write windows and drop or duplicate user
    // messages. Chain every file-touching operation through this queue so they run one at a time.
    // The queue is store-global rather than per-session key because the whole file is the unit of
    // read/write — two different keys would still clobber each other's slice on a shared write.
    this.queue = Promise.resolve();
  }

  // Run `operation` with exclusive access to the state file. Operations run in call order; a
  // rejection in one does not break the chain for the next.
  /**
   * @template T
   * @param {() => Promise<T>} operation
   * @returns {Promise<T>}
   */
  withLock(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(noop, noop);
    return result;
  }

  async listSessions() {
    return this.withLock(async () => {
      const state = await this.readState();
      return Object.values(state.sessions).sort((a, b) => a.file.localeCompare(b.file));
    });
  }

  async findByFile(file) {
    return this.withLock(async () => {
      const absolute = await canonicalFile(file);
      const state = await this.readState();
      return state.sessions[sessionKey(absolute)] || null;
    });
  }

  async findByKey(key) {
    return this.withLock(async () => {
      const state = await this.readState();
      return state.sessions[key] || null;
    });
  }

  async upsertSession(file, url) {
    return this.withLock(async () => {
      const absolute = await canonicalFile(file);
      const key = sessionKey(absolute);
      const state = await this.readState();
      const existing = state.sessions[key] || {};
      const existingPrompts = existing.prompts || [];
      const existingStatus = existing.status === "ended" ? "open" : existing.status || "open";
      const session = {
        key,
        file: absolute,
        url,
        status: existingStatus === "feedback" && existingPrompts.length === 0 ? "open" : existingStatus,
        pending_prompts: existing.pending_prompts || 0,
        prompts: existingPrompts,
        layout_warnings: [],
        dom_snapshot: existing.dom_snapshot || "",
        chat: existing.chat || [],
        updated_at: new Date().toISOString(),
      };
      state.sessions[key] = session;
      await this.writeState(state);
      return session;
    });
  }

  async queuePrompts(key, payload) {
    return this.withLock(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const prompts = Array.isArray(payload.prompts) ? payload.prompts : [];
      // Give every message-tagged prompt a stable id (change #3) so the same id appears on the
      // delivered prompt (poll/stream), on the user's chat entry, and as a reply_to target. Mutate
      // in place so the id persists into session.prompts for the agent to read.
      const normalizedPrompts = prompts.map(normalizePrompt).map((prompt) => {
        if (prompt.tag === "message" && prompt.prompt && !prompt.id) prompt.id = newMessageId();
        return prompt;
      });
      const userMessages = normalizedPrompts
        .filter((prompt) => prompt.tag === "message" && prompt.prompt)
        .map((prompt) => ({
          role: "user",
          text: prompt.prompt,
          at: new Date().toISOString(),
          id: prompt.id,
          ...(prompt.reply_to ? { reply_to: prompt.reply_to } : {}),
        }));
      session.prompts = [...(session.prompts || []), ...normalizedPrompts];
      session.chat = [...(session.chat || []), ...userMessages];
      session.pending_prompts = session.prompts.length;
      session.dom_snapshot = String(payload.domSnapshot || payload.dom_snapshot || "");
      session.status = "feedback";
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return session;
    });
  }

  async recordLayoutWarnings(key, payload) {
    return this.withLock(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const layoutWarnings = normalizeLayoutWarnings(payload.layout_warnings || payload.layoutWarnings || []);
      const previousSignature = JSON.stringify(session.layout_warnings || []);
      const nextSignature = JSON.stringify(layoutWarnings);
      if (previousSignature === nextSignature) {
        return { session, changed: false, hasWarnings: layoutWarnings.length > 0 };
      }
      session.layout_warnings = layoutWarnings;
      if (layoutWarnings.length > 0 && session.status !== "ended") {
        session.status = "feedback";
      } else if ((session.prompts || []).length === 0 && session.status !== "ended") {
        session.status = "open";
      }
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return { session, changed: true, hasWarnings: layoutWarnings.length > 0 };
    });
  }

  async takeFeedback(key) {
    return this.withLock(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return { status: "missing" };
      }
      // Prompts queued before the session ended (e.g. "Send & end session") must still reach the
      // agent, so deliver them before reporting the ended state; the next poll then sees ended.
      const prompts = session.prompts || [];
      const layoutWarnings = session.layout_warnings || [];
      if (prompts.length === 0 && layoutWarnings.length === 0) {
        return session.status === "ended" ? { status: "ended" } : { status: "waiting" };
      }
      const result = {
        status: "feedback",
        dom_snapshot: session.dom_snapshot || "",
        prompts,
        ...(layoutWarnings.length > 0 ? { layout_warnings: layoutWarnings } : {}),
      };
      session.prompts = [];
      session.layout_warnings = [];
      session.pending_prompts = 0;
      session.dom_snapshot = "";
      if (session.status !== "ended") {
        session.status = "open";
      }
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return result;
    });
  }

  async endSession(key) {
    return this.withLock(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      session.status = "ended";
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return session;
    });
  }

  async addAgentReply(key, text, options = {}) {
    return this.withLock(async () => {
      const state = await this.readState();
      const session = state.sessions[key];
      if (!session) {
        return null;
      }
      const id = options.id || newMessageId();
      const message = {
        role: "agent",
        text: String(text || ""),
        at: new Date().toISOString(),
        id,
        ...(options.reply_to ? { reply_to: String(options.reply_to) } : {}),
      };
      session.chat = [...(session.chat || []), message];
      session.updated_at = new Date().toISOString();
      await this.writeState(state);
      return { session, message };
    });
  }

  async readState() {
    try {
      const raw = await readFile(this.file, "utf8");
      const parsed = JSON.parse(raw);
      return { sessions: parsed.sessions || {} };
    } catch (error) {
      if (error && error.code === "ENOENT") {
        return { sessions: {} };
      }
      throw error;
    }
  }

  async writeState(state) {
    await writeFile(this.file, `${JSON.stringify(state, null, 2)}\n`);
  }
}

export async function canonicalFile(file) {
  const absolute = path.resolve(file);
  return realpath(absolute);
}

export function sessionKey(file) {
  return crypto.createHash("sha256").update(file).digest("hex").slice(0, 16);
}

function normalizePrompt(prompt) {
  const normalized = {
    uid: String(prompt.uid || ""),
    prompt: String(prompt.prompt || ""),
    selector: String(prompt.selector || ""),
    tag: String(prompt.tag || ""),
    text: String(prompt.text || ""),
  };
  if (prompt.id) normalized.id = String(prompt.id);
  if (prompt.reply_to) normalized.reply_to = String(prompt.reply_to);
  const target = normalizeTarget(prompt.target);
  if (target) normalized.target = target;
  return normalized;
}

export function newMessageId() {
  return crypto.randomUUID();
}

function normalizeLayoutWarnings(layoutWarnings) {
  if (!Array.isArray(layoutWarnings)) return [];
  return layoutWarnings
    .filter((warning) => warning && typeof warning === "object" && !Array.isArray(warning))
    .map((warning) => ({
      selector: String(warning.selector || ""),
      kind: String(warning.kind || "layout-warning"),
      overflowPx: normalizeFiniteNumber(warning.overflowPx),
      viewportWidth: normalizeFiniteNumber(warning.viewportWidth),
      severity: warning.severity === "warning" ? "warning" : "error",
    }));
}

function normalizeFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizeTarget(target) {
  if (!target || typeof target !== "object" || Array.isArray(target)) return null;
  return JSON.parse(JSON.stringify(target));
}
