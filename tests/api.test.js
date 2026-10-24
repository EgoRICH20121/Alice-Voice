import test, { mock } from "node:test";
import assert from "node:assert/strict";
import handler, {
  fitAliceText,
  fitFacts,
  cleanFact,
  safeHistory,
  parseMemoryCommand,
  answerFromMemoryQuestion,
  localReply,
  isSearch,
  extractCity,
  buildSearchAnswer
} from "../api/index.js";

// Фиктивные значения: реальные API в тестах не вызываются.
process.env.GEMINI_API_KEY = "test-key";
process.env.SERPER_API_KEY = "test-key";

async function call(body, method = "POST") {
  let statusCode = 200;
  let payload;
  const res = {
    status(code) { statusCode = code; return this; },
    json(value) { payload = value; return value; },
    setHeader() {}
  };
  await handler({ method, body }, res);
  return { statusCode, payload };
}

function turn(utterance, { facts, history, pending } = {}) {
  return {
    request: { original_utterance: utterance },
    state: {
      session: { history: history || [], ...(pending ? { pending } : {}) },
      user: facts ? { memory: { facts } } : {}
    }
  };
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" }
  });

const geminiOk = text => json({ candidates: [{ content: { parts: [{ text }] } }] });

function mockFetch(impl) {
  return mock.method(globalThis, "fetch", impl);
}

/* ---------------- базовый протокол ---------------- */

test("GET health check returns ok", async () => {
  const { statusCode, payload } = await call(undefined, "GET");
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "alice-voice");
});

test("response uses required Alice envelope", async () => {
  const { payload } = await call(turn("Привет"));
  assert.equal(payload.version, "1.0");
  assert.equal(typeof payload.response.text, "string");
  assert.equal(payload.response.end_session, false);
  assert.ok(Array.isArray(payload.session_state.history));
});

test("empty launch request returns greeting without external calls", async () => {
  const f = mockFetch(async () => { throw new Error("must not be called"); });
  try {
    const { payload } = await call({ request: { command: "" }, state: { session: {} } });
    assert.match(payload.response.text, /Привет/);
    assert.equal(f.mock.callCount(), 0);
  } finally { f.mock.restore(); }
});

test("Yandex ping is answered instantly without Gemini", async () => {
  const f = mockFetch(async () => { throw new Error("must not be called"); });
  try {
    const { payload } = await call(turn("ping"));
    assert.equal(payload.response.text, "pong");
    assert.equal(f.mock.callCount(), 0);
  } finally { f.mock.restore(); }
});

test("long responses are cut at a sentence boundary within 1024 chars", () => {
  const value = fitAliceText("Это короткое предложение. ".repeat(100));
  assert.ok(value.length <= 1024);
  assert.ok(value.endsWith("."));
});

test("history filters malformed messages and keeps last 8", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? "model" : "user",
    text: String(i)
  }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 8);
  assert.equal(result[0].parts[0].text, "4");
  assert.equal(result[7].parts[0].text, "11");
});

test("local replies still work: greeting and joke", () => {
  assert.match(localReply("Привет!"), /Привет/);
  assert.ok(localReply("расскажи анекдот").length > 20);
  assert.equal(localReply("объясни квантовую физику"), null);
});

/* ---------------- память ---------------- */

test("cleanFact removes stray spaces, commas and symbols", () => {
  assert.equal(
    cleanFact("  ,, мой   любимый цвет — зелёный!! "),
    "мой любимый цвет — зелёный"
  );
  assert.equal(cleanFact(", что мой кот Барсик ;"), "мой кот Барсик");
  assert.equal(cleanFact("мой дом ★ 5"), "мой дом 5");
});

test("memory commands are parsed", () => {
  assert.deepEqual(
    parseMemoryCommand("Алиса, запомни, что мой любимый цвет зелёный."),
    { type: "remember", fact: "мой любимый цвет зелёный" }
  );
  assert.equal(parseMemoryCommand("запомни чтобы я не забыл").fact, "чтобы я не забыл");
  assert.equal(parseMemoryCommand("запомни").fact, "");
  assert.equal(parseMemoryCommand("что ты помнишь?").type, "list");
  assert.equal(parseMemoryCommand("забудь мой любимый цвет").type, "forget");
  assert.equal(parseMemoryCommand("какая погода"), null);
});

test("REGRESSION: 'мда, а какой мой любимый цвет?' is answered from memory", () => {
  const facts = ["мой любимый цвет зелёный"];
  assert.equal(
    answerFromMemoryQuestion("мда, а какой мой любимый цвет?", facts),
    "Твой любимый цвет — зелёный."
  );
  assert.equal(
    answerFromMemoryQuestion("какой у меня любимый цвет", facts),
    "Твой любимый цвет — зелёный."
  );
});

test("dirty stored facts are still found", () => {
  assert.equal(
    answerFromMemoryQuestion("какой мой любимый цвет?", [" ,, мой  любимый цвет зелёный. "]),
    "Твой любимый цвет — зелёный."
  );
});

test("word endings and ё/е are tolerated", () => {
  assert.equal(
    answerFromMemoryQuestion("как зовут мою собаку?", ["моя собака Рекс"]),
    null // «зовут» нет в факте: не выдумываем соответствие
  );
  assert.equal(
    answerFromMemoryQuestion("какая у меня собака?", ["моя собака Рекс"]),
    "Твоя собака Рекс."
  );
  assert.equal(
    answerFromMemoryQuestion("какой мой любимый цвет?", ["мой любимый цвет зеленый"]),
    "Твой любимый цвет — зеленый."
  );
});

test("unrelated or non-personal questions are not answered from memory", () => {
  const facts = ["мой любимый цвет зелёный"];
  assert.equal(answerFromMemoryQuestion("какая столица Франции?", facts), null);
  assert.equal(answerFromMemoryQuestion("как мне заварить чай?", facts), null);
  assert.equal(answerFromMemoryQuestion("я люблю зелёный чай", facts), null);
  assert.equal(answerFromMemoryQuestion("какой мой любимый цвет?", []), null);
});

test("memory question is answered by handler locally, Gemini not called", async () => {
  const f = mockFetch(async () => { throw new Error("must not be called"); });
  try {
    const { payload } = await call(
      turn("мда, а какой мой любимый цвет?", { facts: ["мой любимый цвет зелёный"] })
    );
    assert.match(payload.response.text, /зелёный/);
    assert.equal(f.mock.callCount(), 0);
  } finally { f.mock.restore(); }
});

test("remember command stores a cleaned fact via user_state_update", async () => {
  const { payload } = await call(turn("Запомни, что мой любимый цвет зелёный", { facts: [] }));
  assert.deepEqual(payload.user_state_update, {
    memory: { facts: ["мой любимый цвет зелёный"] }
  });
  assert.match(payload.response.text, /запомнила/);
});

test("forget command removes a matching fact", async () => {
  const { payload } = await call(
    turn("забудь мой любимый цвет", { facts: ["мой любимый цвет зелёный", "мой кот Барсик"] })
  );
  assert.deepEqual(payload.user_state_update.memory.facts, ["мой кот Барсик"]);
});

test("fitFacts keeps the NEWEST facts when storage limit is exceeded", () => {
  const many = Array.from({ length: 30 }, (_, i) => `факт номер ${i} ${"я".repeat(60)}`);
  const kept = fitFacts(many);
  assert.ok(kept.length < many.length);
  assert.ok(kept[kept.length - 1].startsWith("факт номер 29"));
  assert.ok(Buffer.byteLength(JSON.stringify({ memory: { facts: kept } })) <= 850);
});

/* ---------------- Gemini: 503 / 429 / таймаут ---------------- */

test("Gemini 503 on primary model falls back to the second model", async () => {
  const urls = [];
  const f = mockFetch(async url => {
    urls.push(String(url));
    return urls.length === 1
      ? json({ error: { code: 503, status: "UNAVAILABLE" } }, 503)
      : geminiOk("Париж.");
  });
  try {
    const { payload } = await call(turn("Какая столица Франции?"));
    assert.equal(payload.response.text, "Париж.");
    assert.equal(f.mock.callCount(), 2);
    assert.notEqual(urls[0], urls[1]);
  } finally { f.mock.restore(); }
});

test("Gemini 429 on both models gives a clear message and keeps history clean", async () => {
  const f = mockFetch(async () => json({ error: { code: 429 } }, 429));
  try {
    const { payload } = await call(turn("Расскажи про космос"));
    assert.match(payload.response.text, /лимит/);
    assert.equal(payload.session_state.history.length, 0);
  } finally { f.mock.restore(); }
});

test("Gemini request does not send temperature and starts with a user turn", async () => {
  let sent;
  const f = mockFetch(async (_url, opts) => { sent = JSON.parse(opts.body); return geminiOk("Ок."); });
  try {
    await call(turn("Как дела у тебя сегодня на работе", {
      history: [{ role: "model", text: "стартовая реплика" }, { role: "user", text: "раз" }, { role: "model", text: "два" }]
    }));
    assert.equal(sent.generationConfig.temperature, undefined);
    assert.equal(sent.contents[0].role, "user");
    assert.equal(sent.contents[sent.contents.length - 1].role, "user");
  } finally { f.mock.restore(); }
});

test("hanging Gemini still yields a reply well inside Yandex 4.5 s limit", async () => {
  const f = mockFetch((_url, opts) => new Promise((_, reject) => {
    opts.signal.addEventListener("abort", () => {
      const e = new Error("aborted"); e.name = "AbortError"; reject(e);
    });
  }));
  const t0 = Date.now();
  try {
    const { payload } = await call(turn("Расскажи про космос подробнее"));
    const elapsed = Date.now() - t0;
    assert.ok(elapsed < 3600, `took ${elapsed} ms`);
    assert.ok(payload.response.text.length > 5);
  } finally { f.mock.restore(); }
});

/* ---------------- поиск и погода ---------------- */

test("search intent: no false positives for everyday phrases", () => {
  assert.equal(isSearch("Какая погода в Москве сегодня?"), true);
  assert.equal(isSearch("что нового в мире"), true);
  assert.equal(isSearch("найди рецепт борща"), true);
  assert.equal(isSearch("Погодите, я передумал"), false);
  assert.equal(isSearch("температура тела при гриппе"), false);
  assert.equal(isSearch("Расскажи сказку"), false);
});

test("extractCity handles prepositions, bare names and missing city", () => {
  assert.equal(extractCity("какая погода в Москве сегодня"), "в москве");
  assert.equal(extractCity("будет ли дождь завтра в Нижнем Новгороде"), "в нижнем новгороде");
  assert.equal(extractCity("какая погода сегодня"), "");
  assert.equal(extractCity("погода в выходные"), "");
  assert.equal(extractCity("Москва"), "москва");
});

test("weather without a city asks for the city and does not search", async () => {
  const f = mockFetch(async () => { throw new Error("must not be called"); });
  try {
    const { payload } = await call(turn("какая погода сегодня"));
    assert.match(payload.response.text, /какого города/i);
    assert.equal(payload.session_state.pending.kind, "weather");
    assert.equal(f.mock.callCount(), 0);
  } finally { f.mock.restore(); }
});

test("weather follow-up with just a city name triggers the search", async () => {
  let q;
  const f = mockFetch(async (_u, opts) => {
    q = JSON.parse(opts.body).q;
    return json({ organic: [{ title: "Погода в Казани", snippet: "Сегодня +7°C, ясно." }] });
  });
  try {
    const { payload } = await call(turn("Казань", { pending: { kind: "weather", day: "сегодня" } }));
    assert.match(q, /погода казань сегодня/);
    assert.match(payload.response.text, /\+7/);
    assert.equal(payload.session_state.pending, undefined);
  } finally { f.mock.restore(); }
});

test("weather query is built from the city and irrelevant results are dropped", async () => {
  let q;
  const f = mockFetch(async (_u, opts) => {
    q = JSON.parse(opts.body).q;
    return json({
      organic: [
        { title: "Погода в Санкт-Петербурге", snippet: "Сейчас +5°C, дождь и ветер." },
        { title: "Погода в Москве", snippet: "Сегодня +12°C, облачно, без осадков." }
      ]
    });
  });
  try {
    const { payload } = await call(turn("какая погода в Москве сегодня"));
    assert.equal(q, "погода в москве сегодня");
    assert.match(payload.response.text, /\+12/);
    assert.doesNotMatch(payload.response.text, /\+5/);
    assert.match(payload.response.text, /неточными/);
  } finally { f.mock.restore(); }
});

test("weather: results about another city are not presented as the answer", () => {
  const text = buildSearchAnswer(
    "weather",
    [{ title: "Погода в Сочи", snippet: "Сегодня +20°C, солнечно.", date: "" }],
    { city: "в москве", day: "сегодня" }
  );
  assert.match(text, /Не нашла надёжных данных/);
  assert.doesNotMatch(text, /\+20/);
});

test("search failure gives an honest message instead of invented data", async () => {
  const f = mockFetch(async () => { throw new Error("network down"); });
  try {
    const { payload } = await call(turn("найди последние новости про космос"));
    assert.match(payload.response.text, /не нашла|Поиск не вернул/i);
  } finally { f.mock.restore(); }
});

test("news answer lists titles with dates", () => {
  const text = buildSearchAnswer("news", [
    { title: "Запущена новая ракета", date: "2 часа назад", snippet: "" },
    { title: "Открыт новый мост", date: "5 часов назад", snippet: "" }
  ]);
  assert.match(text, /Запущена новая ракета \(2 часа назад\)/);
});
