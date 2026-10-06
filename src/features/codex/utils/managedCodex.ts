import type { ManagedCodexPackage } from "@/types";
export type { ManagedCodexPackage } from "@/types";

type ManagedCodexManifest = {
  version?: string;
  packages?: Record<string, {
    fileName?: string;
    urls?: string[];
    size?: number;
    sha256?: string;
  }>;
};

const DEFAULT_MANIFEST_URL =
  "https://github.com/wzxmer/ThreadFleet/releases/latest/download/codex-cli-latest.json";

export const MANAGED_CODEX_MANIFEST_URLS = [
  import.meta.env.VITE_TENCENT_CODEX_CLI_MANIFEST_URL,
  import.meta.env.VITE_ALIYUN_CODEX_CLI_MANIFEST_URL,
  DEFAULT_MANIFEST_URL,
].filter((value): value is string => Boolean(value?.trim()));

export async function fetchManagedCodexPackage(
  platform: string,
  manifestUrls: string[] = MANAGED_CODEX_MANIFEST_URLS,
): Promise<ManagedCodexPackage> {
  const errors: string[] = [];
  for (const manifestUrl of manifestUrls) {
    try {
      const response = await fetch(manifestUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as ManagedCodexManifest;
      const item = payload.packages?.[platform];
      const version = payload.version?.trim();
      const fileName = item?.fileName?.trim();
      const urls = item?.urls?.filter((url) => url.startsWith("https://")) ?? [];
      const sha256 = item?.sha256?.trim().toLowerCase();
      if (
        !version ||
        !fileName ||
        urls.length === 0 ||
        !Number.isFinite(item?.size) ||
        (item?.size ?? 0) <= 0 ||
        !sha256 ||
        !/^[a-f0-9]{64}$/.test(sha256)
      ) {
        throw new Error("Invalid manifest payload");
      }
      return {
        version,
        fileName,
        urls,
        size: item?.size as number,
        sha256,
      };
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`无法获取 Codex CLI 下载信息：${errors.join(" | ")}`);
}
