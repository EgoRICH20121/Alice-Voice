import test from "node:test";
import assert from "node:assert/strict";
import {
  searchNews, buildGdeltQuery, buildSerperNewsQuery, normalizeGdeltArticles
} from "../api/news.js";

const article = (title = "Новый стандарт памяти", url = "https://example.com/news/ram") => ({
  url, title, seendate: "20261026T101500Z", domain: "example.com",
  language: "Russian", sourcecountry: "Russia", snippet: "Краткое описание новости."
});
const response = (data, status = 200) => new Response(
  typeof data === "string" ? data : JSON.stringify(data),
  { status, headers: { "content-type": "application/json" } }
);
const serperArticle = (title = "Новый стандарт памяти") => [{
  title, url: "https://example.com/serper/ram", date: "Сегодня",
  snippet: "Производители представили новый стандарт.", source: "example.com"
}];

test("both providers start concurrently and a real result wins", async () => {
  let serperCalled = false;
  let gdeltCalled = false;
  const results = await searchNews("новости про озу", {
    timeoutMs: 900,
    fallback: async (_budget, query) => {
      serperCalled = true;
      assert.equal(query, "оперативная память RAM DRAM DDR5 DDR4");
      return serperArticle();
    },
    fetchImpl: async () => {
      gdeltCalled = true;
      return response({ articles: [article()] });
    }
  });
  assert.equal(serperCalled, true);
  assert.equal(gdeltCalled, true);
  assert.ok(results.length > 0);
  assert.match(results[0].url, /^https:\/\/example\.com\//);
});

test("Serper empty result falls back to a valid GDELT result", async () => {
  const results = await searchNews("новости про ОЗУ", {
    timeoutMs: 1000,
    fallback: async () => [],
    fetchImpl: async () => response({ articles: [article()] })
  });
  assert.equal(results[0].title, "Новый стандарт памяти");
  assert.equal(results[0].source, "example.com");
  assert.equal(results[0].date, "26.10.2026 10:15 UTC");
});

test("normalized Serper results preserve real article links", async () => {
  const results = await searchNews("последние новости про видеокарты", {
    timeoutMs: 800,
    fallback: async (_budget, query) => {
      assert.equal(query, "видеокарты graphics cards GPU NVIDIA AMD");
      return [{ title: "Новая видеокарта", url: "https://example.com/gpu", snippet: "Описание" }];
    },
    fetchImpl: async (_url, options) => {
      assert.ok(options.signal);
      return response({ articles: [] });
    }
  });
  assert.equal(results[0].url, "https://example.com/gpu");
  assert.equal(results[0].title, "Новая видеокарта");
});

test("an empty day result may expand to a week when budget remains", async () => {
  const periods = [];
  const results = await searchNews("последние новости про видеокарты", {
    timeoutMs: 1200,
    fallback: async () => [],
    fetchImpl: async url => {
      const u = new URL(url);
      periods.push(u.searchParams.get("timespan"));
      return response({ articles: periods.length === 1 ? [] : [article("Новая видеокарта")] });
    }
  });
  assert.deepEqual(periods, ["1d", "7d"]);
  assert.equal(results[0].title, "Новая видеокарта");
  assert.equal(results.searchPeriod, "week");
});

test("all provider errors return null, not an empty-news result", async () => {
  const results = await searchNews("новости о процессорах", {
    timeoutMs: 700,
    fallback: async () => null,
    fetchImpl: async () => response({ error: "upstream" }, 503)
  });
  assert.equal(results, null);
});

test("one successful empty provider plus a failed provider returns an empty array", async () => {
  const results = await searchNews("новости о процессорах", {
    timeoutMs: 700,
    fallback: async () => [],
    fetchImpl: async () => response({ error: "upstream" }, 503)
  });
  assert.ok(Array.isArray(results));
  assert.equal(results.length, 0);
});

test("a hung Serper adapter cannot block the hard search deadline", async () => {
  const started = Date.now();
  const results = await searchNews("новости о процессорах", {
    timeoutMs: 350,
    fallback: () => new Promise(() => {}),
    fetchImpl: async () => response({ articles: [] })
  });
  assert.ok(Array.isArray(results));
  assert.ok(Date.now() - started < 600);
});

test("a timed-out GDELT request is bounded", async () => {
  const started = Date.now();
  const results = await searchNews("что нового в технологиях", {
    timeoutMs: 350,
    fallback: async () => null,
    fetchImpl: (_url, options) => new Promise((resolve, reject) => {
      const fail = () => reject(options.signal.reason || new DOMException("aborted", "AbortError"));
      if (options.signal.aborted) return fail();
      options.signal.addEventListener("abort", fail, { once: true });
    })
  });
  assert.equal(results, null);
  assert.ok(Date.now() - started < 600);
});

test("malformed and empty GDELT payloads are distinguished", () => {
  assert.equal(normalizeGdeltArticles({ results: [] }).ok, false);
  const empty = normalizeGdeltArticles({ articles: [] }, "week");
  assert.equal(empty.ok, true);
  assert.equal(empty.results.length, 0);
  assert.equal(empty.results.searchPeriod, "week");
});

test("query expansion covers RAM, GPU, CPU and general technology phrasing", () => {
  assert.match(buildGdeltQuery("новости про ОЗУ"), /RAM|DRAM|DDR5/);
  assert.match(buildSerperNewsQuery("новости про ОЗУ"), /RAM|DRAM|DDR5/);
  assert.match(buildGdeltQuery("последние новости про видеокарты"), /graphics card|GPU|NVIDIA/);
  assert.match(buildSerperNewsQuery("последние новости про видеокарты"), /graphics cards|GPU|NVIDIA/);
  assert.match(buildGdeltQuery("новости о процессорах"), /CPU|processor|Intel/);
  assert.match(buildSerperNewsQuery("новости о процессорах"), /CPU|Intel/);
  assert.match(buildGdeltQuery("что нового в технологиях"), /technology|semiconductor|AI/);
});
