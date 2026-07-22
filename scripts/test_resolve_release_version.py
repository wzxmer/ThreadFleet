import json
import unittest
from pathlib import Path

from scripts.resolve_release_version import parse_internal_version, resolve_release_version


class ResolveReleaseVersionTests(unittest.TestCase):
    def test_increments_latest_patch(self) -> None:
        self.assertEqual(
            resolve_release_version("0.7.93", ["v0.7.99", "v0.7.100"]),
            ("0.7.101", "0.7.101"),
        )

    def test_keeps_public_label_aligned_with_internal_version(self) -> None:
        self.assertEqual(
            resolve_release_version("0.8.1", ["v0.7.100"]),
            ("0.8.1", "0.8.1"),
        )

    def test_increments_legacy_padded_tag_without_reintroducing_padding(self) -> None:
        self.assertEqual(
            resolve_release_version("0.8.1", ["v0.8.01"]),
            ("0.8.2", "0.8.2"),
        )

    def test_keeps_project_config_when_newer_than_existing_tags(self) -> None:
        current = str(
            json.loads(Path("src-tauri/tauri.conf.json").read_text(encoding="utf-8"))[
                "version"
            ]
        )
        self.assertEqual(
            resolve_release_version(current, ["v0.8.01", "v0.8.02"]),
            (current, current),
        )

    def test_rejects_leading_zero_in_internal_version(self) -> None:
        with self.assertRaisesRegex(ValueError, "without leading zeroes"):
            parse_internal_version("0.8.01")


if __name__ == "__main__":
    unittest.main()
