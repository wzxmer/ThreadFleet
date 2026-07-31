import type { InstallerMigrationExecutionResult } from "@services/tauri";

export type InstallerMigrationDiagnosticReport = {
  schemaVersion: 1;
  generatedAt: string;
  appVersion: string;
  phase: string;
  status: InstallerMigrationExecutionResult["status"] | "ipcFailure";
  diagnosticCode: InstallerMigrationExecutionResult["diagnosticCode"] | "ipcFailure";
  rebootRequired: boolean;
};

export function buildInstallerMigrationDiagnosticReport(
  phase: string,
  result: InstallerMigrationExecutionResult | null,
  now = new Date(),
): InstallerMigrationDiagnosticReport {
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    appVersion: __APP_VERSION__,
    phase,
    status: result?.status ?? "ipcFailure",
    diagnosticCode: result?.diagnosticCode ?? "ipcFailure",
    rebootRequired: result?.rebootRequired ?? false,
  };
}

export function serializeInstallerMigrationDiagnosticReport(
  report: InstallerMigrationDiagnosticReport,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
