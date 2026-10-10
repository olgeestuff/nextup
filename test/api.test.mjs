// Run `npm run dev` in one terminal, then `npm test` in another.
// To test a deployed copy: BASE_URL=https://your-app.workers.dev npm test

import test from "node:test";
import assert from "node:assert/strict";

const BASE = (process.env.BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, "");

async function call(path, { method = "GET", body, key } = {}) {
  const headers = {};
  if (body) headers["content-type"] = "application/json";
  if (key) headers.authorization = "Bearer " + key;
  const response = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

async function newQueue(title = "Test queue") {
  const { status, data } = await call("/api/queues", { method: "POST", body: { title } });
  assert.equal(status, 201);
  return data; // { id, ownerKey }
}

const join = (id, name, device, key) => call(`/api/q/${id}/join`, { method: "POST", body: { name, device }, key });
const names = (state) => state.entries.map((entry) => entry.name);
const order = async (id) => names((await call(`/api/q/${id}`)).data.state);

test("creating a queue returns a public id and a private owner key", async () => {
  const { id, ownerKey } = await newQueue("Friday open mic");
  assert.match(id, /^[a-z0-9]{10}$/);
  assert.ok(ownerKey.length >= 32);

  const asVisitor = await call(`/api/q/${id}`);
  assert.equal(asVisitor.status, 200);
  assert.equal(asVisitor.data.owner, false);
  assert.equal(asVisitor.data.state.title, "Friday open mic");
  assert.deepEqual(asVisitor.data.state.entries, []);

  const asOwner = await call(`/api/q/${id}`, { key: ownerKey });
  assert.equal(asOwner.data.owner, true);
});

test("a queue that does not exist answers 404", async () => {
  assert.equal((await call("/api/q/aaaaaaaaaa")).status, 404);
  assert.equal((await call("/api/q/nope")).status, 404);
  assert.equal((await join("aaaaaaaaaa", "Ada", "d1")).status, 404);
});

test("anyone can join, in arrival order, and nothing private is shown", async () => {
  const { id } = await newQueue();
  const ada = await join(id, "Ada", "device-a");
  assert.equal(ada.status, 201);
  assert.ok(ada.data.token);
  await join(id, "Tunde", "device-b");
  await join(id, "Chioma", "device-c");
  assert.deepEqual(await order(id), ["Ada", "Tunde", "Chioma"]);

  const { data } = await call(`/api/q/${id}`);
  const raw = JSON.stringify(data);
  assert.ok(!raw.includes("Hash"), "no hashes in public state");
  assert.ok(!raw.includes("device-a"), "no device ids in public state");
  assert.ok(!raw.includes(ada.data.token), "no entry tokens in public state");
  assert.deepEqual(Object.keys(data.state.entries[0]).sort(), ["at", "id", "name"]);
});

test("one name per spot, one spot per device", async () => {
  const { id } = await newQueue();
  await join(id, "Ada", "device-a");
  assert.equal((await join(id, "  ada ", "device-b")).status, 409, "same name, different case");
  assert.equal((await join(id, "Someone else", "device-a")).status, 409, "same device twice");
  assert.equal((await join(id, "   ", "device-c")).status, 400, "empty name");
  assert.deepEqual(await order(id), ["Ada"]);
});

test("names are cleaned and kept as plain text", async () => {
  const { id } = await newQueue();
  await join(id, "  <img src=x onerror=alert(1)>  ", "d1");
  await join(id, "Line\nbreak\u0000 and​ zero width", "d2");
  await join(id, "x".repeat(200), "d3");
  const list = await order(id);
  assert.equal(list[0], "<img src=x onerror=alert(1)>");
  assert.ok(!/[\n\u0000​]/.test(list[1]));
  assert.equal([...list[2]].length, 40);
});

test("visitors cannot change the order or the queue", async () => {
  const { id } = await newQueue();
  const ada = (await join(id, "Ada", "a")).data;
  const tunde = (await join(id, "Tunde", "b")).data;

  const attempts = [
    ["move", { entryId: tunde.entryId, beforeId: ada.entryId }],
    ["remove", { entryId: ada.entryId }],
    ["settings", { open: false, title: "Hacked" }],
    ["clear", {}],
    ["rotate", {}],
  ];
  for (const [action, body] of attempts) {
    for (const key of [undefined, "wrong-key", tunde.token]) {
      const result = await call(`/api/q/${id}/${action}`, { method: "POST", body, key });
      assert.equal(result.status, 403, `${action} with key ${key}`);
    }
  }
  const { data } = await call(`/api/q/${id}`);
  assert.deepEqual(names(data.state), ["Ada", "Tunde"]);
  assert.equal(data.state.title, "Test queue");
  assert.equal(data.state.open, true);
});

test("the owner can reorder and remove", async () => {
  const { id, ownerKey: key } = await newQueue();
  const ids = {};
  for (const name of ["Ada", "Tunde", "Chioma", "Dayo"]) ids[name] = (await join(id, name, name)).data.entryId;

  const move = (entryId, beforeId) => call(`/api/q/${id}/move`, { method: "POST", body: { entryId, beforeId }, key });

  await move(ids.Dayo, ids.Ada); // to the top
  assert.deepEqual(await order(id), ["Dayo", "Ada", "Tunde", "Chioma"]);
  await move(ids.Dayo, null); // to the end
  assert.deepEqual(await order(id), ["Ada", "Tunde", "Chioma", "Dayo"]);
  await move(ids.Ada, ids.Chioma); // down one... in front of Chioma
  assert.deepEqual(await order(id), ["Tunde", "Ada", "Chioma", "Dayo"]);

  assert.equal((await move(ids.Ada, "missing000")).status, 409, "target left the queue");
  assert.equal((await move("missing000", ids.Ada)).status, 404, "moved name left the queue");

  await call(`/api/q/${id}/remove`, { method: "POST", body: { entryId: ids.Tunde }, key });
  assert.deepEqual(await order(id), ["Ada", "Chioma", "Dayo"]);
});

test("people can leave or rename only their own entry", async () => {
  const { id } = await newQueue();
  const ada = (await join(id, "Ada", "a")).data;
  const tunde = (await join(id, "Tunde", "b")).data;

  const leave = (entryId, token) => call(`/api/q/${id}/leave`, { method: "POST", body: { entryId, token } });
  const rename = (entryId, token, name) => call(`/api/q/${id}/rename`, { method: "POST", body: { entryId, token, name } });

  assert.equal((await leave(ada.entryId, tunde.token)).status, 403);
  assert.equal((await leave(ada.entryId, "")).status, 403);
  assert.equal((await rename(ada.entryId, tunde.token, "Tunde was here")).status, 403);
  assert.equal((await rename(tunde.entryId, tunde.token, "Ada")).status, 409, "cannot take a name in use");

  assert.equal((await rename(tunde.entryId, tunde.token, "Tunde B")).status, 200);
  assert.deepEqual(await order(id), ["Ada", "Tunde B"]);
  assert.equal((await leave(ada.entryId, ada.token)).status, 200);
  assert.deepEqual(await order(id), ["Tunde B"]);

  // The device is free again after leaving.
  assert.equal((await join(id, "Ada again", "a")).status, 201);
});

test("names the owner adds can only be changed by the owner", async () => {
  const { id, ownerKey: key } = await newQueue();
  const added = (await join(id, "Guest", undefined, key)).data;
  assert.equal(added.token, "");
  const tryLeave = await call(`/api/q/${id}/leave`, { method: "POST", body: { entryId: added.entryId, token: "" } });
  assert.equal(tryLeave.status, 403);
  const ownerRename = await call(`/api/q/${id}/rename`, { method: "POST", body: { entryId: added.entryId, name: "Guest speaker" }, key });
  assert.equal(ownerRename.status, 200);
  assert.deepEqual(await order(id), ["Guest speaker"]);
});

test("a closed queue takes no new names except from the owner", async () => {
  const { id, ownerKey: key } = await newQueue();
  await call(`/api/q/${id}/settings`, { method: "POST", body: { open: false }, key });
  assert.equal((await join(id, "Late", "x")).status, 403);
  assert.equal((await join(id, "Added by host", undefined, key)).status, 201);
  await call(`/api/q/${id}/settings`, { method: "POST", body: { open: true, title: "Reopened" }, key });
  assert.equal((await join(id, "Late", "x")).status, 201);
  const { data } = await call(`/api/q/${id}`);
  assert.equal(data.state.title, "Reopened");
  assert.deepEqual(names(data.state), ["Added by host", "Late"]);
});

test("resetting the owner link locks out the old one", async () => {
  const { id, ownerKey: oldKey } = await newQueue();
  const rotated = await call(`/api/q/${id}/rotate`, { method: "POST", body: {}, key: oldKey });
  assert.equal(rotated.status, 200);
  const newKey = rotated.data.ownerKey;
  assert.notEqual(newKey, oldKey);
  assert.equal((await call(`/api/q/${id}`, { key: oldKey })).data.owner, false);
  assert.equal((await call(`/api/q/${id}/clear`, { method: "POST", body: {}, key: oldKey })).status, 403);
  assert.equal((await call(`/api/q/${id}`, { key: newKey })).data.owner, true);
});

test("many people joining at once all get a place, with no ties", async () => {
  const { id, ownerKey: key } = await newQueue();
  const first = (await join(id, "First", "first")).data;
  const results = await Promise.all([
    ...Array.from({ length: 40 }, (_, i) => join(id, `Person ${i + 1}`, `device-${i + 1}`)),
    // The owner reorders while everyone is piling in.
    call(`/api/q/${id}/move`, { method: "POST", body: { entryId: first.entryId, beforeId: null }, key }),
  ]);
  assert.ok(results.every((result) => result.status === 200 || result.status === 201));
  const list = await order(id);
  assert.equal(list.length, 41);
  assert.equal(new Set(list).size, 41, "nobody was lost or duplicated");
});

test("viewers get every change live", async () => {
  const { id, ownerKey: key } = await newQueue();
  const socket = new WebSocket(BASE.replace(/^http/, "ws") + `/api/q/${id}/ws`);
  const seen = [];
  const waiters = [];
  socket.addEventListener("message", (event) => {
    if (event.data === "pong") { seen.push("pong"); }
    else seen.push(JSON.parse(event.data).state);
    waiters.splice(0).forEach((resolve) => resolve());
  });
  const until = async (check) => {
    const deadline = Date.now() + 5000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("timed out waiting for a live update");
      await new Promise((resolve) => { waiters.push(resolve); setTimeout(resolve, 200); });
    }
  };
  const lastState = () => seen.filter((item) => item !== "pong").at(-1);

  await until(() => seen.length === 1);
  assert.deepEqual(lastState().entries, []);

  const ada = (await join(id, "Ada", "a")).data;
  await until(() => lastState().entries.length === 1);
  const tunde = (await join(id, "Tunde", "b")).data;
  await until(() => lastState().entries.length === 2);

  await call(`/api/q/${id}/move`, { method: "POST", body: { entryId: tunde.entryId, beforeId: ada.entryId }, key });
  await until(() => names(lastState())[0] === "Tunde");

  socket.send("ping");
  await until(() => seen.includes("pong"));
  socket.close();
});

test("the same name arriving many times in the same instant gets exactly one spot", async () => {
  const { id } = await newQueue();
  const results = await Promise.all(Array.from({ length: 40 }, (_, i) => join(id, "Ada", `device-${i}`)));
  assert.equal(results.filter((result) => result.status === 201).length, 1);
  assert.equal(results.filter((result) => result.status === 409).length, 39);
  assert.deepEqual(await order(id), ["Ada"]);
});

test("people leaving while the owner reorders remove only their own names", async () => {
  const { id, ownerKey: key } = await newQueue();
  const people = [];
  for (let i = 0; i < 30; i++) people.push({ name: `Person ${i + 1}`, ...(await join(id, `Person ${i + 1}`, `device-${i}`)).data });

  const leavers = people.filter((_, i) => i % 2 === 0);
  const stayers = people.filter((_, i) => i % 2 === 1);
  await Promise.all([
    ...leavers.map((p) => call(`/api/q/${id}/leave`, { method: "POST", body: { entryId: p.entryId, token: p.token } })),
    ...stayers.map((p, i) => call(`/api/q/${id}/move`, {
      method: "POST", key,
      body: { entryId: p.entryId, beforeId: i % 3 === 0 ? null : stayers[(i + 5) % stayers.length].entryId },
    })),
  ]);
  const list = await order(id);
  assert.deepEqual([...list].sort(), stayers.map((p) => p.name).sort(), "exactly the people who stayed are still in line");
});
