import { useCallback, useEffect, useRef, useState } from "react";
import type { WindowsControlMcpConfig, WindowsControlProvider } from "@/types";
import { getWindowsControlMcp, setWindowsControlMcp } from "@services/tauri";

export function useWindowsControlMcp(sourceKey: string | null | undefined) {
  const [config, setConfig] = useState<WindowsControlMcpConfig | null>(null);
  const [provider, setProvider] = useState<WindowsControlProvider>("sbroenne");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("[]");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const epoch = useRef(0);
  const invalidate = useCallback(() => { ++epoch.current; }, []);

  const accept = useCallback((next: WindowsControlMcpConfig) => {
    setConfig(next);
    setProvider(next.provider);
    setCommand(next.profiles[next.provider]?.command ?? "");
    setArgs(JSON.stringify(next.profiles[next.provider]?.args ?? []));
  }, []);

  const refresh = useCallback(async () => {
    const id = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      const next = await getWindowsControlMcp();
      if (id === epoch.current) { accept(next); setSaved(false); }
    } catch (err) {
      if (id === epoch.current) setError(String(err));
    } finally {
      if (id === epoch.current) setBusy(false);
    }
  }, [accept]);

  useEffect(() => {
    setConfig(null);
    void refresh();
    return invalidate;
  }, [sourceKey, refresh, invalidate]);

  const select = (next: WindowsControlProvider) => {
    setProvider(next);
    setCommand(config?.profiles[next]?.command ?? "");
    setArgs(JSON.stringify(config?.profiles[next]?.args ?? []));
    setError(null);
    setSaved(false);
  };

  const save = async () => {
    if (!config || busy) return false;
    let parsed: unknown;
    try { parsed = JSON.parse(args); } catch { return "invalidArgs" as const; }
    if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) return "invalidArgs" as const;
    const id = ++epoch.current;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await setWindowsControlMcp({ provider, command, args: parsed, revision: config.revision });
      if (id !== epoch.current) return false;
      accept(next);
      setSaved(true);
      return true;
    } catch (err) {
      if (id === epoch.current) setError(String(err));
      return false;
    } finally {
      if (id === epoch.current) setBusy(false);
    }
  };

  return { config, provider, command, args, busy, error, saved, refresh, select, save,
    setCommand: (value: string) => { setCommand(value); setSaved(false); },
    setArgs: (value: string) => { setArgs(value); setSaved(false); },
  };
}
