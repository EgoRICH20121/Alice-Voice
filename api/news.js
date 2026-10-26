const GDELT_URL = "https://api.gdeltproject.org/api/v2/doc/doc";

function clean(value, max = 300) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}

function topicText(query) {
  return clean(query, 180).toLocaleLowerCase("ru-RU")
    .replace(/[«»„“”]/g, '"')
    .replace(/(?:самые\s+)?последние\s+новости/giu, " ")
    .replace(/новости/giu, " ")
    .replace(/(?:расскажи|скажи|найди|поищи|что нового|по теме)/giu, " ")
    .replace(/(?<![\p{L}])(?:про|о|об)(?![\p{L}])/giu, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function buildSerperNewsQuery(query) {
  const text = topicText(query);
  if (/(?:^|[^\p{L}])(?:озу|оперативк[\p{L}]*|оперативн[\p{L}]*\s+памят[\p{L}]*)(?:$|[^\p{L}])/iu.test(text)) {
    return "оперативная память RAM DRAM DDR5 DDR4";
  }
  if (/(?:^|[^\p{L}])(?:видеокарт[\p{L}]*|графическ[\p{L}]*\s+карт[\p{L}]*|gpu)(?:$|[^\p{L}])/iu.test(text)) {
    return "видеокарты graphics cards GPU NVIDIA AMD";
  }
  if (/(?:^|[^\p{L}])(?:процессор[\p{L}]*|cpu)(?:$|[^\p{L}])/iu.test(text)) {
    return "процессоры CPU Intel AMD";
  }
  if (/(?:^|[^\p{L}])(?:технолог[\p{L}]*|техник[\p{L}]*|искусственн[\p{L}]*\s+интеллект[\p{L}]*|ии)(?:$|[^\p{L}])/iu.test(text)) {
    return "технологии искусственный интеллект AI semiconductor";
  }
  return text || clean(query, 180);
}

export function buildGdeltQuery(query) {
  const text = topicText(query);
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
  return m[3] + "." + m[2] + "." + m[1] + " " + m[4] + ":" + m[5] + " UTC";
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
    timeoutMs
  );
  const combinedSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
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
        requestId, status: response.status, period, durationMs: Date.now() - started
      });
      return { ok: false, results: null, reason: "http_error" };
    }
    let data;
    try { data = JSON.parse(raw); }
    catch {
      console.warn("GDELT news invalid JSON:", { requestId, period, durationMs: Date.now() - started });
      return { ok: false, results: null, reason: "invalid_json" };
    }
    const normalized = normalizeGdeltArticles(data, period);
    console.log("news_provider_done:", {
      requestId, provider: "gdelt", period, durationMs: Date.now() - started,
      status: response.status,
      rawCount: Array.isArray(data.articles) ? data.articles.length : null,
      count: normalized.results?.length ?? null, reason: normalized.reason
    });
    return normalized;
  } catch (error) {
    const timedOut = error?.name === "AbortError" || error?.name === "TimeoutError" ||
      /timeout|timed out/i.test(String(error?.message || ""));
    console.warn("GDELT news request failed:", {
      requestId, period, durationMs: Date.now() - started,
      reason: timedOut ? "timeout" : "network_error", errorName: error?.name
    });
    return { ok: false, results: null, reason: timedOut ? "timeout" : "network_error" };
  } finally {
    clearTimeout(timer);
  }
}

function validProviderResult(value) {
  if (value === null || value === undefined) return { ok: false, results: null, reason: "failed" };
  if (!Array.isArray(value)) return { ok: false, results: null, reason: "invalid_result" };
  const results = value.filter(item =>
    item && typeof item === "object" &&
    clean(item.title, 180) &&
    /^https?:\/\//i.test(String(item.url || ""))
  ).slice(0, 6).map(item => ({
    title: clean(item.title, 180),
    url: clean(item.url, 500),
    date: clean(item.date, 60),
    snippet: clean(item.snippet, 300),
    source: clean(item.source, 80)
  }));
  results.searchPeriod = value.searchPeriod || "day";
  return { ok: true, results, reason: results.length ? null : "empty" };
}

/* Search Serper and GDELT concurrently under one hard deadline. */
export async function searchNews(query, {
  timeoutMs = 2000, signal, fetchImpl = globalThis.fetch, fallback, requestId
} = {}) {
  const started = Date.now();
  const budget = Math.max(100, Number(timeoutMs) || 0);
  const deadline = started + budget;
  const controller = new AbortController();
  const combinedSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const gdeltQuery = buildGdeltQuery(query);
  const serperQuery = buildSerperNewsQuery(query);
  const settled = [];
  let pending = 0;
  let resolveDone;
  const done = new Promise(resolve => { resolveDone = resolve; });

  const record = (name, result) => {
    settled.push({ name, ...result });
    console.log("news_provider_done:", {
      requestId, provider: name, ok: result.ok,
      count: result.results?.length ?? null, reason: result.reason ?? null,
      durationMs: Date.now() - started
    });
    if (result.ok && result.results?.length) {
      resolveDone({ winner: result.results });
      return;
    }
    pending -= 1;
    if (pending === 0) resolveDone({ winner: null });
  };

  const launch = (name, run) => {
    pending += 1;
    Promise.resolve()
      .then(run)
      .catch(error => ({ ok: false, results: null, reason: error?.name === "TimeoutError" ? "timeout" : "exception" }))
      .then(result => record(name, result));
  };

  if (typeof fallback === "function") {
    launch("serper", async () => {
      const left = Math.max(100, deadline - Date.now());
      const value = await fallback(left, serperQuery, combinedSignal);
      return validProviderResult(value);
    });
  }

  launch("gdelt", async () => requestGdelt(
    gdeltQuery, "day", Math.max(100, deadline - Date.now()),
    combinedSignal, fetchImpl, requestId
  ));

  let deadlineTimer;
  const deadlineResult = new Promise(resolve => {
    deadlineTimer = setTimeout(() => resolve({ winner: null, timedOut: true }), budget);
  });
  const outcome = await Promise.race([done, deadlineResult]);
  clearTimeout(deadlineTimer);
  controller.abort();

  if (outcome.winner?.length) {
    outcome.winner.searchPeriod ||= "day";
    return outcome.winner;
  }

  const valid = settled.filter(item => item.ok);
  const remainingMs = deadline - Date.now();
  if (valid.some(item => item.results.length === 0) && remainingMs >= 450 && !signal?.aborted) {
    const weekly = await requestGdelt(
      gdeltQuery, "week", remainingMs - 100, signal, fetchImpl, requestId
    );
    if (weekly.ok && weekly.results.length) return weekly.results;
    if (weekly.ok) return weekly.results;
  }

  if (valid.length) {
    const empty = valid[0].results;
    empty.searchPeriod = valid.some(item => item.results.searchPeriod === "week") ? "week" : "day";
    return empty;
  }
  return null;
}

export const __newsSearchInternals = { requestGdelt, formatDate };
