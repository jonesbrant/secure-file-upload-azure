"""Browser smoke test with HTTP API doubles; requires playwright and Edge."""

from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
from threading import Thread

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def main():
    program = {"id": "11111111-1111-4111-8111-111111111111", "name": "Permits",
               "retentionDays": 7, "recipients": ["staff@example.com"], "active": True}
    departments = [{"id": key, "name": name, "programs": [program] if key == "sheriff" else []}
                   for key, name in [("sheriff", "Sheriff"), ("public-health", "Public Health"), ("corrections", "Corrections")]]
    blocks, uploads, errors = [], [], []

    def api(route):
        request = route.request
        path = request.url.split("/api/", 1)[1]
        body = None
        status = 200
        if path == "auth/request":
            body = {"message": "A one-time code has been sent."}
        elif path == "auth/verify":
            body = {"token": "test-session-not-a-real-token"}
        elif path == "me":
            body = {"email": "admin@example.com", "adminDepartments": [d["id"] for d in departments],
                    "staffDepartments": ["sheriff"], "superAdmin": True}
        elif path == "catalog":
            body = {"departments": departments, "maxScanBytes": 2 * 1024**3 - 1}
        elif path == "admin/config":
            body = {"departments": [{"department": d["id"], "programs": d["programs"], "admins": []}
                                    for d in departments]}
        elif path == "internal/submissions":
            body = {"submissions": [{"uploadId": "test", "department": "sheriff", "programId": program["id"],
                                    "fileName": "<img src=x onerror=alert(1)>", "state": "awaiting_defender",
                                    "expiresUtc": "2099-01-01T00:00:00Z", "reference": "CASE-1", "details": "Test"}]}
        elif path == "upload/init":
            uploads.append(request.post_data_json)
            body = {"uploadId": "browser-test"}
            status = 201
        elif path.startswith("upload/block"):
            assert request.headers.get("authorization") == "Bearer test-session-not-a-real-token"
            blocks.append(len(request.post_data_buffer))
            status = 201
        elif path == "upload/complete":
            assert request.post_data_json["blockCount"] == 3
            body = {"state": "queued"}
            status = 202
        elif path.startswith("status?"):
            body = {"state": "clean", "message": "Both scans passed."}
        elif path == "auth/logout":
            status = 204
        else:
            raise AssertionError(f"Unexpected API request: {path}")
        route.fulfill(status=status, content_type="application/json",
                      headers={"Access-Control-Allow-Origin": "*"},
                      body="" if body is None else json.dumps(body))

    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(SimpleHTTPRequestHandler, directory=str(ROOT / "frontend")))
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(channel="msedge", headless=True)
            page = browser.new_page()
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.route("**/api/**", api)
            page.goto(f"http://127.0.0.1:{server.server_port}")
            page.locator("#email").fill("admin@example.com")
            page.locator("#requestCode").click()
            expect(page.locator("#verifyForm")).to_be_visible()
            page.locator("#code").fill("12345678")
            page.locator("#verifyForm button").click()
            expect(page.locator("#portal")).to_be_visible()
            expect(page.locator("#department option")).to_have_count(4)
            page.locator("#staffTab").click()
            expect(page.locator("#adminView")).to_be_visible()
            expect(page.locator("#submissions h3")).to_have_text("<img src=x onerror=alert(1)>")
            expect(page.locator("#submissions img")).to_have_count(0)
            expect(page.locator("#submissions button")).to_be_disabled()
            page.locator("#publicTab").click()
            page.locator("#department").select_option("sheriff")
            page.locator("#program").select_option(program["id"])
            page.locator("#reference").fill("CASE-123")
            page.locator("#details").fill("First line\nSecond line")
            page.locator("#file").set_input_files({"name": "large-test.bin", "mimeType": "application/octet-stream",
                                                  "buffer": b"A" * (16 * 1024**2 + 41)})
            page.locator("#upload").click()
            expect(page.locator("#status")).to_have_text("Both scans passed.", timeout=15000)
            assert sorted(blocks) == [41, 8 * 1024**2, 8 * 1024**2]
            assert uploads[0]["reference"] == "CASE-123"
            assert uploads[0]["details"] == "First line\nSecond line"
            page.locator("#logout").click()
            expect(page.locator("#login")).to_be_visible()
            assert not errors, errors
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("PASS: OTP UI, department/program selection, staff gate, safe text rendering, 3-chunk upload, metadata, and sign-out.")


if __name__ == "__main__":
    main()
