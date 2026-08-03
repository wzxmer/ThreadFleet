import { useEffect, useRef, useState } from "react";
import { getWorkspaceThirdPartyKeyUsage } from "@/services/tauri";
import {
  mergeThirdPartyUsageSnapshots,
  type ThirdPartyKeyUsageSnapshot,
} from "../utils/thirdPartyKeyUsage";

const THIRD_PARTY_KEY_USAGE_REFRESH_MS = 60_000;

type UseThirdPartyKeyUsageArgs = {
  enabled: boolean;
  workspaceId: string | null | undefined;
  profileId?: string | null;
  profileRevision?: number | string;
};

type UsageState = {
  requestKey: string;
  snapshot: ThirdPartyKeyUsageSnapshot | null;
};

export function useThirdPartyKeyUsage({
  enabled,
  workspaceId,
  profileId,
  profileRevision,
}: UseThirdPartyKeyUsageArgs): ThirdPartyKeyUsageSnapshot | null {
  const [state, setState] = useState<UsageState | null>(null);
  const snapshotCacheRef = useRef(
    new Map<string, ThirdPartyKeyUsageSnapshot | null>(),
  );
  const trimmedWorkspaceId = workspaceId?.trim() ?? "";
  const requestKey =
    enabled && trimmedWorkspaceId
      ? JSON.stringify([
          profileId?.trim() || "__default__",
          profileRevision ?? 0,
          trimmedWorkspaceId,
        ])
      : null;

  useEffect(() => {
    if (!requestKey) {
      setState(null);
      return;
    }

    let canceled = false;
    const cachedSnapshot = snapshotCacheRef.current.get(requestKey) ?? null;
    setState({ requestKey, snapshot: cachedSnapshot });

    const refresh = () => {
      getWorkspaceThirdPartyKeyUsage(trimmedWorkspaceId)
        .then((nextSnapshot) => {
          if (!canceled) {
            const mergedSnapshot = mergeThirdPartyUsageSnapshots(
              nextSnapshot,
              snapshotCacheRef.current.get(requestKey) ?? null,
            );
            snapshotCacheRef.current.set(requestKey, mergedSnapshot);
            setState({ requestKey, snapshot: mergedSnapshot });
          }
        })
        .catch(() => {
          // Preserve only a trusted snapshot for this exact Profile/workspace identity.
        });
    };

    refresh();
    const intervalId = window.setInterval(refresh, THIRD_PARTY_KEY_USAGE_REFRESH_MS);

    return () => {
      canceled = true;
      window.clearInterval(intervalId);
    };
  }, [requestKey, trimmedWorkspaceId]);

  if (!requestKey) {
    return null;
  }
  if (state?.requestKey === requestKey) {
    return state.snapshot;
  }
  return snapshotCacheRef.current.get(requestKey) ?? null;
}
