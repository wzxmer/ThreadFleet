import { useEffect, useState } from "react";
import { useI18n } from "@/features/i18n/I18nProvider";
import type { CodexCliUpdaterState } from "../hooks/useCodexCliUpdater";

export function CodexCliUpdateProgress({ state }: { state: CodexCliUpdaterState }) {
  const { t } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (state.stage !== "installing" || !state.startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.stage, state.startedAt]);
  const progress = state.progress;
  const phase = progress?.phase;
  const phaseKey = phase === "connecting" ? "codexUpdate.connecting"
    : phase === "extracting" ? "codexUpdate.extracting"
    : phase === "verifying" ? "codexUpdate.verifying"
    : phase === "downloading" ? "codexUpdate.downloadProgress" : "codexUpdate.installing";
  const routeKey = progress?.route === "system-proxy" ? "codexUpdate.systemProxy"
    : progress?.route === "environment-proxy" ? "codexUpdate.environmentProxy"
    : progress?.route === "direct" ? "codexUpdate.direct" : null;
  const total = progress?.totalBytes;
  const percent = total && total > 0 ? Math.min(100, Math.round(progress!.downloadedBytes / total * 100)) : null;
  const seconds = state.startedAt ? Math.max(0, Math.floor(((state.finishedAt ?? now) - state.startedAt) / 1000)) : null;
  return (
    <div className="update-toast-progress" role="status">
      <div className="update-toast-progress-meta">
        {t(phaseKey)}{phase === "downloading" && progress ? ` · ${percent === null ? `${(progress.downloadedBytes / 1024 / 1024).toFixed(1)} MB` : `${percent}%`}` : ""}
        {routeKey ? ` · ${t(routeKey)}` : ""}
        {seconds !== null ? ` · ${t("codexUpdate.elapsed").replace("{seconds}", String(seconds))}` : ""}
      </div>
      {phase === "downloading" && percent !== null && (
        <div className="update-toast-progress-bar" role="progressbar" aria-label={t("codexUpdate.downloadProgress")}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <span className="update-toast-progress-fill" style={{ width: `${percent}%` }} />
        </div>
      )}
    </div>
  );
}
