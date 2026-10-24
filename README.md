# Secure File Intake on Azure

An email-verified public submission portal and role-protected internal workspace
for **Sheriff, Public Health, and Corrections**. Each department configures programs,
notification recipients, and retention. Files must pass **isolated ClamAV intake
scanning and Microsoft Defender for Storage** before authorised retrieval.

![Architecture diagram](docs/architecture-diagram.png)

Open [the self-contained architecture HTML](docs/architecture.html) for security
details. See [the explainer transcript](docs/explainer-transcript.md) and
[DEPLOY.md](DEPLOY.md) to deploy into **your own Azure environment**.
No WAF or Application Gateway is created.

## Workflow

1. Public users verify an email one-time code at every login. The first successful
   verification registers their email; there is no public password.
2. They select a department/program, enter a permit/ID/case reference and notes,
   and upload in independently retried 8 MiB chunks.
3. A scale-to-zero Container Apps broker streams into private quarantine over a
   private endpoint. A separate ClamAV job inspects the complete staged file.
4. A clean intake result is copied into the selected department container under
   a program folder. Defender scans this copy at rest on upload. Authenticated
   Event Grid results must match its exact ETag before retrieval is enabled.
5. Assigned recipients receive a link-only notification. Staff authenticate and
   retrieve only their authorised programs' files. The stored payload is deleted
   after a completed server response, or by retention cleanup.

The internal portal allows bootstrap/delegated department administrators to
maintain programs, recipients, and retention (1-365 days). Administrators see
their department; program recipients see only their programs. The initial
catalog is empty until an administrator configures it.

## Security and limits

| Control | Behaviour |
| --- | --- |
| Public and staff authentication | Eight-digit, single-use, hashed OTP; ten-minute expiry; five attempts; resend throttling; eight-hour in-memory session |
| Authorisation | Server-side ownership and department/program checks on every protected action |
| Storage | LRS, TLS, public networking disabled, shared-key auth disabled, managed identity, private endpoint |
| Intake gate | Separate ClamAV container execution per file; no inbound scanner ingress; Azure outbound access remains necessary |
| At-rest gate | Defender on-upload scan; authenticated Event Grid callback; matching ETag; errors/missing results remain blocked |
| Large uploads | 8 MiB chunks, four concurrent browser workers; **maximum accepted file: 2 GiB minus 1 byte** |
| Retention | API access ends at exact expiry; hourly job physically purges expired payloads |
| Retrieval | Streaming download; completed server response deletes payload; interrupted response preserves retry |
| Notifications | No attachments, filenames, references, or free-text case details in email |
| Credentials | Azure calls use managed identity; webhook secret resides in Container Apps secrets; no credentials in source |

ClamAV scans after quarantine staging, **not packet-by-packet in transit**.
Defender's second scan is on-upload at-rest scanning, **not continuous rescanning**.
Encrypted/over-limit/unscannable files are never released. Malware scanning is
not a guarantee of safety, source-code vulnerability analysis, or content
classification. Server response completion cannot prove a file was durably
saved locally. Soft delete/versioning must remain disabled for immediate
physical deletion semantics.

The demo shares one managed identity across workloads. Department isolation is
enforced by application authorisation, not separate storage accounts/identities.
For regulated production use, review identity separation, enterprise staff MFA,
records policies, operational monitoring and the required file-size envelope.

## Cost control

SWA Free, a consumption broker with zero minimum replicas, per-upload scanning
jobs, hourly short cleanup jobs, LRS storage, an existing Basic registry and
private endpoint keep fixed costs low. Private JSON blobs hold configuration,
registrations and status, so there is no database server.

**Defender scanning is a new paid requirement and can dominate the monthly bill.**
Only department copies are scanned; quarantine and internal metadata paths are
excluded to avoid duplicate scan charges. The configurable monthly scan cap
defaults to 2,500 GB. Cap exhaustion **blocks release**; it never bypasses scanning.
The earlier estimate for the ClamAV-only demo does not apply to this version.
Email, logs, storage transactions, data processing/transfer and compute remain
usage-based. Validate pricing for the customer's region and agreement.

**ACS Email lifecycle:** Microsoft lists retirement on **September 30, 2028**.
It is a replaceable integration in `api\services.js`; confirm onboarding and
quota availability, and plan migration before that date. See
[Microsoft's lifecycle notice](https://learn.microsoft.com/en-us/azure/communication-services/acs-retirement-and-breaking-changes-guide).

## Code and validation

| Path | Purpose |
| --- | --- |
| `frontend\` | Public/internal UI, OTP login, program management, chunked upload, streaming retrieval |
| `api\portal.js` | Authentication, authorisation, intake, Defender gate, notification and deletion |
| `api\services.js` | Managed-identity Azure adapters and distributed blob-lease locks |
| `api\maintenance.js` | Retention cleanup, notification retry and expired-auth cleanup |
| `scanner\` | ClamAV worker, freshly updated signatures at image build |
| `scripts\upgrade.ps1` | Repeatable upgrade and deployment; generates secrets in the target environment |
| `scripts\build_media.py` | Official-icon architecture, locally narrated video and captions |
| `test-upload.ps1` | Interactive email-OTP CLI smoke test |

```powershell
Push-Location api
npm ci
npm test
Pop-Location
python -m unittest discover -s scanner -p test_scan.py
```

Tests cover OTP replay/expiry/attempt limits, cross-origin and cross-user denial,
department/program roles, exact block validation, multi-block integrity,
Defender event authentication and ETag checks, fail-closed scan errors,
delete-on-retrieval, and retention. Scanner tests use Azure SDK doubles.
`python .\scripts\test_frontend.py` adds an Edge browser smoke test with API
doubles (requires Playwright). `api\live-smoke.js` is an administrative VNet-only
integration check: it creates and removes a short-lived private test session,
uses real ClamAV/Defender and retrieval, and cleans its test programs/payloads.
It does **not** validate email inbox receipt or OTP and adds no application
authentication bypass endpoint.

`npm audit` currently flags the compressed-body body-parser advisory through
Express. JSON decompression is disabled and a regression test verifies rejection;
the report is **not** represented as clean. Reassess upstream patches regularly.

Build the customer media locally on Windows (no paid media service):

```powershell
# Requires an installed Edge browser and Windows System.Speech.
python -m pip install Pillow playwright imageio-ffmpeg
python .\scripts\build_media.py --output "$HOME\Downloads"
```

Azure service icon SVGs are from
[Microsoft's official architecture icon collection](https://learn.microsoft.com/en-us/azure/architecture/icons/),
used as service illustrations without modification. HTML embeds them for
offline sharing. The customer MP4 is delivered separately rather than storing
large media in Git history.

## API

All routes except health, OTP request/verify and the separately authenticated
Defender webhook require the opaque bearer session.

| Route | Purpose |
| --- | --- |
| `POST /api/auth/request`, `POST /api/auth/verify` | Email OTP sign-in/registration |
| `POST /api/auth/logout`, `GET /api/me` | Session and permissions |
| `GET /api/catalog` | Public department/program catalog; no recipient list exposed |
| `GET /api/admin/config` | Authorised departmental configuration |
| `PUT /api/admin/departments/:department` | Bootstrap admin delegates department admins |
| `PUT /api/admin/programs` | Department admin creates/updates programs |
| `POST /api/upload/init`, `PUT /api/upload/block`, `POST /api/upload/complete` | Chunked intake |
| `GET /api/status?id=...` | Owner-visible submission state |
| `GET /api/internal/submissions`, `GET /api/internal/download/:id` | Authorised staff retrieval |
| `POST /api/events/defender` | Authenticated Event Grid scan-result callback |

Normal states: `uploading` -> `queued` -> `scanning` -> `awaiting_defender` ->
`clean` -> `retrieved` / `expired`. `infected`, `error`, `defender_error` and
`oversize` remain non-downloadable. Payload deletion removes case details and
owner/filename fields; a minimal audit stub remains for 30 days. Registrations
and program configuration persist separately from uploaded payloads.
