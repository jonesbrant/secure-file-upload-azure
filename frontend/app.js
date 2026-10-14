/* Client-side chunked upload.

   The file is sliced into fixed-size blocks that are PUT individually to the
   upload broker, which stages each one as a block in Azure Blob Storage. The
   browser never holds more than a few blocks in memory, so arbitrarily large
   files upload with flat memory use, and any failed block is retried on its
   own instead of restarting the whole transfer. */

const BLOCK_SIZE = 8 * 1024 * 1024; // 8 MiB -> 50,000 blocks = ~400 GB ceiling
const PARALLEL = 4;
const MAX_ATTEMPTS = 4;
const MAX_BLOCKS = 50000;

const API = (window.APP_CONFIG && window.APP_CONFIG.apiBase) || "";

const el = {
  dept: document.getElementById("department"),
  file: document.getElementById("file"),
  upload: document.getElementById("upload"),
  progressWrap: document.getElementById("progressWrap"),
  bar: document.getElementById("bar"),
  pct: document.getElementById("pct"),
  rate: document.getElementById("rate"),
  status: document.getElementById("status")
};

function refreshButton() {
  el.upload.disabled = !(el.dept.value && el.file.files.length);
}
el.dept.addEventListener("change", refreshButton);
el.file.addEventListener("change", refreshButton);

function say(message, kind) {
  el.status.classList.remove("hidden");
  el.status.className = "status" + (kind ? " " + kind : "");
  el.status.textContent = message;
}

function humanBytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return n.toFixed(i === 0 ? 0 : 1) + " " + units[i];
}

async function postJson(path, body) {
  const res = await fetch(API + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`${path} failed (${res.status}): ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function putBlock(uploadId, index, chunk) {
  const url = `${API}/api/upload/block?id=${encodeURIComponent(uploadId)}&index=${index}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: chunk
      });
      if (res.ok) return;
      throw new Error(`block ${index} returned ${res.status}`);
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS) throw err;
      await new Promise(r => setTimeout(r, 500 * 2 ** (attempt - 1)));
    }
  }
}

async function uploadChunked(uploadId, file) {
  const total = Math.max(1, Math.ceil(file.size / BLOCK_SIZE));
  if (total > MAX_BLOCKS) {
    throw new Error("File is too large for the configured block size.");
  }

  let uploadedBytes = 0;
  let next = 0;
  const started = Date.now();

  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= total) return;
      const start = i * BLOCK_SIZE;
      const chunk = file.slice(start, Math.min(start + BLOCK_SIZE, file.size));
      await putBlock(uploadId, i, chunk);

      uploadedBytes += chunk.size;
      const pct = file.size ? Math.round(uploadedBytes / file.size * 100) : 100;
      el.bar.style.width = pct + "%";
      el.pct.textContent = `${pct}%  (${humanBytes(uploadedBytes)} / ${humanBytes(file.size)})`;
      const secs = (Date.now() - started) / 1000;
      if (secs > 0) el.rate.textContent = humanBytes(uploadedBytes / secs) + "/s";
    }
  };

  await Promise.all(Array.from({ length: Math.min(PARALLEL, total) }, worker));
  return total;
}

async function pollStatus(uploadId) {
  const terminal = { clean: "ok", infected: "bad", error: "bad" };
  const deadline = Date.now() + 30 * 60 * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));

    let state;
    try {
      const res = await fetch(`${API}/api/status?id=${encodeURIComponent(uploadId)}`);
      if (!res.ok) continue;
      state = await res.json();
    } catch { continue; }

    if (state.state in terminal) {
      say(state.message || state.state, terminal[state.state]);
      return;
    }
    say(state.message || "Scanning…");
  }
  say("Still scanning. The scan job runs asynchronously — check back shortly.", "warn");
}

el.upload.addEventListener("click", async () => {
  const file = el.file.files[0];
  const department = el.dept.value;
  if (!file || !department) return;

  el.upload.disabled = true;
  el.dept.disabled = true;
  el.file.disabled = true;
  el.progressWrap.classList.remove("hidden");
  el.bar.style.width = "0%";

  try {
    say("Preparing upload…");
    const { uploadId } = await postJson("/api/upload/init", {
      department,
      fileName: file.name,
      size: file.size
    });

    say(`Uploading ${humanBytes(file.size)} in ${humanBytes(BLOCK_SIZE)} blocks…`);
    const blockCount = await uploadChunked(uploadId, file);

    say("Upload complete. Starting an isolated scan container…");
    await postJson("/api/upload/complete", {
      uploadId,
      blockCount,
      contentType: file.type
    });

    await pollStatus(uploadId);
  } catch (err) {
    say("Upload failed: " + err.message, "bad");
  } finally {
    el.dept.disabled = false;
    el.file.disabled = false;
    refreshButton();
  }
});
