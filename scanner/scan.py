#!/usr/bin/env python3
"""Isolated ClamAV scan worker.

One short-lived, isolated container per uploaded file. Azure Container Apps
starts this job with UPLOAD_ID set; the container downloads the quarantined
blob, scans it with ClamAV, and either promotes the file to its department
container or isolates it as infected. The container is destroyed afterwards,
so nothing survives between scans.

All storage access uses a managed identity over a private endpoint - the
storage account permits neither shared keys nor public network access.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone

from azure.identity import DefaultAzureCredential
from azure.storage.blob import BlobServiceClient

ACCOUNT = os.environ["STORAGE_ACCOUNT_NAME"]
UPLOAD_ID = os.environ.get("UPLOAD_ID")

QUARANTINE_CONTAINER = "quarantine"
STATUS_CONTAINER = "status"
INFECTED_CONTAINER = "infected"

DEPARTMENT_CONTAINERS = {
    "sheriff": "sheriff",
    "public-health": "public-health",
    "corrections": "corrections",
}

# ClamAV cannot scan a file larger than 2 GiB - 1, regardless of the
# max-filesize setting, so anything larger is held rather than released.
MAX_SCAN_BYTES = 2 * 1024**3 - 1

credential = DefaultAzureCredential(
    managed_identity_client_id=os.environ.get("AZURE_CLIENT_ID")
)
blob_service = BlobServiceClient(
    f"https://{ACCOUNT}.blob.core.windows.net", credential=credential
)


def log(message):
    print(f"[{datetime.now(timezone.utc).isoformat()}] {message}", flush=True)


def read_record(upload_id):
    client = blob_service.get_blob_client(STATUS_CONTAINER, f"{upload_id}.json")
    return json.loads(client.download_blob().readall())


def write_record(record, state, message, **extra):
    record["state"] = state
    record["message"] = message
    record["updatedUtc"] = datetime.now(timezone.utc).isoformat()
    record.update(extra)
    blob_service.get_blob_client(
        STATUS_CONTAINER, f"{record['uploadId']}.json"
    ).upload_blob(json.dumps(record), overwrite=True, content_type="application/json")
    return record


def clamscan(path):
    """Return (is_clean, detail). Exit 0 = clean, 1 = infected, other = error."""
    result = subprocess.run(
        [
            "clamscan",
            "--no-summary",
            "--stdout",
            f"--max-filesize={MAX_SCAN_BYTES}",
            f"--max-scansize={MAX_SCAN_BYTES}",
            "--max-recursion=16",
            path,
        ],
        capture_output=True,
        text=True,
    )
    output = ((result.stdout or "") + (result.stderr or "")).strip()
    log(f"clamscan exit={result.returncode} output={output[:2000]}")

    if result.returncode == 0:
        return True, "No threats detected."
    if result.returncode == 1:
        signature = "unknown signature"
        for line in (result.stdout or "").splitlines():
            if line.strip().endswith("FOUND"):
                signature = line.rsplit(":", 1)[-1].replace("FOUND", "").strip()
                break
        return False, signature
    raise RuntimeError(f"clamscan failed with exit code {result.returncode}: {output}")


def promote(local_path, container, blob_name, content_type):
    destination = blob_service.get_blob_client(container, blob_name)
    with open(local_path, "rb") as handle:
        destination.upload_blob(
            handle,
            overwrite=True,
            max_concurrency=4,
            content_type=content_type or "application/octet-stream",
        )


def process(upload_id):
    record = read_record(upload_id)
    blob_name = record["blobName"]
    department = record["department"]

    if department not in DEPARTMENT_CONTAINERS:
        write_record(record, "error", f"Unknown department '{department}'.")
        return

    source = blob_service.get_blob_client(QUARANTINE_CONTAINER, blob_name)
    if not source.exists():
        write_record(record, "error", "The quarantined file no longer exists.")
        return

    properties = source.get_blob_properties()
    size = properties.size
    content_type = properties.content_settings.content_type

    if size > MAX_SCAN_BYTES:
        write_record(
            record,
            "error",
            "File exceeds the 2 GiB ClamAV scan limit, so it was not released. "
            "It remains in quarantine for manual review.",
        )
        return

    write_record(record, "scanning", "Scanning in an isolated container with ClamAV.")

    workdir = tempfile.mkdtemp(prefix="scan-", dir="/tmp")
    local_path = os.path.join(workdir, "payload.bin")
    try:
        log(f"downloading {blob_name} ({size} bytes)")
        with open(local_path, "wb") as handle:
            source.download_blob(max_concurrency=4).readinto(handle)

        is_clean, detail = clamscan(local_path)

        if is_clean:
            destination = DEPARTMENT_CONTAINERS[department]
            promote(local_path, destination, blob_name, content_type)
            source.delete_blob()
            write_record(
                record,
                "clean",
                "No threats found. Stored in the "
                f"{record.get('departmentName', department)} container "
                f"as {blob_name}.",
                storedContainer=destination,
            )
        else:
            promote(local_path, INFECTED_CONTAINER, blob_name, content_type)
            source.delete_blob()
            write_record(
                record,
                "infected",
                f"Threat detected ({detail}). The file was rejected and isolated; "
                "it was not stored in the department container.",
                signature=detail,
                storedContainer=INFECTED_CONTAINER,
            )
    finally:
        shutil.rmtree(workdir, ignore_errors=True)


def main():
    if not UPLOAD_ID:
        log("UPLOAD_ID is not set; nothing to scan.")
        return 0

    log(f"processing upload {UPLOAD_ID}")
    try:
        process(UPLOAD_ID)
    except Exception as err:  # noqa: BLE001 - surface the failure to the user
        log(f"scan failed: {err}")
        try:
            write_record(read_record(UPLOAD_ID), "error", f"Scan failed: {err}")
        except Exception as inner:  # noqa: BLE001
            log(f"could not record failure: {inner}")
        return 1

    log("run complete")
    return 0


if __name__ == "__main__":
    sys.exit(main())
