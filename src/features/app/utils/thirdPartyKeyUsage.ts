export type ThirdPartyKeyUsageSnapshot = {
  balanceUsd: number | null;
  balanceScope?: "account" | "token";
  todayCostUsd: number | null;
  totalCostUsd: number | null;
  spendPeriod: "today" | "total" | null;
  averageLatencyMs: number | null;
  isUnlimited: boolean;
  isPartial: boolean;
  source: "sub2" | "new-api" | "page" | null;
};

export function mergeThirdPartyUsageSnapshots(
  primary: ThirdPartyKeyUsageSnapshot | null,
  fallback: ThirdPartyKeyUsageSnapshot | null,
): ThirdPartyKeyUsageSnapshot | null {
  if (!primary) return fallback;
  if (!fallback) return primary;

  const primaryBalanceScope =
    primary.balanceScope ?? (primary.source === "page" ? "account" : undefined);
  const fallbackBalanceScope =
    fallback.balanceScope ?? (fallback.source === "page" ? "account" : undefined);
  const primaryHasAccountBalance =
    primary.balanceUsd !== null && primaryBalanceScope !== "token";
  const fallbackHasAccountBalance =
    fallback.balanceUsd !== null && fallbackBalanceScope !== "token";
  const usePrimaryBalance =
    primaryHasAccountBalance ||
    (!fallbackHasAccountBalance && primary.balanceUsd !== null);
  const balanceUsd = usePrimaryBalance ? primary.balanceUsd : fallback.balanceUsd;
  const balanceScope = usePrimaryBalance
    ? primaryBalanceScope
    : fallbackBalanceScope ?? primaryBalanceScope;
  const todayCostUsd = primary.todayCostUsd ?? fallback.todayCostUsd;
  const totalCostUsd = primary.totalCostUsd ?? fallback.totalCostUsd;

  return {
    balanceUsd,
    ...(balanceScope ? { balanceScope } : {}),
    todayCostUsd,
    totalCostUsd,
    spendPeriod: todayCostUsd !== null ? "today" : totalCostUsd !== null ? "total" : null,
    averageLatencyMs: primary.averageLatencyMs ?? fallback.averageLatencyMs,
    isUnlimited: balanceUsd === null && primary.isUnlimited,
    isPartial: primary.isPartial && fallback.isPartial,
    source: primary.source ?? fallback.source,
  };
}

type ThirdPartyUsageTodayPayload = {
  actual_cost?: unknown;
};

type ThirdPartyUsagePayload = {
  balanceUsd?: unknown;
  balanceScope?: unknown;
  todayCostUsd?: unknown;
  totalCostUsd?: unknown;
  spendPeriod?: unknown;
  averageLatencyMs?: unknown;
  isUnlimited?: unknown;
  isPartial?: unknown;
  source?: unknown;
  balance?: unknown;
  remaining?: unknown;
  today_actual_cost?: unknown;
  total_actual_cost?: unknown;
  today_cost?: unknown;
  total_cost?: unknown;
  usage?: {
    today?: ThirdPartyUsageTodayPayload;
    average_duration_ms?: unknown;
  };
  subscription?: {
    daily_usage_usd?: unknown;
  };
};

function parseNumericValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const numeric = Number(trimmed.replace(/[$,\s]/g, ""));
  return Number.isFinite(numeric) ? numeric : null;
}

export function buildThirdPartyUsageUrl(baseUrl: string | null | undefined): string | null {
  const raw = baseUrl?.trim();
  if (!raw) {
    return null;
  }
  try {
    const parsed = new URL(raw.includes("://") ? raw : `https://${raw}`);
    const path = parsed.pathname.replace(/\/+$/, "");
    parsed.pathname = `${path || "/v1"}/usage`;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

export function normalizeThirdPartyUsagePayload(
  payload: unknown,
): ThirdPartyKeyUsageSnapshot | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const data = payload as ThirdPartyUsagePayload;
  const canonicalBalanceUsd = parseNumericValue(data.balanceUsd);
  const canonicalBalanceScope =
    data.balanceScope === "account" || data.balanceScope === "token"
      ? data.balanceScope
      : null;
  const canonicalTodayCostUsd = parseNumericValue(data.todayCostUsd);
  const canonicalTotalCostUsd = parseNumericValue(data.totalCostUsd);
  const canonicalAverageLatencyMs = parseNumericValue(data.averageLatencyMs);
  const canonicalSpendPeriod =
    data.spendPeriod === "today" || data.spendPeriod === "total" ? data.spendPeriod : null;
  const canonicalSource =
    data.source === "sub2" || data.source === "new-api" || data.source === "page"
      ? data.source
      : null;
  const hasCanonicalShape =
    "balanceUsd" in data ||
    "todayCostUsd" in data ||
    "totalCostUsd" in data ||
    "isUnlimited" in data;
  if (hasCanonicalShape) {
    const isUnlimited = data.isUnlimited === true;
    if (
      canonicalBalanceUsd === null &&
      canonicalTodayCostUsd === null &&
      canonicalTotalCostUsd === null &&
      canonicalAverageLatencyMs === null &&
      !isUnlimited
    ) {
      return null;
    }
    return {
      balanceUsd: canonicalBalanceUsd,
      ...(canonicalBalanceScope ? { balanceScope: canonicalBalanceScope } : {}),
      todayCostUsd: canonicalTodayCostUsd,
      totalCostUsd: canonicalTotalCostUsd,
      spendPeriod:
        canonicalSpendPeriod ??
        (canonicalTodayCostUsd !== null
          ? "today"
          : canonicalTotalCostUsd !== null
            ? "total"
            : null),
      averageLatencyMs: canonicalAverageLatencyMs,
      isUnlimited,
      isPartial: data.isPartial === true,
      source: canonicalSource,
    };
  }
  const balanceUsd =
    parseNumericValue(data.balance) ?? parseNumericValue(data.remaining);
  const todayCostUsd =
    parseNumericValue(data.today_actual_cost) ??
    parseNumericValue(data.today_cost) ??
    parseNumericValue(data.usage?.today?.actual_cost) ??
    parseNumericValue(data.subscription?.daily_usage_usd);
  const totalCostUsd =
    parseNumericValue(data.total_actual_cost) ??
    parseNumericValue(data.total_cost);
  const averageLatencyMs = parseNumericValue(data.usage?.average_duration_ms);

  if (
    balanceUsd === null &&
    todayCostUsd === null &&
    totalCostUsd === null &&
    averageLatencyMs === null
  ) {
    return null;
  }
  return {
    balanceUsd,
    todayCostUsd,
    totalCostUsd,
    spendPeriod: todayCostUsd !== null ? "today" : totalCostUsd !== null ? "total" : null,
    averageLatencyMs,
    isUnlimited: false,
    isPartial: false,
    source: null,
  };
}
