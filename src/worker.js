/**
 * NextUp: a shared queue anyone can join by link. One owner controls the order.
 *
 * How ownership works
 * -------------------
 * Creating a queue returns two secrets-by-URL:
 *   - the queue id      -> public link. Anyone with it can see the order and add a name.
 *   - the owner key     -> owner link. Whoever holds it can reorder, remove, close, clear.
 * Only a SHA-256 hash of the owner key is stored, so the server cannot leak it.
 * Each person who joins also gets a private token for their own entry, so they can
 * leave or fix their own name, and nobody else's.
 *
 * Why the order cannot be corrupted
 * ---------------------------------
 * Every queue is one Durable Object: a single place that decides "who was first",
 * so there are no ties. Inside it, every action does its slow work first (reading
 * the request, hashing keys) and then checks and changes the list in one unbroken
 * step, so two requests can never act on a half-updated list. Reordering is sent as
 * "move entry X in front of entry Y" rather than "replace the whole list", so a
 * reorder never wipes out someone who joined a moment earlier.
 */

import { DurableObject } from "cloudflare:workers";
import html from "../public/index.html";

// ---- Settings you can change ------------------------------------------------
const MAX_ENTRIES = 300; // most names one queue will hold
const MAX_NAME_LENGTH = 40;
const MAX_TITLE_LENGTH = 60;
const MAX_VIEWERS = 5000; // live connections per queue
const EXPIRY_DAYS = 30; // a queue is deleted after this many days without changes
// -----------------------------------------------------------------------------

const EXPIRY_MS = EXPIRY_DAYS * 24 * 60 * 60 * 1000;
const ID_LENGTH = 10;
const ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // no look-alikes (i, l, o, 0, 1)
const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
const ID_PATTERN = new RegExp(`^[${ID_ALPHABET}]{${ID_LENGTH}}$`);

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-cache",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
};

// ---- Small helpers ----------------------------------------------------------

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

function fail(status, message, extra = {}) {
  return json({ error: message, ...extra }, status);
}

/** Random string with no modulo bias. */
function randomString(length, alphabet) {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(length * 2))) {
      if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
    }
  }
  return out;
}

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameString(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Trim, collapse spaces, drop control and invisible characters, cap the length. */
function cleanText(value, maxLength) {
  if (typeof value !== "string") return "";
  const cleaned = value
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return [...cleaned].slice(0, maxLength).join("").trim();
}

/** Two names clash if they look the same ignoring case and spacing. */
function nameKey(name) {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

async function readBody(request) {
  const text = await request.text();
  if (text.length > 4000) throw new Error("Request too large.");
  if (!text) return {};
  const body = JSON.parse(text);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Bad request.");
  return body;
}

function bearer(request) {
  const header = request.headers.get("authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

// ---- Entry point ------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/queues") {
      if (request.method !== "POST") return fail(405, "Method not allowed.");
      return createQueue(request, env);
    }

    const match = path.match(/^\/api\/q\/([a-z0-9]+)(?:\/([a-z]+))?$/);
    if (match) {
      if (!ID_PATTERN.test(match[1])) return fail(404, "This queue does not exist or has expired.");
      const stub = env.QUEUE.get(env.QUEUE.idFromName(match[1]));
      return stub.fetch(request);
    }
    if (path.startsWith("/api/")) return fail(404, "Not found.");

    if (request.method === "GET" || request.method === "HEAD") {
      if (path === "/" || /^\/q\/[a-z0-9]+\/?$/.test(path)) {
        return new Response(request.method === "HEAD" ? null : html, { headers: HTML_HEADERS });
      }
    }
    return new Response("Not found", { status: 404 });
  },
};

async function createQueue(request, env) {
  let body;
  try {
    body = await readBody(request);
  } catch {
    return fail(400, "Bad request.");
  }
  const title = cleanText(body.title, MAX_TITLE_LENGTH) || "Queue";
  const ownerKey = randomString(32, KEY_ALPHABET);
  const ownerHash = await sha256(ownerKey);

  // Ids are random; on the tiny chance one is taken, pick another.
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = randomString(ID_LENGTH, ID_ALPHABET);
    const stub = env.QUEUE.get(env.QUEUE.idFromName(id));
    if (await stub.init({ id, title, ownerHash })) return json({ id, ownerKey }, 201);
  }
  return fail(503, "Could not create a queue. Try again.");
}

// ---- One queue --------------------------------------------------------------

export class Queue extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.queue = null;
    // Nothing else runs until the saved queue has been read.
    ctx.blockConcurrencyWhile(async () => {
      this.queue = (await ctx.storage.get("queue")) ?? null;
    });
    // Keep-alive pings are answered without waking the queue.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  /** Persist a change, push the new order to everyone watching, restart the expiry clock. */
  async commit() {
    this.queue.version += 1;
    this.queue.updatedAt = Date.now();
    await this.ctx.storage.put("queue", this.queue);
    await this.ctx.storage.setAlarm(Date.now() + EXPIRY_MS);
    if (this.queue) this.broadcast();
  }

  /** What everyone is allowed to see. Never includes hashes or device ids. */
  view() {
    const q = this.queue;
    return {
      id: q.id,
      title: q.title,
      open: q.open,
      version: q.version,
      updatedAt: q.updatedAt,
      limit: MAX_ENTRIES,
      entries: q.entries.map((e) => ({ id: e.id, name: e.name, at: e.at })),
    };
  }

  broadcast() {
    const message = JSON.stringify({ type: "state", state: this.view() });
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        // socket already gone
      }
    }
  }

  /** Called once by the Worker when a queue is created. Returns false if the id is taken. */
  async init({ id, title, ownerHash }) {
    if (this.queue) return false;
    const now = Date.now();
    this.queue = { id, title, open: true, version: 0, createdAt: now, updatedAt: now, ownerHash, entries: [] };
    await this.ctx.storage.put("queue", this.queue);
    await this.ctx.storage.setAlarm(now + EXPIRY_MS);
    return true;
  }

  async isOwner(request) {
    const key = bearer(request);
    if (!key) return false;
    const hash = await sha256(key);
    return this.queue !== null && sameString(hash, this.queue.ownerHash);
  }

  nameTaken(name, exceptId) {
    const key = nameKey(name);
    return this.queue.entries.some((e) => e.id !== exceptId && nameKey(e.name) === key);
  }

  async fetch(request) {
    if (!this.queue) return fail(404, "This queue does not exist or has expired.");

    const action = new URL(request.url).pathname.split("/")[4] || "";

    if (request.method === "GET") {
      if (action === "") {
        const owner = await this.isOwner(request);
        if (!this.queue) return fail(404, "This queue does not exist or has expired.");
        return json({ state: this.view(), owner });
      }
      if (action === "ws") return this.openSocket(request);
      return fail(404, "Not found.");
    }
    if (request.method !== "POST") return fail(405, "Method not allowed.");

    // Slow work first: read the request and hash any keys it carries.
    let body;
    try {
      body = await readBody(request);
    } catch {
      return fail(400, "Bad request.");
    }
    const keyHash = bearer(request) ? await sha256(bearer(request)) : "";
    const tokenHash = typeof body.token === "string" && body.token ? await sha256(body.token) : "";
    const newSecret = randomString(action === "rotate" ? 32 : 24, KEY_ALPHABET);
    const newSecretHash = await sha256(newSecret);

    // From here to the end of the action nothing waits, so the check and the
    // change happen as one step. (A queue can expire during the slow work.)
    const q = this.queue;
    if (!q) return fail(404, "This queue does not exist or has expired.");
    const owner = keyHash !== "" && sameString(keyHash, q.ownerHash);
    let result;

    switch (action) {
      // ---- Anyone with the link ----
      case "join":
        result = this.join(body, owner, newSecret, newSecretHash);
        break;
      case "leave":
        result = this.leave(body, owner, tokenHash);
        break;
      case "rename":
        result = this.rename(body, owner, tokenHash);
        break;

      // ---- Owner only ----
      case "move":
      case "remove":
      case "settings":
      case "clear":
        if (!owner) return fail(403, "Only the queue owner can do that.");
        result = this[action](body);
        break;
      case "rotate":
        if (!owner) return fail(403, "Only the queue owner can do that.");
        result = this.rotate(newSecret, newSecretHash);
        break;

      default:
        return fail(404, "Not found.");
    }

    if (result.changed) await this.commit();
    const { status = 200, error, changed, ...extra } = result;
    return error ? fail(status, error, extra) : json({ ...extra, state: this.view() }, status);
  }

  openSocket(request) {
    if (request.headers.get("upgrade") !== "websocket") return fail(426, "Expected a WebSocket.");
    if (this.ctx.getWebSockets().length >= MAX_VIEWERS) return fail(503, "Too many people are watching this queue.");
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].send(JSON.stringify({ type: "state", state: this.view() }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  // Viewers only listen. Anything they send (other than the auto-answered ping) ends the connection.
  webSocketMessage(socket) {
    try {
      socket.close(4008, "This connection is read-only.");
    } catch {}
  }

  webSocketClose(socket) {
    try {
      socket.close(1000, "Closed.");
    } catch {}
  }

  webSocketError(socket) {
    try {
      socket.close(1000, "Closed.");
    } catch {}
  }

  /** Nothing changed for EXPIRY_DAYS: delete the queue. */
  async alarm() {
    // Changed recently after all? Keep it and check again later.
    const idle = this.queue ? Date.now() - this.queue.updatedAt : EXPIRY_MS;
    if (idle < EXPIRY_MS - 60_000) {
      await this.ctx.storage.setAlarm(this.queue.updatedAt + EXPIRY_MS);
      return;
    }
    for (const socket of this.ctx.getWebSockets()) {
      try {
        socket.close(4001, "Queue expired.");
      } catch {}
    }
    await this.ctx.storage.deleteAll();
    this.queue = null;
  }

  // ---- Actions --------------------------------------------------------------
  // Each one runs without waiting and returns what happened:
  //   { changed }            the list was (or was not) altered
  //   { error, status }      refused, with the reason
  // Anything else in the result is sent back to the caller.

  /** May this request change this one entry? The owner always may; otherwise the entry's own token is needed. */
  mayEdit(entry, owner, tokenHash) {
    return owner || (entry.tokenHash !== "" && tokenHash !== "" && sameString(tokenHash, entry.tokenHash));
  }

  // ---- Anyone with the link ----

  /** Add a name at the end of the line. The owner can add names for other people. */
  join(body, owner, token, tokenHash) {
    const q = this.queue;
    if (!owner && !q.open) return { status: 403, error: "This queue is closed to new names." };
    if (q.entries.length >= MAX_ENTRIES) return { status: 409, error: `This queue is full (${MAX_ENTRIES} names).` };

    const name = cleanText(body.name, MAX_NAME_LENGTH);
    if (!name) return { status: 400, error: "Enter a name." };
    if (this.nameTaken(name)) {
      return { status: 409, error: `"${name}" is already in the queue. Add an initial to tell you apart.` };
    }

    const device = owner ? "" : cleanText(body.device, 64);
    if (device && q.entries.some((e) => e.device === device)) {
      return { status: 409, error: "You are already in this queue." };
    }

    // Names the owner adds carry no personal token: only the owner manages them.
    const entry = {
      id: randomString(8, ID_ALPHABET),
      name,
      at: Date.now(),
      tokenHash: owner ? "" : tokenHash,
      device,
    };
    q.entries.push(entry);
    return { changed: true, status: 201, entryId: entry.id, token: owner ? "" : token };
  }

  leave(body, owner, tokenHash) {
    const q = this.queue;
    const index = q.entries.findIndex((e) => e.id === body.entryId);
    if (index === -1) return { changed: false }; // already gone
    if (!this.mayEdit(q.entries[index], owner, tokenHash)) return { status: 403, error: "You can only remove your own name." };
    q.entries.splice(index, 1);
    return { changed: true };
  }

  rename(body, owner, tokenHash) {
    const entry = this.queue.entries.find((e) => e.id === body.entryId);
    if (!entry) return { status: 404, error: "That name is no longer in the queue.", state: this.view() };
    if (!this.mayEdit(entry, owner, tokenHash)) return { status: 403, error: "You can only change your own name." };

    const name = cleanText(body.name, MAX_NAME_LENGTH);
    if (!name) return { status: 400, error: "Enter a name." };
    if (this.nameTaken(name, entry.id)) return { status: 409, error: `"${name}" is already in the queue.` };
    if (name === entry.name) return { changed: false };
    entry.name = name;
    return { changed: true };
  }

  // ---- Owner only ----

  /** Move one entry directly in front of another (beforeId), or to the end (beforeId: null). */
  move(body) {
    const q = this.queue;
    const from = q.entries.findIndex((e) => e.id === body.entryId);
    if (from === -1) return { status: 404, error: "That name is no longer in the queue.", state: this.view() };
    if (body.beforeId === body.entryId) return { changed: false };

    const beforeId = body.beforeId ?? null;
    if (beforeId !== null && !q.entries.some((e) => e.id === beforeId)) {
      return { status: 409, error: "The queue changed while you were moving. Try again.", state: this.view() };
    }

    const [entry] = q.entries.splice(from, 1);
    const to = beforeId === null ? q.entries.length : q.entries.findIndex((e) => e.id === beforeId);
    q.entries.splice(to, 0, entry);
    return { changed: to !== from };
  }

  remove(body) {
    const q = this.queue;
    const index = q.entries.findIndex((e) => e.id === body.entryId);
    if (index === -1) return { changed: false };
    q.entries.splice(index, 1);
    return { changed: true };
  }

  settings(body) {
    const q = this.queue;
    let title = q.title;
    if (typeof body.title === "string") {
      title = cleanText(body.title, MAX_TITLE_LENGTH);
      if (!title) return { status: 400, error: "Enter a name for the queue." };
    }
    const open = typeof body.open === "boolean" ? body.open : q.open;
    const changed = title !== q.title || open !== q.open;
    q.title = title;
    q.open = open;
    return { changed };
  }

  clear() {
    const changed = this.queue.entries.length > 0;
    this.queue.entries = [];
    return { changed };
  }

  /** Replace the owner key. Every old owner link stops working immediately. */
  rotate(ownerKey, ownerHash) {
    this.queue.ownerHash = ownerHash;
    return { changed: true, ownerKey };
  }
}
