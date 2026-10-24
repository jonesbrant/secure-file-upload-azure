"""Build the customer architecture and narrated MP4 locally, without cloud AI costs.

Requires Pillow, playwright, imageio-ffmpeg, Microsoft Edge, and Windows System.Speech.
"""

import argparse
import base64
import html
import json
from pathlib import Path
import subprocess
import tempfile
import wave

import imageio_ffmpeg
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"


def icon(name):
    content = (DOCS / "icons" / f"{name}.svg").read_bytes()
    return "data:image/svg+xml;base64," + base64.b64encode(content).decode()


def card(x, y, image, title, lines, number="", color="#0878d1"):
    rows = "".join(f'<text x="{x + 140}" y="{y + 118 + i * 23}" text-anchor="middle" '
                   f'font-size="17" fill="#40536a">{html.escape(line)}</text>'
                   for i, line in enumerate(lines))
    return f"""<g><rect x="{x}" y="{y}" width="280" height="190" rx="18" fill="white"
 stroke="#ccdae8" stroke-width="2"/><image href="{icon(image)}" x="{x + 113}" y="{y + 15}" width="54" height="54"/>
 <text x="{x + 140}" y="{y + 96}" text-anchor="middle" font-size="21" font-weight="700" fill="#12304b">{html.escape(title)}</text>
 {rows}<circle cx="{x + 23}" cy="{y + 22}" r="17" fill="{color}"/>
 <text x="{x + 23}" y="{y + 28}" text-anchor="middle" font-size="17" fill="white">{number}</text></g>"""


def architecture():
    nodes = [
        card(45, 175, "identity", "Public & internal users", ["Public: verify email per login", "Staff: assigned programs only", "Admin: configure departments"], "1"),
        card(410, 175, "static-web-apps", "Azure Static Web Apps", ["Free-tier HTTPS portal", "Public submission / internal mode", "Browser calls broker directly"], "2"),
        card(775, 175, "container-apps", "Container Apps broker", ["OTP, roles & chunk streaming", "Authenticated public ingress", "Scale to zero when idle"], "3"),
        card(1140, 175, "email", "ACS Email", ["One-time login codes", "Clean-file notifications", "No attachments or case data"], "4"),
        card(410, 520, "storage", "Intake quarantine", ["Private Blob Storage", "8 MiB chunks; bounded memory", "Never exposed to the public"], "5"),
        card(775, 520, "container-apps", "ClamAV intake job", ["One isolated execution per file", "Scan before department release", "Unsafe / unscannable: blocked"], "6"),
        card(1140, 520, "storage", "Department Blob Storage", ["Sheriff / Public Health /", "Corrections; program folders", "Not downloadable until scan 2"], "7"),
        card(1140, 790, "defender", "Defender for Storage", ["Second scan: at-rest on upload", "Managed service; no scanner VM", "Only clean, unchanged files pass"], "8", "#18865e"),
        card(775, 790, "event-grid", "Event Grid", ["Authenticated scan results", "Exact blob ETag verification", "Missing / error: fail closed"], "9", "#18865e"),
        card(410, 790, "container-apps", "Scheduled cleanup job", ["Expiry blocks access immediately", "Hourly payload deletion", "Successful retrieval also deletes"], "10", "#18865e"),
    ]
    paths = [
        ('M325 267 H405', "HTTPS", 350, 249),
        ('M690 267 H770', "REST", 710, 249),
        ('M1055 267 H1135', "Email", 1070, 249),
        ('M915 365 V515', "Start isolated job", 930, 431),
        ('M810 365 V405 H550 V515', "Private staging*", 565, 431),
        ('M690 615 H770', "Read", 712, 595),
        ('M1055 615 H1135', "Promote", 1067, 595),
        ('M1280 710 V785', "Scan", 1300, 753),
        ('M1140 885 H1060', "Result", 1068, 865),
        ('M550 790 V750 H1280 V715', "Hourly purge", 680, 774),
    ]
    lines = "".join(f'<path d="{p}" fill="none" stroke="#1684cf" stroke-width="3" marker-end="url(#arrow)"/>'
                    f'<text x="{x}" y="{y}" font-size="16" fill="#17639a">{label}</text>'
                    for p, label, x, y in paths)
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1500" height="1210" viewBox="0 0 1500 1210">
 <defs><marker id="arrow" markerWidth="9" markerHeight="9" refX="8" refY="4" orient="auto">
 <path d="M0 0 L8 4 L0 8" fill="#1684cf"/></marker></defs>
 <rect width="1500" height="1210" fill="#f7faff"/>
 <text x="45" y="60" font-family="Segoe UI" font-size="35" font-weight="700" fill="#103854">Secure File Intake | Two-stage protection</text>
 <text x="45" y="99" font-size="20" fill="#42617a">Two portal modes. Department-managed programs. No WAF or Application Gateway.</text>
 <rect x="385" y="460" width="1058" height="285" rx="24" fill="#eaf5ff" stroke="#0878d1" stroke-width="2" stroke-dasharray="8 5"/>
 <text x="410" y="495" font-size="20" font-weight="700" fill="#0763a9">VNet-connected workloads + private Blob data plane / managed identity</text>
 <g font-family="Segoe UI,Arial,sans-serif">{lines}{''.join(nodes)}
 <path d="M915 980 V1035 H1460 V405 H1010 V370" fill="none" stroke="#18865e" stroke-width="3" stroke-dasharray="8 5" marker-end="url(#arrow)"/>
 <text x="45" y="490" font-size="21" font-weight="700" fill="#12304b">Release gate</text>
 <text x="45" y="529" font-size="19" fill="#40536a">ClamAV clean</text><text x="45" y="561" font-size="19" fill="#40536a">+ Defender clean</text>
 <text x="45" y="593" font-size="19" fill="#40536a">+ matching ETag</text><text x="45" y="625" font-size="19" fill="#40536a">+ authorised staff</text>
 <text x="45" y="657" font-size="19" fill="#40536a">+ retention not expired</text>
 <text x="45" y="720" font-size="18" font-weight="700" fill="#166447">Otherwise: no download.</text>
 <text x="45" y="1083" font-size="18" fill="#40536a">*Browser streams chunks to the broker; SWA serves the UI. The broker stages chunks into private intake quarantine.</text>
 <text x="45" y="1115" font-size="18" fill="#40536a">Supporting services: ACR images | private auth/config blobs | managed identity | Log Analytics | per-program retention</text>
 <text x="45" y="1147" font-size="17" fill="#40536a">ClamAV is an intake gate after quarantine staging, not a packet-level scanner. Defender scans at-rest on upload, not continuously.</text>
 <text x="45" y="1179" font-size="16" fill="#577084">Official Microsoft Azure architecture icons. ACS Email migration required before September 30, 2028. File limit: 2 GiB minus 1 byte.</text>
 </g></svg>"""
    details = """
    <section><h2>What changed</h2><p>Public users register and authenticate by email one-time code. Department administrators configure programs, notification recipients, and retention. Staff see only their assigned programs.</p>
    <h2>Protection and deletion</h2><p>Uploads are staged in private quarantine over TLS. A fresh isolated ClamAV execution inspects the complete file before it is copied into a program folder in the selected department container. Defender for Storage then scans that copy at rest. Authenticated Event Grid results must match the exact stored blob ETag before the broker releases a download.</p>
    <p>Files are inaccessible at retention expiry; an hourly job removes expired payloads. A successful server-side download response deletes the stored payload; an interrupted transfer keeps it for retry. Server completion cannot prove that a user saved a durable local copy. Soft delete and versioning must remain disabled for immediate physical deletion; Azure policy may require a different records-management arrangement.</p>
    <h2>Enterprise security</h2><p>Department and program authorisation is enforced in the API, not only the UI. OTPs are single-use, hashed, expire after ten minutes, allow five attempts, and have resend limits. Sessions last eight hours and are held only in browser memory. Storage denies public networking and shared keys. Managed identity authenticates Azure service calls. Scanner jobs have no inbound ingress; they still need outbound Azure access. No WAF or Application Gateway is provisioned.</p>
    <p>JSON metadata and auth state use private blobs, avoiding another database. ClamAV inspection has a 2 GiB minus 1 byte limit; encrypted, over-limit, errored, and unconfirmed files are not released. Malware scanning is not vulnerability analysis or content classification. This is not a compliance certification.</p>
    <h2>Cost and operating model</h2><p>SWA Free, an existing Basic registry, LRS storage, scale-to-zero broker, per-file scanner jobs, hourly short cleanup runs, and usage-based email minimise fixed costs. Defender is an explicit new paid requirement; chargeable scan volume is limited to department copies, with a configurable monthly cap. A cap can stop scanning, so files remain blocked rather than bypassing protection.</p>
    <h2>Operations</h2><p>Rebuild scanner images regularly for fresh signatures, monitor failed jobs and pending scans, review staff memberships, and alert on Defender scan-cap exhaustion. ACS Email is a replaceable delivery integration: Microsoft lists retirement for September 30, 2028.</p>
    <h2>Source references</h2><p><a href="https://learn.microsoft.com/en-us/azure/architecture/icons/">Official Azure icons and usage terms</a> |
    <a href="https://learn.microsoft.com/en-us/azure/defender-for-cloud/introduction-malware-scanning">Defender malware scanning</a> |
    <a href="https://learn.microsoft.com/en-us/azure/defender-for-cloud/defender-for-storage-configure-malware-scan">Scan-result event schema</a> |
    <a href="https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide">ACS service lifecycle</a></p></section>"""
    document = f"""<!doctype html><html lang="en"><meta charset="utf-8"><title>Secure File Intake Architecture</title>
 <style>body{{margin:0;background:#f7faff;font:18px/1.65 'Segoe UI',sans-serif;color:#17324d}}main{{max-width:1500px;margin:auto}}svg{{width:100%;height:auto}}section{{padding:30px 55px;background:white}}h2{{color:#0967a8}}a{{color:#0967a8}}@media print{{body{{font-size:12px}}}}</style>
 <main>{svg}{details}</main></html>"""
    (DOCS / "architecture.html").write_text(document, encoding="utf-8")


SCENES = [
    ("A safer way to receive documents", "Two portal modes. One controlled file lifecycle.",
     [("static-web-apps", "Public submission", "Email-verified users submit to the right department and program."),
      ("identity", "Internal workspace", "Assigned staff retrieve files. Department admins configure programs."),
      ("storage", "Short-lived storage", "Files disappear after retrieval or the program's retention period.")],
     "This is the updated secure file intake architecture. It gives the public a simple submission portal and gives departmental staff a separate, authorised workspace. Every file follows a controlled lifecycle, from email-verified submission, through two malware checks, to retrieval or automatic deletion."),
    ("1 | Verify every sign-in", "Email one-time codes replace public passwords.",
     [("email", "Request a code", "Anyone can register with an email address."),
      ("identity", "Verify the mailbox", "Single-use, eight-digit code. Ten-minute expiry. Limited attempts."),
      ("container-apps", "Enforce permissions", "The API checks the session and department/program access.")],
     "A public user starts by entering an email address. The service sends a one-time code, and the first verified login registers that email. Every subsequent login needs a fresh code. Codes expire after ten minutes and allow only five attempts. The browser keeps its session in memory. Staff privileges are assigned explicitly; knowing an email address never grants departmental access."),
    ("2 | Let each department manage its programs", "Sheriff. Public Health. Corrections.",
     [("identity", "Department admins", "Create programs and delegate departmental administration."),
      ("email", "Program recipients", "Configure who is notified and who may retrieve each program's files."),
      ("storage", "Submission context", "Program, case/permit reference, notes, and a retention deadline.")],
     "Each of the three departments can define its own programs, categories, or services. Administrators set the notification list and retention period for each program. Public users choose a department and program, enter a permit, identification, or case reference, add details, and select their file. The retention policy is captured with that submission."),
    ("3 | Upload reliably, then pass the intake gate", "8 MiB chunks. Independent retries. Isolated ClamAV execution.",
     [("container-apps", "Chunk broker", "Streams chunks into private quarantine with bounded memory."),
      ("private-endpoint", "Private Blob path", "Storage has no public endpoint access or shared account keys."),
      ("container-apps", "ClamAV job", "Scans the complete quarantined file before department release.")],
     "The browser splits the file into eight mebibyte chunks and retries failed chunks independently. The broker streams those chunks into private intake quarantine. It does not load the whole file into memory. A separate, isolated ClamAV job scans the complete upload before any department copy is released. This is intake scanning after quarantine staging, not packet-level inspection. The accepted file limit is two gibibytes minus one byte, so the scanner can inspect every accepted file."),
    ("4 | Require a second clean result at rest", "Defender result + exact blob ETag = release decision.",
     [("storage", "Department copy", "Clean ClamAV output is saved under the selected program."),
      ("defender", "Microsoft Defender", "Scans the stored department copy when it is created."),
      ("event-grid", "Trusted scan event", "Authenticated callback; matching ETag; no result means no download.")],
     "After ClamAV reports clean, the job creates a program-specific copy in the selected department's storage container. Microsoft Defender for Storage scans this file at rest when it is uploaded. Event Grid delivers an authenticated result to the broker. The result must match the exact version of the blob, identified by its ETag. Until both checks are clean, retrieval is blocked. Malicious files are rejected; errors, missing results, and changed files never bypass the gate."),
    ("5 | Notify, retrieve, then remove", "The notification contains a portal link, never the document.",
     [("email", "Notify recipients", "Email after both checks pass. No attachments or case details."),
      ("container-apps", "Authorised download", "The API checks program access, scan status, ETag, and expiry."),
      ("storage", "Delete stored payload", "Completed server response deletes it; interrupted transfers can retry.")],
     "Once both scans pass, the configured recipients receive an email linking to the internal portal. The message contains no file attachment or sensitive case details. Staff sign in, see only their assigned submissions, and stream a download. The API rechecks authorisation, the malware result, the blob ETag, and retention expiry. A completed server response deletes the stored payload. An interrupted transfer retains it for retry. Server completion cannot prove that a recipient saved a durable copy."),
    ("6 | Enforce retention without always-on compute", "Expiry is an access rule, not just a cleanup schedule.",
     [("container-apps", "Hourly cleanup job", "Removes expired payloads, including abandoned submissions."),
      ("identity", "Private service identity", "Managed identity for storage, registry, job control, and email."),
      ("logs", "Operational visibility", "Monitor pending scans, failed jobs, and Defender scan-cap alerts.")],
     "Retention is enforced at the API immediately, even between cleanup runs. An hourly Container Apps job removes expired payloads and retries pending notifications. Managed identity handles Azure access without storage keys in application code. Log Analytics supports troubleshooting. Operations should monitor failed jobs, pending scans, and the Defender scan budget. This design adds no WAF or Application Gateway."),
    ("Low fixed cost. Explicit security boundaries.", "Pay for work performed; never release a file to save scan cost.",
     [("static-web-apps", "Reuse the existing estate", "SWA Free, LRS storage, Basic registry, and private endpoint."),
      ("container-apps", "Scale to zero", "Broker idles at zero; scan and cleanup jobs are short-lived."),
      ("defender", "Budget the required scan", "Defender is billed by scan volume. Cap exhaustion blocks release.")],
     "The solution reuses the existing Azure resources and keeps fixed costs low. Static Web Apps stays on the free tier, the broker scales to zero, and compute jobs run only when needed. Defender scanning is a new usage-based cost required by the document. We scan department copies rather than duplicate quarantine data, and a configurable cap controls exposure. If the cap is reached, files remain blocked. Finally, the email integration needs a migration plan before the announced ACS Email retirement in September twenty twenty-eight."),
]


def scene_html(index, title, subtitle, cards):
    boxes = "".join(f'<article><img src="{icon(image)}"><h2>{html.escape(name)}</h2>'
                    f'<p>{html.escape(detail)}</p></article>' for image, name, detail in cards)
    return f"""<!doctype html><html><meta charset="utf-8"><style>
 *{{box-sizing:border-box}}body{{margin:0;width:1920px;height:1080px;background:#081d33;color:#f5f9ff;font:32px/1.4 'Segoe UI',sans-serif;padding:85px 100px}}
 .tag{{color:#76caff;font-size:23px;font-weight:700;letter-spacing:4px}}h1{{font-size:62px;line-height:1.15;margin:26px 0;max-width:1680px}}
 .sub{{color:#b7d3eb;font-size:31px;margin-bottom:65px}}.grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:34px}}
 article{{border:1px solid #2e5573;border-radius:22px;padding:40px 34px;min-height:430px;background:#112e47}}
 img{{width:92px;height:92px;margin-bottom:18px}}h2{{font-size:32px;margin:10px 0 18px}}p{{font-size:28px;color:#c2d7e8;line-height:1.5}}
 footer{{position:absolute;bottom:55px;left:100px;right:100px;display:flex;justify-content:space-between;color:#8bb1cc;font-size:23px}}
 .track{{position:absolute;bottom:0;left:0;height:9px;background:#27a8ec;width:{(index + 1) / len(SCENES) * 100}%}}
 </style><div class="tag">SECURE FILE INTAKE / ARCHITECTURE WALKTHROUGH</div><h1>{html.escape(title)}</h1><div class="sub">{html.escape(subtitle)}</div>
 <div class="grid">{boxes}</div><footer><span>SHERIFF &nbsp; / &nbsp; PUBLIC HEALTH &nbsp; / &nbsp; CORRECTIONS</span><span>{index + 1:02d} / {len(SCENES):02d}</span></footer><div class="track"></div></html>"""


def vtt_time(seconds):
    milliseconds = round(seconds * 1000)
    return f"{milliseconds // 3600000:02}:{milliseconds // 60000 % 60:02}:{milliseconds // 1000 % 60:02}.{milliseconds % 1000:03}"


def build(output):
    output.mkdir(parents=True, exist_ok=True)
    architecture()
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    captions = ["WEBVTT", ""]
    manifest = []
    with tempfile.TemporaryDirectory(prefix="fileupload-media-") as temp:
        temp = Path(temp)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page(viewport={"width": 1500, "height": 1210}, device_scale_factor=1)
            page.goto((DOCS / "architecture.html").as_uri())
            page.screenshot(path=str(DOCS / "architecture-diagram.png"), clip={"x": 0, "y": 0, "width": 1500, "height": 1210})
            page.set_viewport_size({"width": 1920, "height": 1080})
            for index, (title, subtitle, cards, narration) in enumerate(SCENES):
                page.set_content(scene_html(index, title, subtitle, cards))
                page.screenshot(path=str(temp / f"scene-{index}.png"))
            browser.close()
        speech = """param([string]$InputPath,[string]$OutputPath)
Add-Type -AssemblyName System.Speech
$s = [System.Speech.Synthesis.SpeechSynthesizer]::new()
$s.SelectVoice('Microsoft Zira Desktop')
$s.Rate = 0
$s.SetOutputToWaveFile($OutputPath)
$s.Speak([IO.File]::ReadAllText($InputPath))
$s.Dispose()
"""
        speech_path = temp / "speak.ps1"
        speech_path.write_text(speech, encoding="utf-8")
        elapsed = 0
        for index, (title, subtitle, cards, narration) in enumerate(SCENES):
            text = temp / f"scene-{index}.txt"
            wav = temp / f"scene-{index}.wav"
            mp4 = temp / f"scene-{index}.mp4"
            text.write_text(narration, encoding="utf-8")
            subprocess.run(["powershell.exe", "-NoProfile", "-File", str(speech_path),
                            "-InputPath", str(text), "-OutputPath", str(wav)], check=True)
            with wave.open(str(wav), "rb") as audio:
                duration = audio.getnframes() / audio.getframerate() + 1.3
            subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-loop", "1",
                            "-i", str(temp / f"scene-{index}.png"), "-i", str(wav),
                            "-t", str(duration), "-vf", "scale=1920:1080,format=yuv420p",
                            "-c:v", "libx264", "-tune", "stillimage", "-preset", "fast",
                            "-r", "25", "-c:a", "aac", "-b:a", "160k",
                            "-af", "apad", "-movflags", "+faststart", str(mp4)], check=True)
            # Short sentence-level caption cues make the narration usable without sound.
            sentences = [sentence.strip() for sentence in narration.split(". ") if sentence.strip()]
            total_words = sum(len(s.split()) for s in sentences)
            cursor = elapsed
            for sentence in sentences:
                end = cursor + (duration - 1.3) * len(sentence.split()) / total_words
                captions.extend([f"{vtt_time(cursor)} --> {vtt_time(end)}", sentence, ""])
                cursor = end
            manifest.append({"chapter": index + 1, "title": title, "startSeconds": round(elapsed, 2),
                             "durationSeconds": round(duration, 2)})
            elapsed += duration
        concat = temp / "concat.txt"
        concat.write_text("".join(f"file '{(temp / f'scene-{i}.mp4').as_posix()}'\n" for i in range(len(SCENES))), encoding="utf-8")
        destination = output / "secure-file-upload-explainer.mp4"
        subprocess.run([ffmpeg, "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", str(concat),
                        "-c", "copy", "-movflags", "+faststart", str(destination)], check=True)
        # Decode the complete output to catch corrupt frames/audio before handing it off.
        subprocess.run([ffmpeg, "-v", "error", "-i", str(destination), "-f", "null", "-"], check=True)
    (output / "secure-file-upload-explainer.vtt").write_text("\n".join(captions), encoding="utf-8")
    (DOCS / "explainer-transcript.md").write_text(
        "# Secure File Intake - explainer transcript\n\n" +
        "\n\n".join(f"## {i + 1}. {scene[0]}\n\n{scene[3]}" for i, scene in enumerate(SCENES)),
        encoding="utf-8")
    (output / "secure-file-upload-video-chapters.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    (output / "secure-file-upload-video.html").write_text("""<!doctype html><html lang="en"><meta charset="utf-8">
<title>Secure File Intake Architecture Walkthrough</title><style>body{background:#081d33;color:white;font:20px 'Segoe UI';margin:40px}video{width:min(1400px,100%)}a{color:#8bd3ff}</style>
<h1>Secure File Intake - architecture walkthrough</h1><video controls preload="metadata" src="secure-file-upload-explainer.mp4">
<track kind="captions" src="secure-file-upload-explainer.vtt" srclang="en" label="English" default></video>
<p>Locally generated narration; no customer data or cloud AI services used. If local-file captions are blocked by your browser, serve this folder over localhost or use a video player that supports WebVTT.</p></html>""", encoding="utf-8")
    import shutil
    shutil.copy2(DOCS / "architecture.html", output / "secure-file-upload-architecture.html")
    shutil.copy2(DOCS / "architecture-diagram.png", output / "secure-file-upload-architecture.png")
    print(json.dumps({"video": str(destination), "durationSeconds": round(elapsed, 1), "chapters": len(SCENES)}, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path.home() / "Downloads")
    build(parser.parse_args().output)
