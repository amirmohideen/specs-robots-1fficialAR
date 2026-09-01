import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from bridge.local_wss_helper import (
    LocalWssHelper,
    cert_paths,
    create_pairing,
    load_config,
    save_config,
    token_hash,
)


class LocalWssHelperTests(unittest.TestCase):
    def test_config_is_private_and_round_trips(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            save_config(directory, {"device_secret": "secret", "hostname": "device.example"})
            self.assertEqual(load_config(directory)["device_secret"], "secret")
            self.assertEqual((directory / "config.json").stat().st_mode & 0o777, 0o600)

    def test_pairing_stores_only_hash_locally(self):
        with tempfile.TemporaryDirectory() as raw:
            directory = Path(raw)
            config = {
                "device_id": "d-test",
                "device_secret": "device-secret",
                "control_plane": "https://example.invalid",
                "controller_token_hashes": [],
            }
            with mock.patch(
                "bridge.local_wss_helper.api_request",
                return_value={"code": "12345678", "expires_in": 600},
            ) as request:
                result = create_pairing(directory, config)
            self.assertEqual(result["code"], "12345678")
            sent_token = request.call_args.args[3]["bearer_token"]
            self.assertNotIn(sent_token, json.dumps(load_config(directory)))
            self.assertIn(token_hash(sent_token), load_config(directory)["controller_token_hashes"])

    def test_token_validation_uses_hash(self):
        token = "a" * 40
        helper = LocalWssHelper(
            Path("/tmp/unused"),
            {"controller_token_hashes": [token_hash(token)]},
            "ws://127.0.0.1:8097/ws",
        )
        self.assertTrue(helper.token_is_valid(token))
        self.assertFalse(helper.token_is_valid("b" * 40))

    def test_certificate_paths_stay_under_config_directory(self):
        certificate, key = cert_paths(Path("/tmp/helper"), "d-123.arm.example")
        self.assertEqual(certificate, Path("/tmp/helper/acme/live/d-123.arm.example/fullchain.pem"))
        self.assertEqual(key.name, "privkey.pem")


if __name__ == "__main__":
    unittest.main()
