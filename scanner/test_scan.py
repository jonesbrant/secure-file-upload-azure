"""Worker unit tests; Azure services and clamscan are isolated test doubles."""

import importlib.util
import sys
import types
import unittest
from unittest.mock import MagicMock, patch
import os
from datetime import datetime, timedelta, timezone

os.environ.setdefault("STORAGE_ACCOUNT_NAME", "example")
identity = types.ModuleType("azure.identity")
identity.DefaultAzureCredential = MagicMock()
storage = types.ModuleType("azure.storage.blob")
storage.BlobServiceClient = MagicMock()
sys.modules.update({"azure": types.ModuleType("azure"), "azure.identity": identity,
                    "azure.storage": types.ModuleType("azure.storage"), "azure.storage.blob": storage})
spec = importlib.util.spec_from_file_location("worker", os.path.join(os.path.dirname(__file__), "scan.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ScanTests(unittest.TestCase):
    def test_clean_and_limit_alert_flags(self):
        with patch.object(worker.subprocess, "run", return_value=types.SimpleNamespace(
                returncode=0, stdout="payload: OK", stderr="")) as run:
            self.assertEqual(worker.clamscan("payload"), (True, "No threats detected."))
            self.assertIn("--alert-exceeds-max=yes", run.call_args.args[0])
            self.assertIn("--alert-encrypted=yes", run.call_args.args[0])

    def test_infected(self):
        with patch.object(worker.subprocess, "run", return_value=types.SimpleNamespace(
                returncode=1, stdout="payload: Eicar-Test-Signature FOUND", stderr="")):
            self.assertEqual(worker.clamscan("payload"), (False, "Eicar-Test-Signature"))

    def test_scan_error_is_not_clean(self):
        with patch.object(worker.subprocess, "run", return_value=types.SimpleNamespace(
                returncode=2, stdout="", stderr="Scan failed")):
            with self.assertRaises(RuntimeError):
                worker.clamscan("payload")

    def test_clean_worker_waits_for_defender(self):
        record = {"uploadId": "id", "department": "sheriff", "programId": "program",
                  "blobName": "program/id/file", "expiresUtc": (datetime.now(timezone.utc) +
                  timedelta(days=1)).isoformat()}
        source = MagicMock()
        source.get_blob_properties.return_value = types.SimpleNamespace(size=10,
            content_settings=types.SimpleNamespace(content_type="application/octet-stream"))
        with patch.object(worker, "read_record", return_value=record), \
             patch.object(worker, "blob_service") as service, \
             patch.object(worker, "write_record") as write, \
             patch.object(worker, "clamscan", return_value=(True, "Clean")), \
             patch.object(worker, "promote") as promote:
            service.get_blob_client.return_value = source
            worker.process("id")
            states = [call.args[1] for call in write.call_args_list]
            self.assertEqual(states, ["scanning", "awaiting_defender"])
            self.assertEqual(promote.call_args.args[1], "sheriff")
            source.delete_blob.assert_called_once()

    def test_oversize_file_stays_quarantined(self):
        source = MagicMock()
        source.get_blob_properties.return_value = types.SimpleNamespace(size=2 ** 31,
            content_settings=types.SimpleNamespace(content_type="application/octet-stream"))
        record = {"uploadId": "id", "department": "sheriff", "programId": "program",
                  "blobName": "program/id/file", "expiresUtc": (datetime.now(timezone.utc) +
                  timedelta(days=1)).isoformat()}
        with patch.object(worker, "read_record", return_value=record), \
             patch.object(worker, "blob_service") as service, \
             patch.object(worker, "write_record") as write:
            service.get_blob_client.return_value = source
            worker.process("id")
            self.assertEqual(write.call_args.args[1], "error")
            source.delete_blob.assert_not_called()


if __name__ == "__main__":
    unittest.main()
