from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import config_control
import menagerie
import shelf_bridge


class PerModelBridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="menagerie-per-model-", dir="/tmp/opencode")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.trials = self.root / "trials"
        (self.trials / "shelf").mkdir(parents=True)
        (self.trials / "shelf/engines.toml").write_text("fixture marker")
        (self.trials / "shelf.ini").write_text("version=1\n[*]\nload-on-startup=false\n[a]\nctx-size=8192\n")
        self.store = config_control.Store(self.root / "state", self.trials)

    def test_legacy_draft_apply_and_revert_are_blocked_before_side_effects(self):
        for call in (lambda: self.store.draft("a", {"ctx-size": 4096}, "old"),
                     lambda: self.store.rollback_draft("0" * 32),
                     lambda: self.store.queue("0" * 32, "RESTART SHELF", True, lambda _: self.fail("launched"))):
            with self.assertRaisesRegex(config_control.ControlError, "read-only"):
                call()
        self.assertFalse(menagerie.control_available(self.store))

    def test_missing_staged_engine_file_does_not_reenable_legacy_writes(self):
        (self.trials / "shelf/engines.toml").unlink()
        self.assertTrue(self.store.per_model)
        with self.assertRaisesRegex(config_control.ControlError, "read-only"):
            self.store.draft("a", {"ctx-size": 4096}, "old")

    def test_current_config_exposes_authoritative_read_only_inventory(self):
        configuration = {"fingerprint": "a" * 64, "models": {"served": {"runtime": {"ctx-size": 32768}}}}
        with patch.object(shelf_bridge, "candidate", return_value=configuration), \
             patch.object(shelf_bridge, "inventory", return_value={"served": {"ctx-size": "32768"}}):
            result = self.store.current()
            self.assertTrue(result["read_only"])
            self.assertEqual(result["models"], {"served": {"ctx-size": "32768"}})
            self.assertEqual(menagerie.config_inventory(self.trials), result["models"])

    def test_preexisting_queued_job_cannot_modify_legacy_file_or_services(self):
        original = (self.trials / "shelf.ini").read_text()
        job = self.store.save_draft("a", original, original.replace("8192", "4096"), {})
        self.store.update(job["id"], "queued", "fixture legacy transaction")
        with patch.object(config_control, "Runtime") as runtime:
            config_control.execute(self.store, job["id"])
            runtime.assert_not_called()
        self.assertEqual(self.store.get(job["id"])["status"], "failed")
        self.assertEqual((self.trials / "shelf.ini").read_text(), original)

    def test_loader_reads_real_shelf_without_loading_a_model(self):
        trials = Path.home() / "ai/qwen38-trials"
        if not shelf_bridge.enabled(trials):
            self.skipTest("desktop shelf not installed")
        configuration = shelf_bridge.candidate(trials)
        result = shelf_bridge.inventory(trials, configuration)
        self.assertEqual(set(result), set(configuration["models"]))
        for model_id, spec in configuration['models'].items():
            self.assertEqual(result[model_id]['ctx-size'], str(spec['runtime']['ctx-size']))


if __name__ == "__main__":
    unittest.main()
