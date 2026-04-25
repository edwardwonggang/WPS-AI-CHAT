export function normalizeBenchmark(input) {
  if (!input || typeof input !== "object") {
    return null;
  }

  return {
    status: String(input.status ?? "untested"),
    ok: Boolean(input.ok),
    firstByteMs: Number.isFinite(Number(input.firstByteMs))
      ? Number(input.firstByteMs)
      : null,
    firstTokenMs: Number.isFinite(Number(input.firstTokenMs))
      ? Number(input.firstTokenMs)
      : null,
    totalMs: Number.isFinite(Number(input.totalMs))
      ? Number(input.totalMs)
      : null,
    message: String(input.message ?? "")
  };
}

export function createModelEntry(item, previous = null) {
  return {
    id: item.id,
    ownedBy: item.ownedBy,
    benchmark: normalizeBenchmark(previous?.benchmark)
  };
}

export function normalizeModelCatalogState(items) {
  const seen = new Set();

  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      id: String(item?.id ?? "").trim(),
      ownedBy: String(item?.ownedBy ?? item?.owned_by ?? "").trim(),
      benchmark: normalizeBenchmark(item?.benchmark)
    }))
    .filter((item) => {
      if (!item.id || seen.has(item.id)) {
        return false;
      }

      seen.add(item.id);
      return true;
    });
}

function statusRank(entry) {
  switch (entry.benchmark?.status ?? "untested") {
    case "ok":
      return 0;
    case "timeout":
      return 2;
    case "unsupported":
    case "unauthorized":
      return 3;
    case "error":
      return 4;
    default:
      return 5;
  }
}

export function compareModelEntries(left, right, currentModel) {
  const rankDiff = statusRank(left) - statusRank(right);
  if (rankDiff !== 0) {
    return rankDiff;
  }

  const leftToken = left.benchmark?.firstTokenMs;
  const rightToken = right.benchmark?.firstTokenMs;

  if (
    Number.isFinite(leftToken) &&
    Number.isFinite(rightToken) &&
    leftToken !== rightToken
  ) {
    return leftToken - rightToken;
  }

  if (Number.isFinite(leftToken) && !Number.isFinite(rightToken)) {
    return -1;
  }

  if (!Number.isFinite(leftToken) && Number.isFinite(rightToken)) {
    return 1;
  }

  if (left.id === currentModel && right.id !== currentModel) {
    return -1;
  }

  if (right.id === currentModel && left.id !== currentModel) {
    return 1;
  }

  return left.id.localeCompare(right.id);
}

export function applyBenchmarkResult(entries, result) {
  return entries.map((entry) =>
    entry.id === result.model
      ? {
          ...entry,
          benchmark: normalizeBenchmark(result)
        }
      : entry
  );
}

function formatLatency(value) {
  if (!Number.isFinite(value)) {
    return "";
  }

  return `${Math.round(value)} ms`;
}

export function benchmarkLabel(entry) {
  switch (entry.benchmark?.status ?? "untested") {
    case "ok":
      return entry.benchmark?.firstTokenMs
        ? `First valid output ${formatLatency(entry.benchmark.firstTokenMs)}`
        : "Available";
    case "timeout":
      return "Timed out";
    case "unsupported":
      return "Unsupported";
    case "unauthorized":
      return "Unauthorized";
    case "error":
      return "Request failed";
    default:
      return "Not benchmarked";
  }
}

export function benchmarkClassName(entry) {
  return `status-pill ${entry.benchmark?.status ?? "untested"}`;
}

export function benchmarkStatusText(entry) {
  switch (entry.benchmark?.status ?? "untested") {
    case "ok":
      return "Ready";
    case "timeout":
      return "Timeout";
    case "unsupported":
      return "Unsupported";
    case "unauthorized":
      return "Unauthorized";
    case "error":
      return "Error";
    default:
      return "Untested";
  }
}
