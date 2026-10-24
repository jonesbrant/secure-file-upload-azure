"use strict";

const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const express = require("express");

const BLOCK_SIZE = 8 * 1024 * 1024;
const MAX_SCAN_BYTES = 2 * 1024 ** 3 - 1;
const DEPARTMENTS = { sheriff: "Sheriff", "public-health": "Public Health", corrections: "Corrections" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const email = value => String(value || "").trim().toLowerCase();
const validEmail = value => typeof value === "string" && value.length <= 254 && /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(value);
const blockId = index => Buffer.from(`block-${String(index).padStart(8, "0")}`).toString("base64");
const cleanName = name => (String(name || "upload.bin").split(/[\\/]/).pop()
  .replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim() || "upload.bin").slice(0, 200);

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function createPortal(services, env = {}) {
  const { store, blob, sendMail, startScan, now } = services;
  const superAdmins = String(env.INTERNAL_ADMIN_EMAILS || "").split(",").map(email).filter(validEmail);
  const iso = () => new Date(now()).toISOString();
  const config = async department => await store.read("config", `${department}.json`) ||
    { department, admins: [], programs: [] };
  const isAdmin = (user, cfg) => superAdmins.includes(user) || cfg.admins.includes(user);
  const mayRetrieve = (user, cfg, programId) => isAdmin(user, cfg) ||
    Boolean(cfg.programs.find(p => p.id === programId)?.recipients.includes(user));
  const readRecord = id => store.read("status", `${id}.json`);
  const saveRecord = async record => {
    record.updatedUtc = iso();
    await store.write("status", `${record.uploadId}.json`, record);
  };
  const expired = record => !record.expiresUtc || Date.parse(record.expiresUtc) <= now();
  const summary = record => ({
    uploadId: record.uploadId, department: record.department, programId: record.programId,
    fileName: record.fileName, size: record.size, state: record.state, message: record.message,
    reference: record.reference, details: record.details, createdUtc: record.createdUtc,
    expiresUtc: record.expiresUtc, updatedUtc: record.updatedUtc
  });
  async function requireRecord(id) {
    if (!UUID.test(id || "")) fail(400, "Invalid upload ID.");
    const record = await readRecord(id);
    if (!record) fail(404, "Unknown submission.");
    return record;
  }
  async function ownRecord(user, id) {
    const record = await requireRecord(id);
    if (record.owner !== user) fail(403, "This submission belongs to another user.");
    return record;
  }
  async function staffRecord(user, id) {
    const record = await requireRecord(id);
    if (!mayRetrieve(user, await config(record.department), record.programId)) fail(403, "Not authorised for this program.");
    return record;
  }
  async function destroy(record, state) {
    // Never delete a replacement blob: each upload ID is immutable after commit.
    for (const container of ["quarantine", record.department, "infected"]) {
      await store.remove(container, record.blobName);
    }
    record.state = state;
    record.message = state === "retrieved" ? "Retrieved by authorised staff; stored file deleted." : "Retention expired; stored file deleted.";
    record.deletedUtc = iso();
    // Remove submission PII as soon as the file is removed; retain only an audit stub.
    delete record.reference;
    delete record.details;
    delete record.owner;
    delete record.fileName;
    delete record.blobName;
    await saveRecord(record);
  }
  async function notify(record) {
    if (record.notifiedUtc || record.state !== "clean" || expired(record)) return;
    const cfg = await config(record.department);
    const recipients = cfg.programs.find(p => p.id === record.programId)?.recipients || [];
    if (!recipients.length) return;
    await sendMail(recipients, "Secure file submission ready for retrieval",
      `A scanned submission is ready in ${DEPARTMENTS[record.department]}.\n` +
      `Submission ID: ${record.uploadId}\nSign in to the internal portal: ${env.PORTAL_URL || env.ALLOWED_ORIGIN}\n` +
      "Files are deleted after successful retrieval or when retention expires. No file or case details are included in this email.");
    record.notifiedUtc = iso();
    await saveRecord(record);
  }
  async function maintenance() {
    let deleted = 0;
    for await (const { value: item } of store.list("status")) {
      if (!UUID.test(item.uploadId || "")) continue;
      try {
        await store.lock(`upload:${item.uploadId}`, async () => {
          const record = await readRecord(item.uploadId);
          if (!record) return;
          if (["retrieved", "expired"].includes(record.state)) {
            if (!record.deletedUtc) {
              await destroy(record, record.state);
              deleted++;
              return;
            }
            if (Date.parse(record.deletedUtc) + 30 * 86400000 <= now()) {
              await store.remove("status", `${record.uploadId}.json`);
            }
          } else if (expired(record)) {
            await destroy(record, "expired");
            deleted++;
          } else {
            await notify(record);
          }
        });
      } catch (error) {
        console.error("Maintenance item failed", item.uploadId, error.status || "service");
      }
    }
    for await (const { name, value } of store.list("auth")) {
      if (value.expires && value.expires < now() - 86400000) await store.remove("auth", name);
    }
    return { deleted };
  }
  return {
    config, isAdmin, mayRetrieve, summary, requireRecord, ownRecord, staffRecord,
    saveRecord, expired, destroy, notify, maintenance, superAdmins, iso
  };
}

function createApp(services, env = {}) {
  const { store, blob, sendMail, startScan, now } = services;
  const portal = createPortal(services, env);
  const app = express();
  app.disable("x-powered-by");
  const route = handler => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
  app.use((req, res, next) => {
    res.set({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    if (req.headers.origin && req.headers.origin !== env.ALLOWED_ORIGIN) {
      return res.status(403).json({ error: "Origin not permitted." });
    }
    if (req.headers.origin) {
      res.set({
        "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
        Vary: "Origin",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
        "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS"
      });
    }
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });
  // Reject compression: avoids decompression bombs and body-parser's compressed-body advisory.
  app.use(express.json({ limit: "128kb", type: "application/json", inflate: false }));
  app.get("/api/health", (req, res) => res.json({ ok: true, version: "2.0.0" }));

  app.post("/api/auth/request", route(async (req, res) => {
    const address = email(req.body?.email);
    if (!validEmail(address)) fail(400, "Enter a valid email address.");
    // Azure ingress appends the trusted connecting address; do not trust the first forwarded IP.
    const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress).split(",").pop().trim();
    await store.lock(`rate:${ip}`, async () => {
      const key = `rate/${hash(ip)}.json`;
      let rate = await store.read("auth", key);
      if (!rate || rate.expires < now()) rate = { count: 0, expires: now() + 3600000 };
      if (++rate.count > 20) fail(429, "Too many sign-in requests. Try again later.");
      await store.write("auth", key, rate);
    });
    await store.lock(`otp:${address}`, async () => {
      const key = `otp/${hash(address)}.json`;
      const previous = await store.read("auth", key);
      if (previous && previous.sentAt + 60000 > now()) fail(429, "Wait a minute before requesting another code.");
      const count = previous && previous.windowEnds > now() ? previous.count + 1 : 1;
      if (count > 5) fail(429, "Too many codes requested. Try again in one hour.");
      const code = String(crypto.randomInt(10000000, 100000000));
      const salt = crypto.randomBytes(24).toString("hex");
      await store.write("auth", key, {
        salt, digest: hash(salt + code), attempts: 0, sentAt: now(), count,
        windowEnds: previous?.windowEnds > now() ? previous.windowEnds : now() + 3600000,
        expires: now() + 600000
      });
      await sendMail([address], "Your Secure File Intake sign-in code",
        `Your one-time code is ${code}. It expires in 10 minutes and can be used once.\n` +
        "If you did not request this code, ignore this email. Do not share the code.");
    });
    res.json({ message: "A one-time code has been sent. Check your inbox and junk folder." });
  }));
  app.post("/api/auth/verify", route(async (req, res) => {
    const address = email(req.body?.email);
    if (!validEmail(address) || !/^\d{8}$/.test(String(req.body?.code || ""))) fail(400, "Email and eight-digit code are required.");
    const result = await store.lock(`otp:${address}`, async () => {
      const key = `otp/${hash(address)}.json`;
      const challenge = await store.read("auth", key);
      if (!challenge || challenge.expires < now() || challenge.attempts >= 5 || challenge.used) return null;
      challenge.attempts++;
      const good = crypto.timingSafeEqual(Buffer.from(challenge.digest, "hex"),
        Buffer.from(hash(challenge.salt + req.body.code), "hex"));
      challenge.used = good;
      await store.write("auth", key, challenge);
      if (!good) return null;
      const accountKey = `users/${hash(address)}.json`;
      const account = await store.read("auth", accountKey) || { email: address, createdUtc: portal.iso() };
      account.lastVerifiedUtc = portal.iso();
      await store.write("auth", accountKey, account);
      const token = crypto.randomBytes(32).toString("base64url");
      await store.write("auth", `session/${hash(token)}.json`, { email: address, expires: now() + 8 * 3600000 });
      return token;
    });
    if (!result) fail(401, "Code invalid, expired, already used, or attempts exhausted.");
    res.json({ token: result, expiresIn: 28800 });
  }));
  app.post("/api/events/defender", route(async (req, res) => {
    const secret = req.headers["x-defender-key"];
    if (!env.DEFENDER_EVENT_KEY || !secret || !crypto.timingSafeEqual(
      Buffer.from(hash(secret)), Buffer.from(hash(env.DEFENDER_EVENT_KEY)))) fail(401, "Invalid event authentication.");
    if (!Array.isArray(req.body) || req.body.length > 100) fail(400, "Invalid event batch.");
    for (const event of req.body) {
      if (event.eventType === "Microsoft.EventGrid.SubscriptionValidationEvent") {
        return res.json({ validationResponse: event.data.validationCode });
      }
      if (event.eventType !== "Microsoft.Security.MalwareScanningResult" ||
          event.topic?.toLowerCase() !== env.DEFENDER_TOPIC_ID?.toLowerCase()) continue;
      const data = event.data || {};
      const url = new URL(data.blobUri);
      if (url.origin !== `https://${env.STORAGE_ACCOUNT_NAME}.blob.core.windows.net`) continue;
      const [container, ...parts] = decodeURIComponent(url.pathname.slice(1)).split("/");
      if (!Object.hasOwn(DEPARTMENTS, container)) continue;
      const id = parts[1]; // department/programId/uploadId/name within department container
      if (!UUID.test(id || "")) continue;
      await store.lock(`upload:${id}`, async () => {
        const record = await portal.requireRecord(id);
        if (record.department !== container || record.blobName !== parts.join("/") ||
            !["awaiting_defender", "clean", "defender_error"].includes(record.state)) return;
        const stored = blob(container, record.blobName);
        const properties = await stored.getProperties();
        if (String(properties.etag).replaceAll('"', "") !== String(data.eTag).replaceAll('"', "")) return;
        record.defenderEtag = properties.etag;
        record.defenderResult = data.scanResultType;
        record.defenderScannedUtc = data.scanFinishedTimeUtc;
        if (portal.expired(record)) {
          await portal.destroy(record, "expired");
          return;
        }
        if (data.scanResultType === "No threats found") {
          record.state = "clean";
          record.message = "ClamAV and Microsoft Defender found no threats. Ready for authorised retrieval.";
        } else if (data.scanResultType === "Malicious") {
          await store.remove(container, record.blobName);
          record.state = "infected";
          record.message = "Microsoft Defender detected malware. The department copy was deleted.";
        } else {
          record.state = "defender_error";
          record.message = "Defender has not confirmed this file is clean. Retrieval is blocked.";
        }
        await portal.saveRecord(record);
        await portal.notify(record);
      });
    }
    res.sendStatus(204);
  }));

  app.use("/api", (req, res, next) => {
    Promise.resolve().then(async () => {
      const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      const session = token && await store.read("auth", `session/${hash(token)}.json`);
      if (!session || session.expires <= now()) fail(401, "Sign in with a new email code.");
      req.user = session.email;
      req.sessionKey = `session/${hash(token)}.json`;
      next();
    }).catch(next);
  });
  app.post("/api/auth/logout", route(async (req, res) => {
    await store.remove("auth", req.sessionKey);
    res.sendStatus(204);
  }));
  app.get("/api/me", route(async (req, res) => {
    const adminDepartments = [], staffDepartments = [];
    for (const department of Object.keys(DEPARTMENTS)) {
      const cfg = await portal.config(department);
      if (portal.isAdmin(req.user, cfg)) adminDepartments.push(department);
      if (portal.isAdmin(req.user, cfg) || cfg.programs.some(p => p.recipients.includes(req.user))) staffDepartments.push(department);
    }
    res.json({ email: req.user, adminDepartments, staffDepartments, superAdmin: portal.superAdmins.includes(req.user) });
  }));
  app.get("/api/catalog", route(async (req, res) => {
    const departments = [];
    for (const [id, name] of Object.entries(DEPARTMENTS)) {
      const cfg = await portal.config(id);
      departments.push({ id, name, programs: cfg.programs.filter(p => p.active).map(p => ({
        id: p.id, name: p.name, retentionDays: p.retentionDays
      })) });
    }
    res.json({ departments, maxScanBytes: MAX_SCAN_BYTES });
  }));
  app.get("/api/admin/config", route(async (req, res) => {
    const departments = [];
    for (const id of Object.keys(DEPARTMENTS)) {
      const cfg = await portal.config(id);
      if (portal.isAdmin(req.user, cfg)) departments.push(cfg);
    }
    if (!departments.length) fail(403, "Department administrator access is required.");
    res.json({ departments });
  }));
  app.put("/api/admin/departments/:department", route(async (req, res) => {
    const id = req.params.department;
    if (!portal.superAdmins.includes(req.user)) fail(403, "Only a portal administrator can delegate department administration.");
    if (!Object.hasOwn(DEPARTMENTS, id)) fail(400, "Unknown department.");
    const admins = req.body?.admins;
    if (!Array.isArray(admins) || admins.length > 20 || admins.some(a => !validEmail(a))) fail(400, "Provide up to 20 valid administrator emails.");
    await store.lock(`config:${id}`, async () => {
      const cfg = await portal.config(id);
      cfg.admins = [...new Set(admins.map(email))];
      await store.write("config", `${id}.json`, cfg);
    });
    res.sendStatus(204);
  }));
  app.put("/api/admin/programs", route(async (req, res) => {
    const { department, id, name, retentionDays, recipients, active } = req.body || {};
    if (!Object.hasOwn(DEPARTMENTS, department)) fail(400, "Unknown department.");
    if (id && !UUID.test(id)) fail(400, "Invalid program ID.");
    if (typeof name !== "string" || !name.trim() || name.length > 100 ||
        !Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 365 ||
        !Array.isArray(recipients) || recipients.length < 1 || recipients.length > 20 ||
        recipients.some(a => !validEmail(a))) fail(400, "Name, retention (1-365 days), and 1-20 notification recipients are required.");
    const program = await store.lock(`config:${department}`, async () => {
      const cfg = await portal.config(department);
      if (!portal.isAdmin(req.user, cfg)) fail(403, "Not a department administrator.");
      const item = { id: id || crypto.randomUUID(), name: name.trim(), retentionDays,
        recipients: [...new Set(recipients.map(email))], active: active !== false };
      const index = cfg.programs.findIndex(p => p.id === item.id);
      if (id && index < 0) fail(404, "Unknown program.");
      if (index < 0) cfg.programs.push(item); else cfg.programs[index] = item;
      if (cfg.programs.length > 100) fail(400, "Maximum 100 programs per department.");
      await store.write("config", `${department}.json`, cfg);
      return item;
    });
    res.json(program);
  }));
  app.post("/api/upload/init", route(async (req, res) => {
    const { department, programId, fileName, size, reference = "", details = "" } = req.body || {};
    if (!Object.hasOwn(DEPARTMENTS, department)) fail(400, "Choose a department.");
    const cfg = await portal.config(department);
    const program = cfg.programs.find(p => p.id === programId && p.active);
    if (!program) fail(400, "Choose an active program.");
    // Reject files that cannot pass BOTH scanners instead of charging for unusable uploads.
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SCAN_BYTES) fail(400, "Files must be between 1 byte and 2 GiB minus 1 byte.");
    if (typeof reference !== "string" || reference.length > 200 || typeof details !== "string" || details.length > 4000) fail(400, "Reference or additional details exceed the allowed length.");
    const uploadId = crypto.randomUUID();
    const safeName = cleanName(fileName);
    const record = {
      uploadId, owner: req.user, department, programId, fileName: safeName, size,
      blobName: `${programId}/${uploadId}/${safeName}`, reference, details,
      retentionDays: program.retentionDays, createdUtc: portal.iso(),
      expiresUtc: new Date(now() + program.retentionDays * 86400000).toISOString(),
      state: "uploading", message: "Receiving encrypted upload into private intake quarantine."
    };
    await portal.saveRecord(record);
    // A committed placeholder lets deletion remove abandoned uncommitted blocks too.
    await blob("quarantine", record.blobName).commitBlockList([]);
    res.status(201).json({ uploadId });
  }));
  app.put("/api/upload/block", route(async (req, res) => {
    const record = await portal.ownRecord(req.user, req.query.id);
    if (record.state !== "uploading" || portal.expired(record)) fail(409, "Upload is closed.");
    const index = Number(req.query.index);
    if (!Number.isInteger(index) || index < 0 || index >= Math.ceil(record.size / BLOCK_SIZE)) fail(400, "Invalid block index.");
    const expected = Math.min(BLOCK_SIZE, record.size - index * BLOCK_SIZE);
    const length = Number(req.headers["content-length"]);
    if (length !== expected) fail(400, "Block size does not match the declared file size.");
    await blob("quarantine", record.blobName).stageBlock(blockId(index), req, length);
    res.sendStatus(201);
  }));
  app.post("/api/upload/complete", route(async (req, res) => {
    const { uploadId, blockCount } = req.body || {};
    const result = await store.lock(`upload:${uploadId}`, async () => {
      const record = await portal.ownRecord(req.user, uploadId);
      if (portal.expired(record)) fail(410, "Submission expired.");
      if (record.state !== "uploading") fail(409, "Upload has already been committed.");
      const expected = Math.ceil(record.size / BLOCK_SIZE);
      if (blockCount !== expected) fail(400, "Incorrect block count.");
      const source = blob("quarantine", record.blobName);
      const blocks = await source.getBlockList("uncommitted");
      const actual = blocks.uncommittedBlocks || [];
      for (let i = 0; i < expected; i++) {
        const block = actual.find(b => b.name === blockId(i));
        if (!block || block.size !== Math.min(BLOCK_SIZE, record.size - i * BLOCK_SIZE)) fail(400, "Missing or invalid upload block.");
      }
      await source.commitBlockList(Array.from({ length: expected }, (_, i) => blockId(i)), {
        blobHTTPHeaders: { blobContentType: "application/octet-stream" }
      });
      record.state = "queued";
      record.message = "Queued for isolated ClamAV intake scanning.";
      await portal.saveRecord(record);
      try {
        await startScan(uploadId);
      } catch (error) {
        record.state = "error";
        record.message = "Scanner could not start. File remains inaccessible in quarantine.";
        await portal.saveRecord(record);
        throw error;
      }
      return { state: record.state };
    });
    res.status(202).json(result);
  }));
  app.get("/api/status", route(async (req, res) => {
    res.json(portal.summary(await portal.ownRecord(req.user, req.query.id)));
  }));
  app.get("/api/internal/submissions", route(async (req, res) => {
    const records = [];
    const configs = Object.fromEntries(await Promise.all(Object.keys(DEPARTMENTS).map(async id => [id, await portal.config(id)])));
    if (!Object.values(configs).some(cfg => portal.isAdmin(req.user, cfg) || cfg.programs.some(p => p.recipients.includes(req.user)))) fail(403, "Staff access required.");
    for await (const { value: record } of store.list("status")) {
      if (record.programId && configs[record.department] &&
          portal.mayRetrieve(req.user, configs[record.department], record.programId) &&
          !portal.expired(record) && !["retrieved", "expired"].includes(record.state)) {
        records.push(portal.summary(record));
      }
    }
    res.json({ submissions: records.sort((a, b) => b.createdUtc.localeCompare(a.createdUtc)) });
  }));
  app.get("/api/internal/download/:id", route(async (req, res) => {
    await store.lock(`upload:${req.params.id}`, async () => {
      const record = await portal.staffRecord(req.user, req.params.id);
      if (portal.expired(record)) {
        await portal.destroy(record, "expired");
        fail(410, "Retention has expired.");
      }
      if (record.state !== "clean" || record.defenderResult !== "No threats found") fail(409, "Both malware scans must be clean before retrieval.");
      const source = blob(record.department, record.blobName);
      const properties = await source.getProperties();
      if (properties.etag !== record.defenderEtag) fail(409, "File has changed since its Defender scan; retrieval blocked.");
      const response = await source.download(0, undefined, { conditions: { ifMatch: record.defenderEtag } });
      res.set({
        "Content-Type": "application/octet-stream",
        "Content-Length": String(properties.contentLength),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(record.fileName)}`
      });
      // A broken connection throws: retain the file for a safe retry.
      await pipeline(response.readableStreamBody, res);
      record.retrievedBy = req.user;
      await portal.destroy(record, "retrieved");
    });
  }));
  app.use((error, req, res, next) => {
    console.error("Request failed", req.method, req.path, error.status || error.statusCode || "service");
    if (res.headersSent) return next(error);
    res.status(error.status || 503).json({
      error: error.status ? error.message : "A required service is unavailable. Please retry later."
    });
  });
  return app;
}

module.exports = { createApp, createPortal, BLOCK_SIZE, MAX_SCAN_BYTES, blockId };
