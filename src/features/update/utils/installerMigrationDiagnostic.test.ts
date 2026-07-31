import { describe, expect, it } from "vitest";
import {
  buildInstallerMigrationDiagnosticReport,
  serializeInstallerMigrationDiagnosticReport,
} from "./installerMigrationDiagnostic";

describe("installer migration diagnostics", () => {
  it("exports only the public diagnostic allowlist", () => {
    const report = buildInstallerMigrationDiagnosticReport(
      "blocked",
      {
        status: "blocked",
        diagnosticCode: "ownershipBlocked",
        rebootRequired: false,
        transactionId: "secret-transaction",
        message: "C:\\Users\\Secret S-1-5-21 grant-token",
      },
      new Date("2026-07-29T00:00:00.000Z"),
    );
    const json = serializeInstallerMigrationDiagnosticReport(report);

    expect(JSON.parse(json)).toEqual({
      schemaVersion: 1,
      generatedAt: "2026-07-29T00:00:00.000Z",
      appVersion: __APP_VERSION__,
      phase: "blocked",
      status: "blocked",
      diagnosticCode: "ownershipBlocked",
      rebootRequired: false,
    });
    expect(json).not.toContain("Secret");
    expect(json).not.toContain("S-1-5-21");
    expect(json).not.toContain("grant-token");
    expect(json).not.toContain("secret-transaction");
  });
});
