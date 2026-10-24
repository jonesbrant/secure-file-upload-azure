"use strict";

const crypto = require("node:crypto");
const { DefaultAzureCredential } = require("@azure/identity");
const { BlobServiceClient } = require("@azure/storage-blob");

function createServices(env) {
  const credential = new DefaultAzureCredential(
    env.AZURE_CLIENT_ID ? { managedIdentityClientId: env.AZURE_CLIENT_ID } : {}
  );
  const blobs = new BlobServiceClient(
    `https://${env.STORAGE_ACCOUNT_NAME}.blob.core.windows.net`, credential
  );
  const client = (container, name) => blobs.getContainerClient(container).getBlockBlobClient(name);
  const store = {
    async read(container, name) {
      try {
        return JSON.parse((await client(container, name).downloadToBuffer()).toString("utf8"));
      } catch (error) {
        if (error.statusCode === 404) return null;
        throw error;
      }
    },
    async write(container, name, value) {
      const body = JSON.stringify(value);
      await client(container, name).upload(body, Buffer.byteLength(body), {
        blobHTTPHeaders: { blobContentType: "application/json" }
      });
    },
    async remove(container, name) {
      await client(container, name).deleteIfExists({ deleteSnapshots: "include" });
    },
    async *list(container, prefix = "") {
      for await (const blob of blobs.getContainerClient(container).listBlobsFlat({ prefix })) {
        if (blob.name.endsWith(".json")) {
          const value = await store.read(container, blob.name);
          if (value) yield { name: blob.name, value };
        }
      }
    },
    async lock(key, operation) {
      const name = `locks/${crypto.createHash("sha256").update(key).digest("hex")}`;
      const blob = client("auth", name);
      try {
        await blob.upload("", 0, { conditions: { ifNoneMatch: "*" } });
      } catch (error) {
        if (![409, 412].includes(error.statusCode)) throw error;
      }
      const lease = blob.getBlobLeaseClient();
      try {
        await lease.acquireLease(60);
      } catch (error) {
        if (error.statusCode === 409) {
          error.status = 409;
          error.message = "Operation already in progress. Please retry.";
        }
        throw error;
      }
      let leaseFailed = false;
      const timer = setInterval(() => lease.renewLease().catch(() => { leaseFailed = true; }), 20000);
      timer.unref();
      try {
        const result = await operation();
        if (leaseFailed) throw new Error("Storage lock renewal failed.");
        return result;
      } finally {
        clearInterval(timer);
        await lease.releaseLease();
      }
    }
  };

  async function sendMail(to, subject, plainText) {
    if (!env.EMAIL_ENDPOINT || !env.EMAIL_SENDER) throw new Error("Email delivery is not configured.");
    const token = await credential.getToken("https://communication.azure.com/.default");
    const response = await fetch(`${env.EMAIL_ENDPOINT.replace(/\/$/, "")}/emails:send?api-version=2023-03-31`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        senderAddress: env.EMAIL_SENDER,
        recipients: { to: to.map(address => ({ address })) },
        content: { subject, plainText }
      }),
      signal: AbortSignal.timeout(30000)
    });
    if (!response.ok) throw new Error(`Email service rejected delivery (${response.status}).`);
  }

  async function startScan(uploadId) {
    const token = await credential.getToken("https://management.azure.com/.default");
    const response = await fetch(`https://management.azure.com${env.SCAN_JOB_ID}/start?api-version=2024-03-01`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ containers: [{
        name: env.SCAN_CONTAINER_NAME || "job-clamav-scan",
        image: env.SCANNER_IMAGE,
        resources: { cpu: 2, memory: "4Gi" },
        env: [
          { name: "UPLOAD_ID", value: uploadId },
          { name: "STORAGE_ACCOUNT_NAME", value: env.STORAGE_ACCOUNT_NAME },
          { name: "AZURE_CLIENT_ID", value: env.AZURE_CLIENT_ID }
        ]
      }] }),
      signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) throw new Error(`Scan job could not start (${response.status}).`);
  }

  return { store, blob: client, sendMail, startScan, now: () => Date.now() };
}

module.exports = { createServices };
