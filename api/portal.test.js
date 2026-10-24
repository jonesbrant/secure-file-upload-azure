"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Readable } = require("node:stream");
const { createApp, createPortal, blockId, BLOCK_SIZE } = require("./portal");

async function fixture(t) {
  let clock = Date.now();
  const documents = new Map(), files = new Map(), messages = [], starts = [], locks = new Set();
  const store = {
    async read(c, n) { return structuredClone(documents.get(`${c}/${n}`) || null); },
    async write(c, n, v) { documents.set(`${c}/${n}`, structuredClone(v)); },
    async remove(c, n) { documents.delete(`${c}/${n}`); files.delete(`${c}/${n}`); },
    async *list(c, prefix = "") {
      for (const [key, value] of [...documents]) {
        if (key.startsWith(`${c}/${prefix}`)) yield { name: key.slice(c.length + 1), value: structuredClone(value) };
      }
    },
    async lock(key, fn) {
      if (locks.has(key)) throw Object.assign(new Error("Busy"), { status: 409 });
      locks.add(key);
      try { return await fn(); } finally { locks.delete(key); }
    }
  };
  const blob = (c, n) => ({
    async stageBlock(id, stream, length) {
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      assert.equal(bytes.length, length);
      let file = files.get(`${c}/${n}`);
      if (!file) { file = { blocks: new Map() }; files.set(`${c}/${n}`, file); }
      file.blocks.set(id, bytes);
    },
    async getBlockList() {
      return { uncommittedBlocks: [...files.get(`${c}/${n}`).blocks].map(([name, bytes]) => ({ name, size: bytes.length })) };
    },
    async commitBlockList(ids) {
      let file = files.get(`${c}/${n}`);
      if (!file) { file = { blocks: new Map() }; files.set(`${c}/${n}`, file); }
      file.data = Buffer.concat(ids.map(id => file.blocks.get(id)));
      file.etag = '"etag-1"';
    },
    async getProperties() {
      const file = files.get(`${c}/${n}`);
      if (!file) throw Object.assign(new Error("Not found"), { statusCode: 404 });
      return { etag: file.etag, contentLength: file.data.length };
    },
    async download() { return { readableStreamBody: Readable.from(files.get(`${c}/${n}`).data) }; }
  });
  const services = { store, blob, sendMail: async (...args) => messages.push(args),
    startScan: async id => starts.push(id), now: () => clock };
  const env = { INTERNAL_ADMIN_EMAILS: "admin@example.com", ALLOWED_ORIGIN: "https://portal.example.com",
    STORAGE_ACCOUNT_NAME: "example", DEFENDER_EVENT_KEY: "test-event-key-not-a-real-secret",
    DEFENDER_TOPIC_ID: "/test-topic" };
  const app = createApp(services, env);
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  async function call(path, method = "GET", body, token, extra = {}) {
    const headers = { ...extra };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    let value;
    try { value = JSON.parse(text); } catch { value = text; }
    return { status: response.status, value, headers: response.headers };
  }
  async function login(address) {
    assert.equal((await call("/api/auth/request", "POST", { email: address })).status, 200);
    const code = messages.at(-1)[2].match(/\b\d{8}\b/)[0];
    const result = await call("/api/auth/verify", "POST", { email: address, code });
    assert.equal(result.status, 200);
    return result.value.token;
  }
  async function setup() {
    const admin = await login("admin@example.com");
    const program = await call("/api/admin/programs", "PUT", { department: "sheriff", name: "Permits",
      retentionDays: 1, recipients: ["staff@example.com"] }, admin);
    assert.equal(program.status, 200);
    const user = await login("public@example.com");
    const staff = await login("staff@example.com");
    return { admin, user, staff, program: program.value };
  }
  async function upload(user, program, data = Buffer.from("clean document")) {
    const init = await call("/api/upload/init", "POST", { department: "sheriff", programId: program.id,
      fileName: "../permit.txt", size: data.length, reference: "PERMIT-42", details: "Please review." }, user);
    assert.equal(init.status, 201);
    const id = init.value.uploadId;
    const count = Math.ceil(data.length / BLOCK_SIZE);
    for (let i = 0; i < count; i++) {
      const response = await fetch(`${base}/api/upload/block?id=${id}&index=${i}`, {
        method: "PUT", headers: { Authorization: `Bearer ${user}` },
        body: data.subarray(i * BLOCK_SIZE, (i + 1) * BLOCK_SIZE)
      });
      assert.equal(response.status, 201);
    }
    assert.equal((await call("/api/upload/complete", "POST", { uploadId: id, blockCount: count }, user)).status, 202);
    return id;
  }
  async function promote(id) {
    const record = await store.read("status", `${id}.json`);
    const file = files.get(`quarantine/${record.blobName}`);
    files.set(`sheriff/${record.blobName}`, file);
    files.delete(`quarantine/${record.blobName}`);
    record.state = "awaiting_defender";
    record.clamavResult = "No threats found";
    await store.write("status", `${id}.json`, record);
    return record;
  }
  async function defender(record, result = "No threats found", etag = "etag-1", secret = env.DEFENDER_EVENT_KEY) {
    return call("/api/events/defender", "POST", [{
      eventType: "Microsoft.Security.MalwareScanningResult", topic: env.DEFENDER_TOPIC_ID,
      data: { blobUri: `https://example.blob.core.windows.net/sheriff/${record.blobName}`,
        eTag: etag, scanResultType: result, scanFinishedTimeUtc: new Date(clock).toISOString() }
    }], null, { "x-defender-key": secret });
  }
  return { call, login, setup, upload, promote, defender, store, files, messages, starts, services, env,
    advance: ms => { clock += ms; } };
}

test("anonymous and cross-origin callers cannot reach protected APIs", async t => {
  const f = await fixture(t);
  assert.equal((await f.call("/api/catalog")).status, 401);
  assert.equal((await f.call("/api/health", "GET", undefined, null, { Origin: "https://evil.example" })).status, 403);
  assert.equal((await f.call("/api/health")).value.version, "2.0.0");
});
test("compressed JSON is rejected before decompression", async t => {
  const f = await fixture(t);
  const result = await f.call("/api/auth/request", "POST", { email: "user@example.com" }, null, { "Content-Encoding": "gzip" });
  assert.equal(result.status, 415);
});
test("OTP is single-use, expires, and locks after five wrong attempts", async t => {
  const f = await fixture(t), address = "user@example.com";
  await f.call("/api/auth/request", "POST", { email: address });
  const code = f.messages.at(-1)[2].match(/\b\d{8}\b/)[0];
  for (let i = 0; i < 5; i++) {
    const wrong = code === "00000000" ? "11111111" : "00000000";
    assert.equal((await f.call("/api/auth/verify", "POST", { email: address, code: wrong })).status, 401);
  }
  assert.equal((await f.call("/api/auth/verify", "POST", { email: address, code })).status, 401);
  const token = await f.login("another@example.com");
  const used = f.messages.at(-1)[2].match(/\b\d{8}\b/)[0];
  assert.equal((await f.call("/api/auth/verify", "POST", { email: "another@example.com", code: used })).status, 401);
  assert.equal((await f.call("/api/auth/logout", "POST", undefined, token)).status, 204);
  assert.equal((await f.call("/api/me", "GET", undefined, token)).status, 401);
  await f.call("/api/auth/request", "POST", { email: "expired@example.com" });
  const expired = f.messages.at(-1)[2].match(/\b\d{8}\b/)[0];
  f.advance(600001);
  assert.equal((await f.call("/api/auth/verify", "POST", { email: "expired@example.com", code: expired })).status, 401);
});
test("OTP resend rate limit and session expiry are enforced", async t => {
  const f = await fixture(t), token = await f.login("person@example.com");
  assert.equal((await f.call("/api/auth/request", "POST", { email: "person@example.com" })).status, 429);
  f.advance(28800001);
  assert.equal((await f.call("/api/me", "GET", undefined, token)).status, 401);
});
test("catalog hides recipients and department admins cannot manage other departments", async t => {
  const f = await fixture(t), { admin, user, program } = await f.setup();
  const catalog = await f.call("/api/catalog", "GET", undefined, user);
  assert.equal(catalog.value.departments[0].programs[0].recipients, undefined);
  assert.equal((await f.call("/api/admin/config", "GET", undefined, user)).status, 403);
  assert.equal((await f.call("/api/admin/departments/sheriff", "PUT", { admins: ["dept@example.com"] }, admin)).status, 204);
  const delegated = await f.login("dept@example.com");
  assert.equal((await f.call("/api/admin/config", "GET", undefined, delegated)).value.departments.length, 1);
  assert.equal((await f.call("/api/admin/programs", "PUT", { ...program, department: "corrections" }, delegated)).status, 403);
});
test("metadata, ownership, upload size, and block count are validated", async t => {
  const f = await fixture(t), { user, program } = await f.setup();
  const bad = { department: "sheriff", programId: program.id, size: 2 ** 31, fileName: "large.zip" };
  assert.equal((await f.call("/api/upload/init", "POST", bad, user)).status, 400);
  assert.equal((await f.call("/api/upload/init", "POST", { ...bad, size: 1, reference: "a".repeat(201) }, user)).status, 400);
  const id = await f.upload(user, program);
  const other = await f.login("other@example.com");
  assert.equal((await f.call(`/api/status?id=${id}`, "GET", undefined, other)).status, 403);
  assert.equal((await f.call("/api/upload/complete", "POST", { uploadId: id, blockCount: 1 }, user)).status, 409);
  const record = await f.store.read("status", `${id}.json`);
  assert.equal(record.fileName, "permit.txt");
  assert.equal(record.reference, "PERMIT-42");
  assert.equal(f.starts.length, 1);
});
test("multi-block upload preserves all bytes and uses deterministic block IDs", async t => {
  const f = await fixture(t), { user, program } = await f.setup();
  const data = Buffer.alloc(BLOCK_SIZE + 7, 67);
  const id = await f.upload(user, program, data);
  const record = await f.store.read("status", `${id}.json`);
  assert.deepEqual(f.files.get(`quarantine/${record.blobName}`).data, data);
  assert.equal(blockId(1), Buffer.from("block-00000001").toString("base64"));
});
test("Defender authentication, ETag gate, notification and delete-on-retrieval", async t => {
  const f = await fixture(t), { user, staff, program } = await f.setup();
  const id = await f.upload(user, program);
  const record = await f.promote(id);
  assert.equal((await f.call(`/api/internal/download/${id}`, "GET", undefined, staff)).status, 409);
  assert.equal((await f.defender(record, "No threats found", "etag-1", "wrong")).status, 401);
  assert.equal((await f.defender(record, "No threats found", "old-etag")).status, 204);
  assert.equal((await f.store.read("status", `${id}.json`)).state, "awaiting_defender");
  assert.equal((await f.defender(record)).status, 204);
  const count = f.messages.length;
  await f.defender(record);
  assert.equal(f.messages.length, count, "Duplicate event must not send duplicate mail.");
  const notice = f.messages.at(-1);
  assert.deepEqual(notice[0], ["staff@example.com"]);
  assert.ok(!notice[2].includes("PERMIT-42"));
  assert.equal((await f.call(`/api/internal/download/${id}`, "GET", undefined, user)).status, 403);
  const download = await f.call(`/api/internal/download/${id}`, "GET", undefined, staff);
  assert.equal(download.status, 200);
  assert.equal(download.value, "clean document");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await f.store.read("status", `${id}.json`)).state, "retrieved");
  assert.ok(!f.files.has(`sheriff/${record.blobName}`));
  assert.equal((await f.store.read("status", `${id}.json`)).details, undefined);
  assert.equal((await f.store.read("status", `${id}.json`)).blobName, undefined);
  assert.equal((await f.call(`/api/internal/download/${id}`, "GET", undefined, staff)).status, 409);
});
test("Defender malware deletes department copy; scan error never releases a file", async t => {
  const f = await fixture(t), { user, staff, program } = await f.setup();
  const id = await f.upload(user, program), record = await f.promote(id);
  await f.defender(record, "Error");
  assert.equal((await f.store.read("status", `${id}.json`)).state, "defender_error");
  assert.equal((await f.call(`/api/internal/download/${id}`, "GET", undefined, staff)).status, 409);
  await f.defender(record, "Malicious");
  assert.equal((await f.store.read("status", `${id}.json`)).state, "infected");
  assert.ok(!f.files.has(`sheriff/${record.blobName}`));
});
test("changed blobs cannot be retrieved even after a clean event", async t => {
  const f = await fixture(t), { user, staff, program } = await f.setup();
  const id = await f.upload(user, program), record = await f.promote(id);
  await f.defender(record);
  f.files.get(`sheriff/${record.blobName}`).etag = '"changed"';
  assert.equal((await f.call(`/api/internal/download/${id}`, "GET", undefined, staff)).status, 409);
});
test("retention is snapshotted and expiry blocks access and purges all payloads", async t => {
  const f = await fixture(t), { user, program } = await f.setup();
  const id = await f.upload(user, program), record = await f.promote(id);
  await f.defender(record);
  f.advance(86400001);
  const result = await createPortal(f.services, f.env).maintenance();
  assert.equal(result.deleted, 1);
  const saved = await f.store.read("status", `${id}.json`);
  assert.equal(saved.state, "expired"); assert.equal(saved.owner, undefined);
  assert.ok(!f.files.has(`sheriff/${record.blobName}`));
});
test("abandoned uploads and worker-expired records are fully purged", async t => {
  const f = await fixture(t), { user, program } = await f.setup();
  const init = await f.call("/api/upload/init", "POST", { department: "sheriff", programId: program.id,
    fileName: "unfinished.txt", size: 100 }, user);
  const record = await f.store.read("status", `${init.value.uploadId}.json`);
  assert.ok(f.files.has(`quarantine/${record.blobName}`));
  record.state = "expired"; // Worker may expire a file before the maintenance job reaches it.
  await f.store.write("status", `${record.uploadId}.json`, record);
  const portal = createPortal(f.services, f.env);
  assert.equal((await portal.maintenance()).deleted, 1);
  const saved = await f.store.read("status", `${record.uploadId}.json`);
  assert.ok(saved.deletedUtc);
  assert.equal(saved.blobName, undefined);
  assert.ok(!f.files.has(`quarantine/${record.blobName}`));
  f.advance(31 * 86400000);
  await portal.maintenance();
  assert.equal(await f.store.read("status", `${record.uploadId}.json`), null);
});
test("departments without programs cannot receive submissions; prototype names are rejected", async t => {
  const f = await fixture(t), user = await f.login("public@example.com");
  for (const department of ["corrections", "__proto__", "constructor"]) {
    assert.equal((await f.call("/api/upload/init", "POST", { department, size: 1 }, user)).status, 400);
  }
});
