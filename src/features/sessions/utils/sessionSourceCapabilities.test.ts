import { describe, expect, it } from "vitest";
import type { SessionSource } from "@/types";
import {
  getSessionSourceAdapterLabel,
  getSessionSourceCapabilities,
  getSessionSourceCapabilityLevel,
  getSessionSourceHostLabel,
  sessionSourceSupports,
} from "./sessionSourceCapabilities";

const legacySource: SessionSource = {
  id: "source-a",
  name: "Legacy",
  codexHomePath: "C:/Users/test/.codex",
  enabled: true,
  isCurrent: true,
  isDefault: true,
  discoveredAt: 1,
  lastScanAt: null,
  status: "ready",
  error: null,
};

describe("session source capabilities", () => {
  it("keeps old local Codex source responses fully compatible", () => {
    expect(getSessionSourceCapabilities(legacySource).resumeInApp).toBe(true);
    expect(sessionSourceSupports(legacySource, "delete")).toBe(true);
  });

  it("honors fail-closed capabilities returned by the backend", () => {
    const unsupported: SessionSource = {
      ...legacySource,
      status: "unsupported",
      capabilities: {
        browse: false,
        preview: false,
        search: false,
        derive: false,
        archive: false,
        delete: false,
        openExternal: false,
        resumeInApp: false,
      },
    };

    expect(sessionSourceSupports(unsupported, "preview")).toBe(false);
    expect(sessionSourceSupports(unsupported, "archive")).toBe(false);
    expect(getSessionSourceCapabilityLevel(unsupported)).toBe("unavailable");
  });

  it("describes legacy and hosted sources without exposing raw enum values", () => {
    const t = (key: string) => key;
    expect(getSessionSourceAdapterLabel(legacySource, t)).toBe(
      "sessionManager.sourceAdapterCodex",
    );
    expect(getSessionSourceHostLabel(legacySource, t)).toBe(
      "sessionManager.sourceHostLocal",
    );

    const wslSource: SessionSource = {
      ...legacySource,
      adapterKind: "codex",
      host: { kind: "wsl", id: "Ubuntu", platform: "linux" },
    };
    expect(getSessionSourceHostLabel(wslSource, t)).toBe(
      "sessionManager.sourceHostWsl: Ubuntu - sessionManager.sourcePlatformLinux",
    );

    const macSource: SessionSource = {
      ...legacySource,
      adapterKind: "claudeCode",
      host: { kind: "local", id: null, platform: "macos" },
    };
    expect(getSessionSourceHostLabel(macSource, t)).toBe(
      "sessionManager.sourceHostLocal - sessionManager.sourcePlatformMacos",
    );
  });
});
