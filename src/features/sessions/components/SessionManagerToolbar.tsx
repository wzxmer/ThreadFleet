import { useMemo, useState } from "react";
import ArrowDown from "lucide-react/dist/esm/icons/arrow-down";
import ArrowUp from "lucide-react/dist/esm/icons/arrow-up";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import Search from "lucide-react/dist/esm/icons/search";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal";
import X from "lucide-react/dist/esm/icons/x";
import { useI18n } from "@/features/i18n/I18nProvider";
import type { SessionManagerState } from "../hooks/useSessionManager";
import type { SessionManagerDatePreset } from "../utils/sessionManagerFilters";

type Props = { manager: SessionManagerState };

function projectLabel(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized.split("/").filter(Boolean).pop() ?? path;
}

export function SessionManagerToolbar({ manager }: Props) {
  const { t } = useI18n();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const dateLabel = (preset: SessionManagerDatePreset) => ({
    all: t("sessionManager.dateAll"),
    today: t("sessionManager.today"),
    yesterday: t("sessionManager.yesterday"),
    last7: t("sessionManager.last7Days"),
    last30: t("sessionManager.last30Days"),
    thisWeek: t("sessionManager.thisWeek"),
    thisMonth: t("sessionManager.thisMonth"),
    custom: t("sessionManager.customDate"),
    unknown: t("sessionManager.unknownTime"),
  })[preset];
  const dateFieldLabel = manager.dateField === "createdAt"
    ? t("sessionManager.createdAt")
    : manager.dateField === "archivedAt"
      ? t("sessionManager.archivedAt")
      : t("sessionManager.lastUsed");
  const fileStatusLabel = (value: string) => ({
    mapped: t("sessionManager.fileStatusMapped"),
    unmapped: t("sessionManager.fileStatusUnmapped"),
    missing: t("sessionManager.fileStatusMissing"),
    invalid: t("sessionManager.fileStatusInvalid"),
  })[value as "mapped" | "unmapped" | "missing" | "invalid"] ?? value;
  const confidenceLabel = (value: string) => ({
    exact: t("sessionManager.confidenceExact"),
    inferred: t("sessionManager.confidenceInferred"),
    ambiguous: t("sessionManager.confidenceAmbiguous"),
    none: t("sessionManager.confidenceNone"),
  })[value as "exact" | "inferred" | "ambiguous" | "none"] ?? value;
  const sourceName = manager.sources.find((source) => source.id === manager.sourceFilter)?.name ?? manager.sourceFilter;
  const chips = useMemo(() => {
    const values: Array<{ id: string; label: string; remove: () => void }> = [];
    if (manager.datePreset !== "all" || manager.dateField !== "updatedAt") values.push({ id: "date", label: `${dateFieldLabel}: ${dateLabel(manager.datePreset)}`, remove: () => { manager.setDateField("updatedAt"); manager.setDatePreset("all"); manager.setCustomDateStart(""); manager.setCustomDateEnd(""); } });
    if (manager.storageFilter !== "all") values.push({ id: "storage", label: manager.storageFilter === "local" ? t("sessionManager.localStorage") : t("sessionManager.archived"), remove: () => manager.setStorageFilter("all") });
    if (manager.sourceFilter !== "all") values.push({ id: "source", label: sourceName, remove: () => manager.setSourceFilter("all") });
    if (manager.sessionTypeFilter !== "all") values.push({ id: "type", label: manager.sessionTypeFilter === "main" ? t("sessionManager.mainSession") : t("sessionManager.subagent"), remove: () => manager.setSessionTypeFilter("all") });
    if (manager.projectMode !== "all") values.push({ id: "project", label: manager.projectMode === "current" ? t("sessionManager.currentProject") : manager.projectMode === "missing" ? t("sessionManager.missing") : `${t("sessionManager.selectedProjects")} ${manager.projectPaths.length}`, remove: () => manager.setProjectMode("all") });
    if (manager.sourceKindFilter !== "all") values.push({ id: "sourceKind", label: manager.sourceKindFilter, remove: () => manager.setSourceKindFilter("all") });
    if (manager.fileStatusFilter !== "all") values.push({ id: "fileStatus", label: fileStatusLabel(manager.fileStatusFilter), remove: () => manager.setFileStatusFilter("all") });
    if (manager.fileConfidenceFilter !== "all") values.push({ id: "confidence", label: confidenceLabel(manager.fileConfidenceFilter), remove: () => manager.setFileConfidenceFilter("all") });
    if (manager.subagentQuery.trim()) values.push({ id: "subagent", label: manager.subagentQuery.trim(), remove: () => manager.setSubagentQuery("") });
    return values;
  }, [dateFieldLabel, manager, sourceName, t]);

  return (
    <div className="session-manager-toolbar">
      <div className="session-manager-search-field">
        <Search size={14} aria-hidden />
        <input value={manager.query} onChange={(event) => manager.setQuery(event.target.value)} placeholder={t("sessionManager.search")} aria-label={t("sessionManager.search")} />
        {manager.query && <button type="button" data-button-elevation="none" onClick={() => manager.setQuery("")} aria-label={t("sidebar.clearSearch")}><X size={13} aria-hidden /></button>}
      </div>

      <div className="session-manager-scope-bar">
        <div className="session-manager-scope-tabs" role="group" aria-label={t("sessionManager.storageFilter")}>
          <button type="button" className={manager.storageFilter === "all" ? "is-active" : ""} data-button-elevation="none" aria-pressed={manager.storageFilter === "all"} onClick={() => manager.setStorageFilter("all")}>
            <span>{t("sessionManager.all")}</span>
          </button>
          <button type="button" className={manager.storageFilter === "local" ? "is-active" : ""} data-button-elevation="none" aria-pressed={manager.storageFilter === "local"} onClick={() => manager.setStorageFilter("local")}>
            <span>{t("sessionManager.localStorage")}</span>
          </button>
          <button type="button" className={manager.storageFilter === "archived" ? "is-active" : ""} data-button-elevation="none" aria-pressed={manager.storageFilter === "archived"} onClick={() => manager.setStorageFilter("archived")}>
            <span>{t("sessionManager.archived")}</span>
          </button>
        </div>
      </div>

      <div className="session-manager-quick-filters">
        <select value={manager.datePreset} onChange={(event) => manager.setDatePreset(event.target.value as SessionManagerDatePreset)} aria-label={t("sessionManager.dateFilter")}>
          <option value="all">{t("sessionManager.dateAll")}</option>
          <option value="today">{t("sessionManager.today")}</option>
          <option value="yesterday">{t("sessionManager.yesterday")}</option>
          <option value="last7">{t("sessionManager.last7Days")}</option>
          <option value="last30">{t("sessionManager.last30Days")}</option>
          <option value="thisWeek">{t("sessionManager.thisWeek")}</option>
          <option value="thisMonth">{t("sessionManager.thisMonth")}</option>
          <option value="custom">{t("sessionManager.customDate")}</option>
          <option value="unknown">{t("sessionManager.unknownTime")}</option>
        </select>
        <select value={manager.projectMode} onChange={(event) => { manager.setProjectMode(event.target.value as typeof manager.projectMode); if (event.target.value === "selected") setFiltersOpen(true); }} aria-label={t("sessionManager.projectFilter")}>
          <option value="all">{t("sessionManager.allProjects")}</option>
          <option value="current" disabled={!manager.currentProjectPath}>{t("sessionManager.currentProject")}</option>
          <option value="missing">{t("sessionManager.missing")}</option>
          <option value="selected">{t("sessionManager.selectedProjects")}</option>
        </select>
        <select value={manager.sourceFilter} onChange={(event) => manager.setSourceFilter(event.target.value)} aria-label={t("sessionManager.sourceFilter")}>
          <option value="all">{t("sessionManager.allSources")}</option>
          {manager.sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
        </select>
        <select value={manager.sessionTypeFilter} onChange={(event) => manager.setSessionTypeFilter(event.target.value as typeof manager.sessionTypeFilter)} aria-label={t("sessionManager.sessionTypeFilter")}>
          <option value="all">{t("sessionManager.allTypes")}</option>
          <option value="main">{t("sessionManager.mainSession")}</option>
          <option value="subagent">{t("sessionManager.subagent")}</option>
        </select>
        <div className="session-manager-sort-control is-wide">
          <select value={manager.sortField} onChange={(event) => manager.setSortField(event.target.value as typeof manager.sortField)} aria-label={t("sessionManager.sortField")}>
            <option value="updatedAt">{t("sessionManager.sortByLastUsed")}</option>
            <option value="createdAt">{t("sessionManager.sortByCreatedAt")}</option>
            <option value="archivedAt">{t("sessionManager.sortByArchivedAt")}</option>
          </select>
          <button type="button" data-button-elevation="none" onClick={() => manager.setSortDirection(manager.sortDirection === "desc" ? "asc" : "desc")} aria-label={t("sessionManager.sortDirection")} title={manager.sortDirection === "desc" ? t("sessionManager.descending") : t("sessionManager.ascending")}>
            {manager.sortDirection === "desc" ? <ArrowDown size={13} aria-hidden /> : <ArrowUp size={13} aria-hidden />}
          </button>
        </div>
      </div>

      {manager.datePreset === "custom" && <div className="session-manager-date-range">
        <label><span>{t("sessionManager.dateStart")}</span><input type="date" value={manager.customDateStart} onChange={(event) => manager.setCustomDateStart(event.target.value)} /></label>
        <label><span>{t("sessionManager.dateEnd")}</span><input type="date" value={manager.customDateEnd} onChange={(event) => manager.setCustomDateEnd(event.target.value)} /></label>
      </div>}

      <div className="session-manager-filter-summary">
        <span>{t("sessionManager.resultCount")} <strong>{manager.filteredSessionCount}</strong> / {manager.totalSessionCount}</span>
        <button type="button" className={filtersOpen ? "is-open" : ""} data-button-elevation="none" onClick={() => setFiltersOpen((current) => !current)} aria-expanded={filtersOpen}>
          <SlidersHorizontal size={13} aria-hidden />{t("sessionManager.filterConditions")}{manager.activeFilterCount > 0 && <span>{manager.activeFilterCount}</span>}<ChevronDown size={12} aria-hidden />
        </button>
      </div>

      {chips.length > 0 && <div className="session-manager-filter-chips">
        {chips.map((chip) => <button type="button" key={chip.id} data-button-elevation="none" onClick={chip.remove} title={chip.label}><span>{chip.label}</span><X size={11} aria-hidden /></button>)}
        <button type="button" className="session-manager-clear-filters" data-button-elevation="none" onClick={manager.clearFilters}>{t("sessionManager.clearFilters")}</button>
      </div>}

      {filtersOpen && <div className="session-manager-filter-panel">
        <label><span>{t("sessionManager.dateField")}</span><select value={manager.dateField} onChange={(event) => manager.setDateField(event.target.value as typeof manager.dateField)}><option value="updatedAt">{t("sessionManager.lastUsed")}</option><option value="createdAt">{t("sessionManager.createdAt")}</option><option value="archivedAt">{t("sessionManager.archivedAt")}</option></select></label>
        <label><span>{t("sessionManager.sourceKind")}</span><select value={manager.sourceKindFilter} onChange={(event) => manager.setSourceKindFilter(event.target.value)}><option value="all">{t("sessionManager.all")}</option>{manager.sourceKindOptions.map((value) => <option key={value} value={value}>{value}</option>)}</select></label>
        <label><span>{t("sessionManager.fileStatus")}</span><select value={manager.fileStatusFilter} onChange={(event) => manager.setFileStatusFilter(event.target.value)}><option value="all">{t("sessionManager.all")}</option>{manager.fileStatusOptions.map((value) => <option key={value} value={value}>{fileStatusLabel(value)}</option>)}</select></label>
        <label><span>{t("sessionManager.fileConfidence")}</span><select value={manager.fileConfidenceFilter} onChange={(event) => manager.setFileConfidenceFilter(event.target.value)}><option value="all">{t("sessionManager.all")}</option>{manager.fileConfidenceOptions.map((value) => <option key={value} value={value}>{confidenceLabel(value)}</option>)}</select></label>
        <label className="session-manager-filter-panel-wide"><span>{t("sessionManager.subagentIdentity")}</span><input value={manager.subagentQuery} onChange={(event) => manager.setSubagentQuery(event.target.value)} /></label>
        {(manager.projectMode === "selected" || manager.projectPaths.length > 0) && <fieldset className="session-manager-project-options"><legend>{t("sessionManager.projectSelection")}</legend>{manager.projectOptions.map((path) => <label key={path} title={path}><input type="checkbox" checked={manager.projectPaths.includes(path)} onChange={() => manager.toggleProjectPath(path)} /><span>{projectLabel(path)}</span></label>)}</fieldset>}
      </div>}
    </div>
  );
}
