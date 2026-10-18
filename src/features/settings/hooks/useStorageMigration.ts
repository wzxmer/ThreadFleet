import { useCallback, useEffect, useState } from "react";
import { getStorageStatus, manageStorage, setStorageMaintenance } from "@services/tauri";
import type { StorageStatus } from "@/types";

export function useStorageMigration() {
  const [status, setStatus] = useState<StorageStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    try { setStatus(await getStorageStatus()); setLoadError(null); }
    catch (cause) { setLoadError(String(cause)); }
  }, []);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try { const next = await getStorageStatus(); if (active) { setStatus(next); setLoadError(null); } }
      catch (cause) { if (active) setLoadError(String(cause)); }
    };
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);
  const perform = async (action: "schedule" | "cancel" | "retry" | "cleanup", root?: string) => {
    setBusy(true); setError(null);
    try { await manageStorage(action, root); await refresh(); return true; }
    catch (cause) { setError(String(cause)); return false; }
    finally { setBusy(false); }
  };
  const saveMaintenance = async (enabled: boolean, retentionDays: number) => {
    setBusy(true); setError(null);
    try { await setStorageMaintenance(enabled, retentionDays); await refresh(); }
    catch (cause) { setError(String(cause)); }
    finally { setBusy(false); }
  };
  return { status, error: error ?? loadError, busy, perform, saveMaintenance };
}
