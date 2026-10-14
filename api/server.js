"use strict";

/**
 * Upload broker.
 *
 * Storage is locked down by policy (no shared keys, no public network access),
 * so the browser cannot write to blob storage directly. This API sits inside the
 * VNet, authenticates with a managed identity, and stages each client chunk as a
 * block against the quarantine blob. Bytes are streamed straight through, so
 * memory use stays flat regardless of file size.
 */

const crypto = require("crypto");
const express = require("express");
const { DefaultAzureCredential } = require("@azure/identity");
const { BlobServiceClient } = require("@azure/storage-blob");

const PORT = process.env.PORT || 8080;
const ACCOUNT = process.env.STORAGE_ACCOUNT_NAME;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const SCAN_JOB_ID = process.env.SCAN_JOB_ID;
const SCANNER_IMAGE = process.env.SCANNER_IMAGE;
const IDENTITY_CLIENT_ID = process.env.AZURE_CLIENT_ID;

const QUARANTINE_CONTAINER = "quarantine";
const STATUS_CONTAINER = "status";

const DEPARTMENTS = {
  "sheriff": "Sheriff",
  "public-health": "Public Health",
  "corrections": "Corrections"
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const credential = new DefaultAzureCredential(
  IDENTITY_CLIENT_ID ? { managedIdentityClientId: IDENTITY_CLIENT_ID } : {}
);
const blobService = new BlobServiceClient(
  `https://${ACCOUNT}.blob.core.windows.net`,
  credential
);

const statusContainer = blobService.getContainerClient(STATUS_CONTAINER);
const quarantineContainer = blobService.getContainerClient(QUARANTINE_CONTAINER);

/** Strip path separators and control characters from a user-supplied file name. */
function sanitizeFileName(name) {
  const base = String(name || "upload.bin").split(/[\\/]/).pop();
  const safe = base.replace(/[\u0000-\u001f<>:"|?*]/g, "_").trim();
  return (safe || "upload.bin").slice(0, 200);
}

function blockId(index) {
  return Buffer.from(`block-${String(index).padStart(8, "0")}`).toString("base64");
}

async function readRecord(uploadId) {
  const client = statusContainer.getBlockBlobClient(`${uploadId}.json`);
  if (!(await client.exists())) return null;
  return JSON.parse((await client.downloadToBuffer()).toString("utf8"));
}

async function writeRecord(record) {
  const body = JSON.stringify(record);
  await statusContainer
    .getBlockBlobClient(`${record.uploadId}.json`)
    .upload(body, Buffer.byteLength(body), {
      blobHTTPHeaders: { blobContentType: "application/json" }
    });
}

/** Launch one isolated scan container for this upload. */
async function startScanJob(uploadId) {
  if (!SCAN_JOB_ID) throw new Error("SCAN_JOB_ID is not configured.");

  const token = await credential.getToken("https://management.azure.com/.default");
  const url = `https://management.azure.com${SCAN_JOB_ID}/start?api-version=2024-03-01`;

  const body = {
    containers: [
      {
        name: process.env.SCAN_CONTAINER_NAME || "job-clamav-scan",
        image: SCANNER_IMAGE,
        resources: { cpu: 2, memory: "4Gi" },
        env: [
          { name: "UPLOAD_ID", value: uploadId },
          { name: "STORAGE_ACCOUNT_NAME", value: ACCOUNT },
          { name: "AZURE_CLIENT_ID", value: IDENTITY_CLIENT_ID }
        ]
      }
    ]
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token.token}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    throw new Error(`job start failed: ${res.status} ${await res.text()}`);
  }
}

const app = express();
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.set("Access-Control-Allow-Headers", "Content-Type");
  res.set("Access-Control-Allow-Methods", "GET,POST,PUT,OPTIONS");
  res.set("Access-Control-Max-Age", "3600");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/api/health", (req, res) => res.json({ ok: true, account: ACCOUNT }));

app.post("/api/upload/init", express.json(), async (req, res) => {
  try {
    const { department, fileName, size } = req.body || {};
    if (!department || !(department in DEPARTMENTS)) {
      return res.status(400).json({ error: "A valid department is required." });
    }

    const uploadId = crypto.randomUUID();
    const safeName = sanitizeFileName(fileName);
    const record = {
      uploadId,
      department,
      departmentName: DEPARTMENTS[department],
      fileName: safeName,
      size: Number(size) || 0,
      blobName: `${department}/${uploadId}/${safeName}`,
      state: "uploading",
      message: "Receiving file.",
      updatedUtc: new Date().toISOString()
    };
    await writeRecord(record);

    res.json({ uploadId, blobName: record.blobName });
  } catch (err) {
    console.error("init failed", err);
    res.status(500).json({ error: err.message });
  }
});

// Raw chunk body is streamed to storage, never buffered in the API.
app.put("/api/upload/block", async (req, res) => {
  try {
    const { id, index } = req.query;
    if (!UUID_RE.test(id || "")) return res.status(400).json({ error: "Invalid id." });

    const blockIndex = Number(index);
    if (!Number.isInteger(blockIndex) || blockIndex < 0 || blockIndex > 49999) {
      return res.status(400).json({ error: "Invalid block index." });
    }

    const length = Number(req.headers["content-length"]);
    if (!Number.isInteger(length) || length <= 0) {
      return res.status(411).json({ error: "Content-Length is required." });
    }

    const record = await readRecord(id);
    if (!record) return res.status(404).json({ error: "Unknown upload." });
    if (record.state !== "uploading") {
      return res.status(409).json({ error: "Upload is already finalised." });
    }

    await quarantineContainer
      .getBlockBlobClient(record.blobName)
      .stageBlock(blockId(blockIndex), req, length);

    res.sendStatus(201);
  } catch (err) {
    console.error("block failed", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/upload/complete", express.json(), async (req, res) => {
  try {
    const { uploadId, blockCount, contentType } = req.body || {};
    if (!UUID_RE.test(uploadId || "")) {
      return res.status(400).json({ error: "Invalid uploadId." });
    }
    if (!Number.isInteger(blockCount) || blockCount < 1) {
      return res.status(400).json({ error: "blockCount is required." });
    }

    const record = await readRecord(uploadId);
    if (!record) return res.status(404).json({ error: "Unknown upload." });

    const ids = Array.from({ length: blockCount }, (_, i) => blockId(i));
    await quarantineContainer
      .getBlockBlobClient(record.blobName)
      .commitBlockList(ids, {
        blobHTTPHeaders: {
          blobContentType: contentType || "application/octet-stream"
        }
      });

    record.state = "queued";
    record.message = "Queued for malware scanning in an isolated container.";
    record.updatedUtc = new Date().toISOString();
    await writeRecord(record);

    await startScanJob(uploadId);

    res.status(202).json({ state: record.state });
  } catch (err) {
    console.error("complete failed", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/status", async (req, res) => {
  try {
    const id = req.query.id;
    if (!UUID_RE.test(id || "")) return res.status(400).json({ error: "Invalid id." });

    const record = await readRecord(id);
    if (!record) return res.status(404).json({ error: "Unknown upload." });

    res.set("Cache-Control", "no-store").json({
      uploadId: record.uploadId,
      state: record.state,
      message: record.message,
      department: record.departmentName,
      fileName: record.fileName,
      updatedUtc: record.updatedUtc
    });
  } catch (err) {
    console.error("status failed", err);
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`upload broker listening on ${PORT}`));
