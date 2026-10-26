const GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc";
const REQUEST_TIMEOUT_MS = 950;
const MIN_FALLBACK_MS = 350;

function clean(value, max = 300) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}

export function buildGdeltQuery(query) {
  const text = clean(query, 180).toLocaleLowerCase("ru-RU")
    .replace(/[«»„“”]/g, '"')
    .replace(/(?:самые\s+)?последние\s+новости/giu, " ")
    .replace(/новости/giu, " ")
    .replace(/(?:расскажи|скажи|найди|поищи|что нового|про|о|об|по теме)/giu, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (/(?:^|[^\p{L}])(?:озу|оперативк[\p{L}]*|оперативн[\p{L}]*\s+памят[\p{L}]*)(?:$|[^\p{L}])/iu.test(text)) {
    return '("RAM" OR "DRAM" OR "DDR5" OR "DDR4" OR "оперативная память")';
  }
  if (/(?:^|[^\p{L}])(?:видеокарт[\p{L}]*|графическ[\p{L}]*\s+карт[\p{L}]*|gpu)(?:$|[^\p{L}])/iu.test(text)) {
    return '("graphics card" OR GPU OR NVIDIA OR AMD)';
  }
  if (/(?:^|[^\p{L}])(?:процессор[\p{L}]*|cpu)(?:$|[^\p{L}])/iu.test(text)) {
    return '(CPU OR processor OR процессор OR Intel OR AMD)';
  }
  if (/(?:^|[^\p{L}])(?:технолог[\p{L}]*|техник[\p{L}]*|искусственн[\p{L}]*\s+интеллект[\p{L}]*|ии)(?:$|[^\p{L}])/iu.test(text)) {
    return '(technology OR AI OR semiconductor OR технологи*)';
  }

  return text || clean(query, 180);
}

function formatDate(raw) {
  const value = String(raw ?? "").trim();
  const m = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/);
  if (!m) return clean(value, 60);
  return `${m[3]}.${m[2]}.${m[1]} ${m[4]}:${m[5]} UTC`;
}

export function normalizeGdeltArticles(data, period = "day") {
  if (!data || !Array.isArray(data.articles)) {
    return { ok: false, results: null, reason: "invalid_response_shape" };
  }

  const seen = new Set();
  const results = data.articles.slice(0, 10).flatMap(article => {
    if (!article || typeof article !== "object") return [];
    const title = clean(article.title, 180);
    const url = clean(article.url, 500);
    if (!title || !/^https?:\/\//i.test(url) || seen.has(url)) return [];
    seen.add(url);
    return [{
      title,
      url,
      date: formatDate(article.seendate),
      snippet: clean(article.snippet || article.description || "", 300),
      source: clean(article.domain || article.sourcecountry || "", 80)
    }];
  });

  results.searchPeriod = period;
  return { ok: true, results, reason: results.length ? null : "empty" };
}

async function requestGdelt(query, period, timeoutMs, signal, fetchImpl, requestId) {
  if (timeoutMs < 100) return { ok: false, results: null, reason: "insufficient_time" };

  const url = new URL(GDELT_URL);
  url.searchParams.set("query", query);
  url.searchParams.set("mode", "ArtList");
  url.searchParams.set("format", "json");
  url.searchParams.set("sort", "DateDesc");
  url.searchParams.set("maxrecords", "10");
  url.searchParams.set("timespan", period === "week" ? "7d" : "1d");

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("GDELT request timed out", "TimeoutError")),
    Math.max(100, timeoutMs)
  );
  const combinedSignal = signal
    ? AbortSignal.any([controller.signal, signal])
    : controller.signal;
  const started = Date.now();

  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: combinedSignal
    });
    const raw = await response.text();
    if (!response.ok) {
      console.warn("GDELT news HTTP error:", {
        requestId, status: response.status, period,
        durationMs: Date.now() - started
      });
      return { ok: false, results: null, reason: "http_error" };
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      console.warn("GDELT news invalid JSON:", {
        requestId, period, durationMs: Date.now() - started
      });
      return { ok: false, results: null, reason: "invalid_json" };
    }

    const normalized = normalizeGdeltArticles(data, period);
    console.log("GDELT news response:", {
      requestId, period, durationMs: Date.now() - started,
      rawResultCount: Array.isArray(data.articles) ? data.articles.length : null,
      normalizedResultCount: normalized.results?.length ?? null,
      reason: normalized.reason
    });
    return normalized;
  } catch (error) {
    const timedOut = error?.name === "AbortError" ||
      error?.name === "TimeoutError" ||
      /timeout|timed out/i.test(String(error?.message || ""));
    console.warn("GDELT news request failed:", {
      requestId, period, durationMs: Date.now() - started,
      reason: timedOut ? "timeout" : "network_error",
      errorName: error?.name
    });
    return { ok: false, results: null, reason: timedOut ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search actual news articles using GDELT DOC 2.0 (public, no API key).
 * GDELT is primary; Serper is an optional independent fallback supplied by caller.
 * The entire chain is bounded by timeoutMs and never treats provider errors as empty results.
 */
export async function searchNews(query, {
  timeoutMs = 1900,
  signal,
  fetchImpl = globalThis.fetch,
  fallback,
  requestId
} = {}) {
  const started = Date.now();
  const deadline = started + Math.max(0, timeoutMs);
  const gdeltQuery = buildGdeltQuery(query);
  const remaining = () => deadline - Date.now();

  const first = await requestGdelt(
    gdeltQuery, "day", Math.min(REQUEST_TIMEOUT_MS, remaining() - MIN_FALLBACK_MS),
    signal, fetchImpl, requestId
  );

  if (first.ok && first.results.length) return first.results;

  // Empty one-day results get one wider GDELT query; provider failures can go
  // directly to the independent Serper fallback instead of waiting twice.
  if (first.ok && first.results.length === 0 && remaining() >= 550) {
    const weekly = await requestGdelt(
      gdeltQuery, "week", Math.min(650, remaining() - MIN_FALLBACK_MS),
      signal, fetchImpl, requestId
    );
    if (weekly.ok && weekly.results.length) return weekly.results;
    if (weekly.ok) {
      weekly.results.searchPeriod = "week";
      if (!fallback || remaining() < MIN_FALLBACK_MS) return weekly.results;
    }
  }

  if (typeof fallback === "function" && remaining() >= MIN_FALLBACK_MS) {
    const fallbackBudget = Math.max(0, Math.min(800, remaining()));
    console.log("News provider fallback:", {
      requestId, from: "gdelt", to: "serper",
      reason: first.reason || "empty_results",
      timeoutMs: fallbackBudget
    });
    try {
      const results = await fallback(fallbackBudget);
      if (Array.isArray(results)) return results;
    } catch (error) {
      console.warn("News fallback failed:", {
        requestId, errorName: error?.name, errorMessage: error?.message
      });
    }
  }

  // null means unavailable; [] means provider successfully returned no articles.
  if (first.ok) return first.results;
  return null;
}

export const __newsSearchInternals = { requestGdelt, formatDate };
