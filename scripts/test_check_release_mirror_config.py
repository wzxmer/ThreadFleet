import unittest

from scripts.check_release_mirror_config import build_summary, validate_config


class CheckReleaseMirrorConfigTests(unittest.TestCase):
    def test_allows_github_only_when_every_provider_is_empty(self) -> None:
        statuses = validate_config({})

        self.assertEqual([status.state for status in statuses], ["disabled", "disabled"])
        self.assertIn("GitHub-only", build_summary(statuses))

    def test_accepts_complete_tencent_app_update_route(self) -> None:
        statuses = validate_config(
            {
                "TENCENT_UPDATE_BASE_URL": "https://cos.example.com/releases",
                "TENCENT_UPDATE_MANIFEST_URL": "https://cos.example.com/latest.json",
                "TENCENT_COS_BUCKET": "threadfleet-123456",
                "TENCENT_COS_REGION": "ap-shanghai",
                "TENCENT_COS_SECRET_ID_CONFIGURED": "true",
                "TENCENT_COS_SECRET_KEY_CONFIGURED": "true",
            }
        )

        self.assertEqual(statuses[0].state, "enabled")
        self.assertEqual(statuses[0].enabled_features, ("app update",))
        self.assertEqual(statuses[0].errors, ())

    def test_rejects_partial_download_route(self) -> None:
        statuses = validate_config(
            {"ALIYUN_UPDATE_BASE_URL": "https://oss.example.com/releases"}
        )

        self.assertEqual(statuses[1].state, "invalid")
        self.assertIn("ALIYUN_UPDATE_MANIFEST_URL", statuses[1].errors[0])

    def test_rejects_download_route_without_publisher_credentials(self) -> None:
        statuses = validate_config(
            {
                "TENCENT_CODEX_CLI_BASE_URL": "https://cos.example.com",
                "TENCENT_CODEX_CLI_MANIFEST_URL": (
                    "https://cos.example.com/codex-cli-latest.json"
                ),
            }
        )

        self.assertEqual(statuses[0].state, "invalid")
        self.assertTrue(
            any("without complete upload credentials" in error for error in statuses[0].errors)
        )

    def test_rejects_publisher_credentials_without_download_route(self) -> None:
        statuses = validate_config(
            {
                "ALIYUN_OSS_BUCKET": "threadfleet",
                "ALIYUN_OSS_ENDPOINT": "oss-cn-shanghai.aliyuncs.com",
                "ALIYUN_OSS_ACCESS_KEY_ID_CONFIGURED": "yes",
                "ALIYUN_OSS_ACCESS_KEY_SECRET_CONFIGURED": "1",
            }
        )

        self.assertEqual(statuses[1].state, "invalid")
        self.assertTrue(
            any("without any download route" in error for error in statuses[1].errors)
        )

    def test_rejects_non_https_public_url(self) -> None:
        statuses = validate_config(
            {
                "TENCENT_UPDATE_BASE_URL": "http://cos.example.com/releases",
                "TENCENT_UPDATE_MANIFEST_URL": "https://cos.example.com/latest.json",
                "TENCENT_COS_BUCKET": "threadfleet-123456",
                "TENCENT_COS_REGION": "ap-shanghai",
                "TENCENT_COS_SECRET_ID_CONFIGURED": "true",
                "TENCENT_COS_SECRET_KEY_CONFIGURED": "true",
            }
        )

        self.assertEqual(statuses[0].state, "invalid")
        self.assertIn(
            "TENCENT_UPDATE_BASE_URL must be an absolute HTTPS URL",
            statuses[0].errors,
        )


if __name__ == "__main__":
    unittest.main()
