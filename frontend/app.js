"use strict";

const API = window.APP_CONFIG?.apiBase || "";
const BLOCK_SIZE = 8 * 1024 * 1024;
const $ = id => document.getElementById(id);
let token = "", me, catalog, adminConfig = [], busy = false;
const show = (id, visible) => $(id).classList.toggle("hidden", !visible);
const say = (text, kind = "") => {
  $("status").className = `status ${kind}`;
  $("status").textContent = text;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const emails = text => text.split(/[\n,;]/).map(x => x.trim().toLowerCase()).filter(Boolean);
const bytes = n => n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1024 ** 2).toFixed(1)} MiB`;

async function request(path, method = "GET", body) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(API + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store"
  });
  if (!response.ok) {
    if (response.status === 401 && token) signOut();
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `Request failed (${response.status}).`);
  }
  return response.status === 204 ? null : response.json();
}
function guarded(action) {
  return async event => {
    event?.preventDefault();
    try { await action(event); } catch (error) { say(error.message, "bad"); }
  };
}
function options(id, values, placeholder) {
  $(id).replaceChildren();
  if (placeholder) $(id).append(new Option(placeholder, ""));
  for (const item of values) $(id).append(new Option(item.name, item.id));
}
function refreshButton() {
  $("upload").disabled = busy || !$("program").value || !$("file").files.length;
}
function updatePrograms() {
  const department = catalog.departments.find(d => d.id === $("department").value);
  options("program", department?.programs || [], "Select a program");
  $("retention").textContent = department && !department.programs.length ?
    "This department has no active programs. Contact the department administrator." : "";
  refreshButton();
}
function updateRetention() {
  const program = catalog.departments.find(d => d.id === $("department").value)?.programs.find(p => p.id === $("program").value);
  $("retention").textContent = program ? `Deleted after retrieval or ${program.retentionDays} day(s), whichever comes first.` : "";
  refreshButton();
}
function signOut() {
  token = "";
  show("portal", false); show("login", true); show("verifyForm", false);
  $("code").value = ""; $("file").value = "";
  $("reference").value = ""; $("details").value = "";
  $("submissions").replaceChildren();
}
$("requestForm").addEventListener("submit", guarded(async () => {
  $("requestCode").disabled = true;
  try {
    const result = await request("/api/auth/request", "POST", { email: $("email").value });
    show("verifyForm", true); say(result.message); $("code").focus();
  } finally { $("requestCode").disabled = false; }
}));
$("verifyForm").addEventListener("submit", guarded(async () => {
  const result = await request("/api/auth/verify", "POST", { email: $("email").value, code: $("code").value });
  token = result.token; // Kept only in memory; refresh or closing the page signs out.
  me = await request("/api/me");
  catalog = await request("/api/catalog");
  options("department", catalog.departments, "Select a department");
  updatePrograms();
  $("signedIn").textContent = me.email;
  show("login", false); show("portal", true);
  show("staffTab", me.staffDepartments.length > 0);
  show("adminView", me.adminDepartments.length > 0);
  show("delegateForm", me.superAdmin);
  show("publicView", true); show("staffView", false);
  if (me.adminDepartments.length) await loadAdmin();
  say("Signed in. Choose a department and program to submit a file.", "ok");
}));
$("logout").addEventListener("click", guarded(async () => {
  try { await request("/api/auth/logout", "POST"); } finally { signOut(); say("Signed out."); }
}));
$("department").addEventListener("change", updatePrograms);
$("program").addEventListener("change", updateRetention);
$("file").addEventListener("change", refreshButton);
$("publicTab").addEventListener("click", () => { show("publicView", true); show("staffView", false); });
$("staffTab").addEventListener("click", guarded(async () => {
  show("publicView", false); show("staffView", true); await loadSubmissions();
}));
$("refresh").addEventListener("click", guarded(loadSubmissions));

async function loadAdmin() {
  adminConfig = (await request("/api/admin/config")).departments;
  options("adminDepartment", catalog.departments.filter(d => me.adminDepartments.includes(d.id)));
  updateAdminPrograms();
}
function updateAdminPrograms() {
  const cfg = adminConfig.find(d => d.department === $("adminDepartment").value);
  options("editProgram", cfg?.programs || [], "Create a new program");
  $("departmentAdmins").value = (cfg?.admins || []).join("\n");
  editProgram();
}
function editProgram() {
  const item = adminConfig.find(d => d.department === $("adminDepartment").value)?.programs.find(p => p.id === $("editProgram").value);
  $("programName").value = item?.name || "";
  $("retentionDays").value = item?.retentionDays || 7;
  $("recipients").value = (item?.recipients || []).join("\n");
  $("active").checked = item?.active !== false;
}
$("adminDepartment").addEventListener("change", updateAdminPrograms);
$("editProgram").addEventListener("change", editProgram);
$("programForm").addEventListener("submit", guarded(async () => {
  const department = $("adminDepartment").value;
  await request("/api/admin/programs", "PUT", {
    id: $("editProgram").value || undefined, department, name: $("programName").value,
    retentionDays: Number($("retentionDays").value), recipients: emails($("recipients").value), active: $("active").checked
  });
  catalog = await request("/api/catalog");
  await loadAdmin(); $("adminDepartment").value = department; updateAdminPrograms(); updatePrograms();
  say("Program saved. Its recipients can retrieve submissions after both malware scans pass.", "ok");
}));
$("delegateForm").addEventListener("submit", guarded(async () => {
  const department = $("adminDepartment").value;
  await request(`/api/admin/departments/${department}`, "PUT", { admins: emails($("departmentAdmins").value) });
  await loadAdmin(); $("adminDepartment").value = department; updateAdminPrograms();
  say("Department administrators updated.", "ok");
}));

async function putBlock(id, index, chunk) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch(`${API}/api/upload/block?id=${id}&index=${index}`, {
      method: "PUT", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" }, body: chunk
    }).catch(() => null);
    if (response?.ok) return;
    if (response && response.status < 500) throw new Error((await response.json()).error);
    if (attempt === 3) throw new Error("A file chunk could not be uploaded. Please retry.");
    await delay(500 * 2 ** attempt);
  }
}
async function poll(id) {
  const until = Date.now() + 60 * 60 * 1000;
  while (Date.now() < until && token) {
    await delay(5000);
    const state = await request(`/api/status?id=${id}`);
    const terminal = ["clean", "infected", "error", "expired", "defender_error"];
    say(state.message, state.state === "clean" ? "ok" : terminal.includes(state.state) ? "bad" : "");
    if (terminal.includes(state.state)) return;
  }
  say("Scanning is still pending. Staff retrieval remains blocked until both scanners confirm clean.");
}
$("upload").addEventListener("click", guarded(async () => {
  const file = $("file").files[0];
  if (!file || busy) return;
  if (file.size < 1 || file.size > catalog.maxScanBytes) throw new Error("Choose a nonempty file smaller than 2 GiB.");
  busy = true; refreshButton(); show("progressWrap", true); $("bar").style.width = "0%";
  try {
    const { uploadId } = await request("/api/upload/init", "POST", {
      department: $("department").value, programId: $("program").value,
      fileName: file.name, size: file.size, reference: $("reference").value, details: $("details").value
    });
    const total = Math.ceil(file.size / BLOCK_SIZE), started = Date.now();
    let next = 0, uploaded = 0;
    const worker = async () => {
      while (next < total) {
        const index = next++;
        const chunk = file.slice(index * BLOCK_SIZE, Math.min((index + 1) * BLOCK_SIZE, file.size));
        await putBlock(uploadId, index, chunk);
        uploaded += chunk.size;
        const percent = Math.round(uploaded / file.size * 100);
        $("bar").style.width = `${percent}%`; $("pct").textContent = `${percent}% (${bytes(uploaded)} / ${bytes(file.size)})`;
        $("rate").textContent = `${bytes(uploaded / Math.max(1, (Date.now() - started) / 1000))}/s`;
      }
    };
    say("Uploading into private intake quarantine...");
    await Promise.all(Array.from({ length: Math.min(4, total) }, worker));
    await request("/api/upload/complete", "POST", { uploadId, blockCount: total });
    say("ClamAV intake scan queued. Microsoft Defender will scan the department copy next.");
    await poll(uploadId);
  } finally { busy = false; refreshButton(); }
}));
async function loadSubmissions() {
  const { submissions } = await request("/api/internal/submissions");
  $("submissions").replaceChildren();
  if (!submissions.length) $("submissions").textContent = "No active submissions in your assigned programs.";
  for (const item of submissions) {
    const card = document.createElement("article");
    const heading = document.createElement("h3"); heading.textContent = item.fileName;
    const description = document.createElement("p");
    const department = catalog.departments.find(d => d.id === item.department);
    const program = department?.programs.find(p => p.id === item.programId);
    description.textContent = `${department?.name || item.department} / ${program?.name || item.programId} | ${item.state} | Expires ${new Date(item.expiresUtc).toLocaleString()}`;
    const details = document.createElement("p"); details.textContent = `Reference: ${item.reference || "-"}\n${item.details || ""}`;
    card.append(heading, description, details);
    const button = document.createElement("button"); button.textContent = "Download & delete stored file"; button.disabled = item.state !== "clean";
    button.addEventListener("click", guarded(async () => {
      if (!window.confirm("Download this file? The server copy will be deleted after the response completes.")) return;
      button.disabled = true;
      try {
        let target;
        if (window.showSaveFilePicker) {
          target = await window.showSaveFilePicker({ suggestedName: item.fileName });
        } else if (item.size > 64 * 1024 * 1024) {
          throw new Error("Use Edge or Chrome for streaming downloads of files over 64 MiB.");
        }
        const response = await fetch(`${API}/api/internal/download/${item.uploadId}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error((await response.json()).error);
        if (target) {
          const writer = await target.createWritable();
          await response.body.pipeTo(writer);
        } else {
          const url = URL.createObjectURL(await response.blob());
          const link = document.createElement("a"); link.href = url; link.download = item.fileName; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        }
        say("Download completed. The server copy is being deleted.", "ok");
        await delay(1000); await loadSubmissions();
      } finally { button.disabled = false; }
    }));
    card.append(button); $("submissions").append(card);
  }
}
