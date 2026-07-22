import Archive from "lucide-react/dist/esm/icons/archive";
import CalendarDays from "lucide-react/dist/esm/icons/calendar-days";
import FolderX from "lucide-react/dist/esm/icons/folder-x";
import HardDrive from "lucide-react/dist/esm/icons/hard-drive";
import { useI18n } from "@/features/i18n/I18nProvider";
import type { SessionManagerState } from "../hooks/useSessionManager";

type Props = Pick<SessionManagerState, "stats" | "sources">;

function projectLabel(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() ?? path;
}

export function SessionManagerOverview({ stats, sources }: Props) {
  const { t } = useI18n();
  const sourceNames = new Map(sources.map((source) => [source.id, source.name]));
  const activityMax = Math.max(1, ...stats.recentActivity.map((item) => item.count));
  return (
    <div className="session-manager-overview">
      <div className="session-manager-overview-stats">
        <div><CalendarDays size={16} aria-hidden /><span>{t("sessionManager.overviewToday")}</span><strong>{stats.today}</strong></div>
        <div><HardDrive size={16} aria-hidden /><span>{t("sessionManager.overviewLocal")}</span><strong>{stats.local}</strong></div>
        <div><Archive size={16} aria-hidden /><span>{t("sessionManager.overviewArchived")}</span><strong>{stats.archived}</strong></div>
        <div><FolderX size={16} aria-hidden /><span>{t("sessionManager.overviewMissing")}</span><strong>{stats.missingProjects}</strong></div>
      </div>
      <section className="session-manager-overview-section">
        <h2>{t("sessionManager.recentActivity")}</h2>
        <div className="session-manager-activity-chart">
          {stats.recentActivity.map((item) => <div key={item.date} className="session-manager-activity-day" title={`${item.date}: ${item.count}`}>
            <div><span style={{ height: `${Math.max(item.count > 0 ? 8 : 2, (item.count / activityMax) * 100)}%` }} /></div>
            <strong>{item.count}</strong>
            <span>{item.date.slice(5)}</span>
          </div>)}
        </div>
      </section>
      <div className="session-manager-overview-distributions">
        <section className="session-manager-overview-section">
          <h2>{t("sessionManager.projectDistribution")}</h2>
          <div className="session-manager-distribution-list">
            {stats.projects.slice(0, 6).map((item) => <div key={item.path} title={item.path}><span>{projectLabel(item.path)}</span><strong>{item.count}</strong></div>)}
          </div>
        </section>
        <section className="session-manager-overview-section">
          <h2>{t("sessionManager.sourceDistribution")}</h2>
          <div className="session-manager-distribution-list">
            {stats.sources.slice(0, 6).map((item) => <div key={item.sourceId}><span>{sourceNames.get(item.sourceId) ?? item.sourceId}</span><strong>{item.count}</strong></div>)}
          </div>
        </section>
      </div>
    </div>
  );
}
