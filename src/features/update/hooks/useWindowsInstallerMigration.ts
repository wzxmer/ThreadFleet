import { useCallback, useRef, useState } from "react";
import {
  executeWindowsInstallerMigration,
  type InstallerMigrationExecutionResult,
} from "@services/tauri";

export type WindowsInstallerMigrationPhase =
  | "idle"
  | "executing"
  | "completed"
  | "rolledBack"
  | "blocked"
  | "interrupted"
  | "error";

export type WindowsInstallerMigrationState = {
  phase: WindowsInstallerMigrationPhase;
  result: InstallerMigrationExecutionResult | null;
  error: string | null;
};

const INITIAL_STATE: WindowsInstallerMigrationState = {
  phase: "idle",
  result: null,
  error: null,
};

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function phaseForResult(
  result: InstallerMigrationExecutionResult,
): WindowsInstallerMigrationPhase {
  switch (result.status) {
    case "completed":
      return "completed";
    case "rolledBack":
      return "rolledBack";
    case "blocked":
      return "blocked";
    case "interrupted":
      return "interrupted";
    default:
      return "error";
  }
}

export function useWindowsInstallerMigration() {
  const [state, setState] =
    useState<WindowsInstallerMigrationState>(INITIAL_STATE);
  const busyRef = useRef(false);

  const execute = useCallback(async () => {
    if (busyRef.current) return null;

    busyRef.current = true;
    setState({
      phase: "executing",
      result: null,
      error: null,
    });
    try {
      const result = await executeWindowsInstallerMigration();
      const phase = phaseForResult(result);
      setState({
        phase,
        result,
        error: phase === "error" ? (result.message ?? result.status) : null,
      });
      return result;
    } catch (error) {
      setState({
        phase: "error",
        result: null,
        error: errorMessage(error),
      });
      return null;
    } finally {
      busyRef.current = false;
    }
  }, []);

  const reset = useCallback(() => {
    if (!busyRef.current) setState(INITIAL_STATE);
  }, []);

  return {
    state,
    execute,
    reset,
    busy: state.phase === "executing",
    canResume: state.phase === "interrupted",
  };
}
