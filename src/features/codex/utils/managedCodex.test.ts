import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchManagedCodexPackage } from "./managedCodex";
import { getOfficialCodexPackage } from "@services/tauri";

vi.mock("@services/tauri", () => ({ getOfficialCodexPackage: vi.fn() }));

const officialPackage = {
  version: "0.166.0",
  fileName: "codex-package-x86_64-pc-windows-msvc.tar.gz",
  urls: ["https://github.com/openai/codex/releases/download/rust-v0.166.0/codex-package-x86_64-pc-windows-msvc.tar.gz"],
  size: 123,
  sha256: "b".repeat(64),
};

describe("fetchManagedCodexPackage", () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.resetAllMocks(); });

  it("falls back to the next manifest route", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("COS unavailable"))
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          version: "1.2.3",
          packages: {
            "windows-x86_64": {
              fileName: "codex-cli-1.2.3-windows-x86_64.zip",
              urls: ["https://oss.example.com/codex-cli.zip"],
              size: 100,
              sha256: "a".repeat(64),
            },
          },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);

    const packageInfo = await fetchManagedCodexPackage("windows-x86_64", [
      "https://cos.example.com/codex-cli-latest.json",
      "https://oss.example.com/codex-cli-latest.json",
    ]);

    expect(packageInfo.version).toBe("1.2.3");
    expect(packageInfo.urls).toEqual(["https://oss.example.com/codex-cli.zip"]);
    expect(getOfficialCodexPackage).not.toHaveBeenCalled();
  });

  it("falls back to the native official source when all TF manifests fail", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch (github.com)"));
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(getOfficialCodexPackage).mockResolvedValue(officialPackage);

    await expect(fetchManagedCodexPackage("windows-x86_64", [
      "https://cos.example.com/codex-cli-latest.json",
      "https://github.com/wzxmer/ThreadFleet/releases/latest/download/codex-cli-latest.json",
    ])).resolves.toEqual(officialPackage);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getOfficialCodexPackage).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(getOfficialCodexPackage).mock.invocationCallOrder[0],
    );
  });

  it.each([
    { ok: false, status: 404 },
    { ok: true, json: async () => ({ version: "0.166.0", packages: {} }) },
    { ok: true, json: async () => ({ version: "0.166.0", packages: { "windows-x86_64": { size: 0 } } }) },
    { ok: true, json: async () => { throw new SyntaxError("Invalid JSON"); } },
  ])("tries the official source when a TF manifest is unusable: %j", async (response) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    vi.mocked(getOfficialCodexPackage).mockResolvedValue(officialPackage);
    await expect(fetchManagedCodexPackage("windows-x86_64", ["https://example.com/manifest.json"]))
      .resolves.toEqual(officialPackage);
  });

  it("keeps both source failures when the official fallback is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("TF connection reset")));
    vi.mocked(getOfficialCodexPackage).mockRejectedValue("Official release timed out");
    await expect(fetchManagedCodexPackage("windows-x86_64", ["https://example.com/manifest.json"]))
      .rejects.toThrow(/ThreadFleet:.*TF connection reset.*OpenAI:.*Official release timed out/);
  });
});
