import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentCliCandidate, AgentEngine } from "@/types";
import { discoverAgentClis } from "@services/tauri";

export function useAgentCliDiscovery(
  engine: AgentEngine,
  configuredPath: string | null,
  executionHost: string,
) {
  const [candidates, setCandidates] = useState<AgentCliCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    const currentRequestId = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const result = await discoverAgentClis(engine);
      if (requestId.current === currentRequestId) {
        setCandidates(result);
      }
    } catch (failure) {
      if (requestId.current === currentRequestId) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      if (requestId.current === currentRequestId) {
        setLoading(false);
      }
    }
  }, [engine]);

  useEffect(() => {
    setCandidates([]);
    void refresh();
    return () => {
      requestId.current += 1;
    };
  }, [refresh, configuredPath, executionHost]);

  return { candidates, loading, error, refresh };
}
