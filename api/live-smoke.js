"use strict";

// Administrative integration check run inside the VNet, never an HTTP auth bypass.
// A short-lived test session isolates storage/scanning/retrieval tests from email delivery.
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const { createServices } = require("./services");
const { createPortal } = require("./portal");

async function main() {
  const env = process.env;
  if (!env.SMOKE_API || !env.SMOKE_EMAIL) throw new Error("SMOKE_API and SMOKE_EMAIL are required.");
  const services = createServices(env);
  const { store, blob } = services;
  const token = crypto.randomBytes(32).toString("base64url");
  const sessionKey = `session/${crypto.createHash("sha256").update(token).digest("hex")}.json`;
  const ids = [];
  let program;
  async function call(path, method = "GET", body, authenticated = true) {
    const headers = authenticated ? { Authorization: `Bearer ${token}` } : {};
    if (body !== undefined && !Buffer.isBuffer(body)) headers["Content-Type"] = "application/json";
    const response = await fetch(env.SMOKE_API + path, {
      method, headers, body: Buffer.isBuffer(body) ? body : body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120000)
    });
    return response;
  }
  async function json(path, method, body) {
    const response = await call(path, method, body);
    if (!response.ok) throw new Error(`${method || "GET"} ${path}: ${response.status} ${await response.text()}`);
    return response.json();
  }
  async function upload(bytes, name) {
    const { uploadId } = await json("/api/upload/init", "POST", {
      department: "sheriff", programId: program.id, fileName: name, size: bytes.length,
      reference: "LIVE-VALIDATION", details: "Automated deployment check; no customer data."
    });
    ids.push(uploadId);
    const count = Math.ceil(bytes.length / (8 * 1024 ** 2));
    for (let index = 0; index < count; index++) {
      const chunk = bytes.subarray(index * 8 * 1024 ** 2, (index + 1) * 8 * 1024 ** 2);
      const response = await call(`/api/upload/block?id=${uploadId}&index=${index}`, "PUT", chunk);
      assert.equal(response.status, 201, await response.text());
    }
    await json("/api/upload/complete", "POST", { uploadId, blockCount: count });
    return uploadId;
  }
  async function wait(id, expected) {
    for (let attempt = 0; attempt < 180; attempt++) {
      const record = await store.read("status", `${id}.json`);
      if (record.state === expected && (expected !== "clean" || record.notifiedUtc)) return record;
      if (["error", "defender_error", "infected"].includes(record.state) && record.state !== expected) {
        throw new Error(`Unexpected ${record.state}: ${record.message}`);
      }
      if (attempt % 6 === 0) console.log(`Waiting for ${expected}: ${record.state}`);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    throw new Error(`Timed out waiting for ${expected}`);
  }
  try {
    assert.equal((await call("/api/catalog", "GET", undefined, false)).status, 401);
    await store.write("auth", sessionKey, { email: env.SMOKE_EMAIL.toLowerCase(), expires: Date.now() + 30 * 60000 });
    const me = await json("/api/me");
    assert.ok(me.superAdmin, "SMOKE_EMAIL must be an existing bootstrap admin.");
    program = await json("/api/admin/programs", "PUT", {
      department: "sheriff", name: "Deployment validation (temporary)", retentionDays: 1,
      recipients: [env.SMOKE_EMAIL]
    });
    const payload = Buffer.alloc(9 * 1024 ** 2 + 17, 65);
    const cleanId = await upload(payload, "clean-deployment-check.txt");
    const clean = await wait(cleanId, "clean");
    assert.equal(clean.clamavResult, "No threats found");
    assert.equal(clean.defenderResult, "No threats found");
    assert.ok(clean.defenderEtag);
    assert.ok(clean.notifiedUtc, "Ready notification must be accepted by the email service.");
    const response = await call(`/api/internal/download/${cleanId}`);
    assert.equal(response.status, 200);
    const downloaded = Buffer.from(await response.arrayBuffer());
    assert.equal(crypto.createHash("sha256").update(downloaded).digest("hex"),
      crypto.createHash("sha256").update(payload).digest("hex"));
    for (let attempt = 0; attempt < 10; attempt++) {
      if ((await store.read("status", `${cleanId}.json`)).state === "retrieved") break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal((await store.read("status", `${cleanId}.json`)).state, "retrieved");
    assert.equal(await blob("sheriff", clean.blobName).exists(), false);
    assert.equal((await call(`/api/internal/download/${cleanId}`)).status, 409);
    console.log("PASS clean 9 MiB multi-block upload -> ClamAV -> real Defender event -> email -> exact download -> deletion.");

    const eicar = Buffer.from("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");
    const infectedId = await upload(eicar, "eicar-antivirus-validation.txt");
    const infected = await wait(infectedId, "infected");
    assert.equal(await blob("sheriff", infected.blobName).exists(), false);
    assert.equal((await call(`/api/internal/download/${infectedId}`)).status, 409);
    console.log("PASS harmless EICAR test rejected by ClamAV; never promoted to department.");

    const expiry = await json("/api/upload/init", "POST", {
      department: "sheriff", programId: program.id, fileName: "retention-validation.txt", size: 10
    });
    ids.push(expiry.uploadId);
    const expired = await store.read("status", `${expiry.uploadId}.json`);
    expired.expiresUtc = new Date(Date.now() - 1000).toISOString();
    await store.write("status", `${expiry.uploadId}.json`, expired);
    assert.equal((await call(`/api/internal/download/${expiry.uploadId}`)).status, 410);
    assert.equal(await blob("quarantine", expired.blobName).exists(), false);
    await createPortal(services, env).maintenance();
    console.log("PASS expired submission denied immediately and payload removed; maintenance completed.");
    console.log("LIVE INTEGRATION PASS. Email inbox receipt and OTP verification are tested separately.");
  } finally {
    await store.remove("auth", sessionKey);
    if (program) {
      await store.lock("config:sheriff", async () => {
        const cfg = await store.read("config", "sheriff.json");
        cfg.programs = cfg.programs.filter(p => p.id !== program.id);
        await store.write("config", "sheriff.json", cfg);
      });
    }
    for (const id of ids) {
      try {
        await store.lock(`upload:${id}`, async () => {
          const record = await store.read("status", `${id}.json`);
          if (record?.blobName) {
            for (const container of ["quarantine", "sheriff", "infected"]) await store.remove(container, record.blobName);
          }
          await store.remove("status", `${id}.json`);
        });
      } catch {
        console.log(`Cleanup deferred to scheduled retention for test submission ${id}.`);
      }
    }
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
