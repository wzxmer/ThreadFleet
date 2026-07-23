from __future__ import annotations

import argparse
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping
from urllib.parse import urlparse


@dataclass(frozen=True)
class ProviderSpec:
    name: str
    update_keys: tuple[str, str]
    cli_keys: tuple[str, str]
    publisher_keys: tuple[str, ...]


@dataclass(frozen=True)
class ProviderStatus:
    name: str
    enabled_features: tuple[str, ...]
    errors: tuple[str, ...]

    @property
    def state(self) -> str:
        if self.errors:
            return "invalid"
        if self.enabled_features:
            return "enabled"
        return "disabled"


PROVIDERS = (
    ProviderSpec(
        name="Tencent COS",
        update_keys=("TENCENT_UPDATE_BASE_URL", "TENCENT_UPDATE_MANIFEST_URL"),
        cli_keys=(
            "TENCENT_CODEX_CLI_BASE_URL",
            "TENCENT_CODEX_CLI_MANIFEST_URL",
        ),
        publisher_keys=(
            "TENCENT_COS_BUCKET",
            "TENCENT_COS_REGION",
            "TENCENT_COS_SECRET_ID",
            "TENCENT_COS_SECRET_KEY",
        ),
    ),
    ProviderSpec(
        name="Aliyun OSS",
        update_keys=("ALIYUN_UPDATE_BASE_URL", "ALIYUN_UPDATE_MANIFEST_URL"),
        cli_keys=(
            "ALIYUN_CODEX_CLI_BASE_URL",
            "ALIYUN_CODEX_CLI_MANIFEST_URL",
        ),
        publisher_keys=(
            "ALIYUN_OSS_BUCKET",
            "ALIYUN_OSS_ENDPOINT",
            "ALIYUN_OSS_ACCESS_KEY_ID",
            "ALIYUN_OSS_ACCESS_KEY_SECRET",
        ),
    ),
)

SECRET_FLAGS = {
    "TENCENT_COS_SECRET_ID": "TENCENT_COS_SECRET_ID_CONFIGURED",
    "TENCENT_COS_SECRET_KEY": "TENCENT_COS_SECRET_KEY_CONFIGURED",
    "ALIYUN_OSS_ACCESS_KEY_ID": "ALIYUN_OSS_ACCESS_KEY_ID_CONFIGURED",
    "ALIYUN_OSS_ACCESS_KEY_SECRET": "ALIYUN_OSS_ACCESS_KEY_SECRET_CONFIGURED",
}


def _is_true(value: str | None) -> bool:
    return value is not None and value.strip().lower() in {"1", "true", "yes"}


def read_config(environ: Mapping[str, str]) -> dict[str, str]:
    config = {key: value.strip() for key, value in environ.items()}
    for secret_name, flag_name in SECRET_FLAGS.items():
        config[secret_name] = "configured" if _is_true(environ.get(flag_name)) else ""
    return config


def _validate_group(
    provider: ProviderSpec,
    label: str,
    keys: tuple[str, ...],
    config: Mapping[str, str],
) -> tuple[bool, list[str]]:
    configured = [key for key in keys if config.get(key, "")]
    if not configured:
        return False, []
    missing = [key for key in keys if not config.get(key, "")]
    if missing:
        return False, [
            f"{provider.name} {label} configuration is incomplete; missing: "
            + ", ".join(missing)
        ]
    return True, []


def _validate_https_urls(keys: tuple[str, ...], config: Mapping[str, str]) -> list[str]:
    errors: list[str] = []
    for key in keys:
        value = config.get(key, "")
        if not value:
            continue
        parsed = urlparse(value)
        if parsed.scheme != "https" or not parsed.netloc:
            errors.append(f"{key} must be an absolute HTTPS URL")
    return errors


def validate_provider(
    provider: ProviderSpec,
    config: Mapping[str, str],
) -> ProviderStatus:
    update_enabled, update_errors = _validate_group(
        provider, "app update", provider.update_keys, config
    )
    cli_enabled, cli_errors = _validate_group(
        provider, "Codex CLI", provider.cli_keys, config
    )
    publisher_enabled, publisher_errors = _validate_group(
        provider, "publisher", provider.publisher_keys, config
    )

    errors = update_errors + cli_errors + publisher_errors
    discovery_enabled = update_enabled or cli_enabled
    if discovery_enabled and not publisher_enabled and not publisher_errors:
        errors.append(
            f"{provider.name} download routes are configured without complete upload credentials"
        )
    if publisher_enabled and not discovery_enabled and not update_errors and not cli_errors:
        errors.append(
            f"{provider.name} upload credentials are configured without any download route"
        )

    errors.extend(
        _validate_https_urls(provider.update_keys + provider.cli_keys, config)
    )
    features: list[str] = []
    if update_enabled:
        features.append("app update")
    if cli_enabled:
        features.append("Codex CLI")
    return ProviderStatus(provider.name, tuple(features), tuple(errors))


def validate_config(environ: Mapping[str, str]) -> tuple[ProviderStatus, ...]:
    config = read_config(environ)
    return tuple(validate_provider(provider, config) for provider in PROVIDERS)


def build_summary(statuses: tuple[ProviderStatus, ...]) -> str:
    lines = [
        "## Release mirror configuration",
        "",
        "| Provider | State | Routes |",
        "| --- | --- | --- |",
    ]
    for status in statuses:
        routes = ", ".join(status.enabled_features) or "GitHub-only"
        lines.append(f"| {status.name} | {status.state} | {routes} |")
    errors = [error for status in statuses for error in status.errors]
    if errors:
        lines.extend(["", "### Configuration errors", ""])
        lines.extend(f"- {error}" for error in errors)
    return "\n".join(lines) + "\n"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--github-summary", type=Path)
    args = parser.parse_args()

    statuses = validate_config(os.environ)
    summary = build_summary(statuses)
    if args.github_summary:
        with args.github_summary.open("a", encoding="utf-8") as handle:
            handle.write(summary)
    else:
        print(summary, end="")

    errors = [error for status in statuses for error in status.errors]
    if errors:
        raise SystemExit("Invalid release mirror configuration:\n- " + "\n- ".join(errors))


if __name__ == "__main__":
    main()
