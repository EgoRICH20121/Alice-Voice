import test from "node:test";
import assert from "node:assert/strict";
import { searchNews, buildGdeltQuery, normalizeGdeltArticles } from "../api/news.js";

const article = (title = "Новый стандарт памяти") => ({
  url: "https://example.com/news/ram",
  title,
  seendate: "20261026T101500Z",
  domain: "example.com",
  language: "Russian",
  sourcecountry: "Russia"
});

const response = (data, status = 200, contentType = "application/json") =>
  new Response(typeof data === "string" ? data : JSON.stringify(data), {
    status,
    headers: { "content-type": contentType }
  });

test("GDELT news search returns real article fields and requests the documented DOC API", async () => {
  let requested;
  const results = await searchNews("новости про озу", {
    timeoutMs: 1900,
    fetchImpl: async (url, options) => {
      requested = { url: new URL(url), options };
      return response({ articles: [article()] });
    }
  });

  assert.equal(requested.url.origin + requested.url.pathname, "https://api.gdeltproject.org/api/v2/doc/doc");
  assert.equal(requested.url.searchParams.get("mode"), "ArtList");
  assert.equal(requested.url.searchParams.get("format"), "json");
  assert.equal(requested.url.searchParams.get("timespan"), "1d");
  assert.equal(requested.options.method, "GET");
  assert.equal(requested.options.headers.Accept, "application/json");
  assert.match(requested.url.searchParams.get("query"), /RAM|DRAM|DDR5/);
  assert.equal(results[0].title, "Новый стандарт памяти");
  assert.equal(results[0].url, "https://example.com/news/ram");
  assert.equal(results[0].source, "example.com");
  assert.equal(results[0].date, "26.10.2026 10:15 UTC");
  assert.equal(results.searchPeriod, "day");
});

test("empty daily results expand to a seven-day GDELT query", async () => {
  const periods = [];
  const results = await searchNews("последние новости про видеокарты", {
    timeoutMs: 2100,
    fetchImpl: async url => {
      const u = new URL(url);
      periods.push(u.searchParams.get("timespan"));
      return response({ articles: periods.length === 1 ? [] : [article("Новый графический процессор")] });
    }
  });

  assert.deepEqual(periods, ["1d", "7d"]);
  assert.equal(results[0].title, "Новый графический процессор");
  assert.equal(results.searchPeriod, "week");
});

test("provider HTTP/JSON errors use the independent fallback, not an empty-news answer", async () => {
  let fallbackCalled = false;
  const results = await searchNews("новости о процессорах", {
    timeoutMs: 1500,
    fetchImpl: async () => response({ error: "upstream" }, 503),
    fallback: async budget => {
      fallbackCalled = true;
      assert.ok(budget > 0 && budget <= 800);
      return [{ title: "Новость из резервного источника", url: "https://backup.example/news", source: "backup.example" }];
    }
  });

  assert.equal(fallbackCalled, true);
  assert.equal(results[0].title, "Новость из резервного источника");
});

test("a timed-out provider request is bounded and can recover through fallback", async () => {
  let fallbackCalled = false;
  const started = Date.now();
  const results = await searchNews("что нового в технологиях", {
    timeoutMs: 600,
    fetchImpl: (_url, options) => new Promise((resolve, reject) => {
      const fail = () => reject(options.signal.reason || new DOMException("aborted", "AbortError"));
      if (options.signal.aborted) return fail();
      options.signal.addEventListener("abort", fail, { once: true });
    }),
    fallback: async () => {
      fallbackCalled = true;
      return [{ title: "Восстановлено через резервный источник", url: "https://backup.example/1" }];
    }
  });

  assert.equal(fallbackCalled, true);
  assert.equal(results[0].title, "Восстановлено через резервный источник");
  assert.ok(Date.now() - started < 550, "provider timeout must stay within its assigned budget");
});

test("malformed and empty GDELT payloads are distinguished", () => {
  assert.equal(normalizeGdeltArticles({ results: [] }).ok, false);
  const empty = normalizeGdeltArticles({ articles: [] }, "week");
  assert.equal(empty.ok, true);
  assert.equal(empty.results.length, 0);
  assert.equal(empty.results.searchPeriod, "week");
});

test("news query expansion covers RAM, GPU, CPU and technology phrasing", () => {
  assert.match(buildGdeltQuery("новости про ОЗУ"), /RAM|DRAM|DDR5/);
  assert.match(buildGdeltQuery("последние новости про видеокарты"), /graphics card|GPU|NVIDIA/);
  assert.match(buildGdeltQuery("новости о процессорах"), /CPU|processor|Intel/);
  assert.match(buildGdeltQuery("что нового в технологиях"), /technology|semiconductor|AI/);
});
