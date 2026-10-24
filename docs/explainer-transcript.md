# Secure File Intake - explainer transcript

## 1. A safer way to receive documents

This is the updated secure file intake architecture. It gives the public a simple submission portal and gives departmental staff a separate, authorised workspace. Every file follows a controlled lifecycle, from email-verified submission, through two malware checks, to retrieval or automatic deletion.

## 2. 1 | Verify every sign-in

A public user starts by entering an email address. The service sends a one-time code, and the first verified login registers that email. Every subsequent login needs a fresh code. Codes expire after ten minutes and allow only five attempts. The browser keeps its session in memory. Staff privileges are assigned explicitly; knowing an email address never grants departmental access.

## 3. 2 | Let each department manage its programs

Each of the three departments can define its own programs, categories, or services. Administrators set the notification list and retention period for each program. Public users choose a department and program, enter a permit, identification, or case reference, add details, and select their file. The retention policy is captured with that submission.

## 4. 3 | Upload reliably, then pass the intake gate

The browser splits the file into eight mebibyte chunks and retries failed chunks independently. The broker streams those chunks into private intake quarantine. It does not load the whole file into memory. A separate, isolated ClamAV job scans the complete upload before any department copy is released. This is intake scanning after quarantine staging, not packet-level inspection. The accepted file limit is two gibibytes minus one byte, so the scanner can inspect every accepted file.

## 5. 4 | Require a second clean result at rest

After ClamAV reports clean, the job creates a program-specific copy in the selected department's storage container. Microsoft Defender for Storage scans this file at rest when it is uploaded. Event Grid delivers an authenticated result to the broker. The result must match the exact version of the blob, identified by its ETag. Until both checks are clean, retrieval is blocked. Malicious files are rejected; errors, missing results, and changed files never bypass the gate.

## 6. 5 | Notify, retrieve, then remove

Once both scans pass, the configured recipients receive an email linking to the internal portal. The message contains no file attachment or sensitive case details. Staff sign in, see only their assigned submissions, and stream a download. The API rechecks authorisation, the malware result, the blob ETag, and retention expiry. A completed server response deletes the stored payload. An interrupted transfer retains it for retry. Server completion cannot prove that a recipient saved a durable copy.

## 7. 6 | Enforce retention without always-on compute

Retention is enforced at the API immediately, even between cleanup runs. An hourly Container Apps job removes expired payloads and retries pending notifications. Managed identity handles Azure access without storage keys in application code. Log Analytics supports troubleshooting. Operations should monitor failed jobs, pending scans, and the Defender scan budget. This design adds no WAF or Application Gateway.

## 8. Low fixed cost. Explicit security boundaries.

The solution reuses the existing Azure resources and keeps fixed costs low. Static Web Apps stays on the free tier, the broker scales to zero, and compute jobs run only when needed. Defender scanning is a new usage-based cost required by the document. We scan department copies rather than duplicate quarantine data, and a configurable cap controls exposure. If the cap is reached, files remain blocked. Finally, the email integration needs a migration plan before the announced ACS Email retirement in September twenty twenty-eight.