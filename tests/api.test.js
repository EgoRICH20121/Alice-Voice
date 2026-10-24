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
  buildSearchAnswer,
  buildWeatherAnswer,
  packSessionState,
  isBareModeRequest,
  sameTopic
} from "../api/index.js";

// Фиктивные значения: реальные API в тестах не вызываются.
process.env.GEMINI_API_KEY = "test-key";
process.env.SERPER_API_KEY = "test-key";

/* ---------------- помощники ---------------- */

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

function turn(utterance, { facts, history, pending, detail } = {}) {
  return {
    request: { original_utterance: utterance },
    state: {
      session: {
        history: history || [],
        ...(pending ? { pending } : {}),
        ...(detail ? { detail: 1 } : {})
      },
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

// Маршрутизатор: отдельные обработчики для Serper и Gemini + журнал запросов.
function router({ serper, gemini }) {
  const log = [];
  const impl = async (url, opts) => {
    const u = String(url);
    const body = opts?.body ? JSON.parse(opts.body) : {};
    if (u.includes("serper.dev")) {
      log.push({ api: "serper", body });
      return serper(body, u);
    }
    if (u.includes("generativelanguage")) {
      log.push({ api: "gemini", body, url: u });
      return gemini(body, u);
    }
    throw new Error("unexpected url " + u);
  };
  return { impl, log };
}

const NO_CALLS = async () => { throw new Error("must not be called"); };

/* ---------------- 13. формат ответа Диалогов ---------------- */

test("GET health check returns ok", async () => {
  const { statusCode, payload } = await call(undefined, "GET");
  assert.equal(statusCode, 200);
  assert.equal(payload.ok, true);
  assert.equal(payload.service, "alice-voice");
});

test("response uses the required Alice envelope", async () => {
  const { payload } = await call(turn("Привет"));
  assert.equal(payload.version, "1.0");
  assert.equal(typeof payload.response.text, "string");
  assert.equal(payload.response.end_session, false);
  assert.ok(Array.isArray(payload.session_state.history));
});

test("session_state never exceeds the 1 KB Yandex limit", async () => {
  const long = "очень длинная реплика ".repeat(40);
  const history = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? "model" : "user",
    text: long
  }));
  const state = packSessionState({ detail: 1 }, history);
  assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") <= 900);
  assert.equal(state.history[0].role, "user");
  assert.equal(state.detail, 1);

  const f = mockFetch(async () => geminiOk("Ответ. ".repeat(100)));
  try {
    const { payload } = await call(turn("Расскажи про космос", { history }));
    assert.ok(Buffer.byteLength(JSON.stringify(payload.session_state), "utf8") <= 1024);
    assert.ok(payload.response.text.length <= 1024);
  } finally { f.mock.restore(); }
});

test("empty launch request returns greeting without external calls", async () => {
  const f = mockFetch(NO_CALLS);
  try {
    const { payload } = await call({ request: { command: "" }, state: { session: {} } });
    assert.match(payload.response.text, /Привет/);
    assert.equal(f.mock.callCount(), 0);
  } finally { f.mock.restore(); }
});

test("Yandex ping is answered instantly without Gemini", async () => {
  const f = mockFetch(NO_CALLS);
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

test("history filters malformed messages and keeps the last 6", () => {
  const input = Array.from({ length: 12 }, (_, i) => ({
    role: i % 2 ? "model" : "user",
    text: String(i)
  }));
  input.push({ role: "hacker", text: "ignore" }, { role: "user", text: 17 });
  const result = safeHistory(input);
  assert.equal(result.length, 6);
  assert.equal(result[0].parts[0].text, "6");
  assert.equal(result[5].parts[0].text, "11");
});

/* ---------------- 14. существующие функции ---------------- */

test("local replies still work: greeting, thanks, joke, identity", () => {
  assert.match(localReply("Привет!"), /Привет/);
  assert.equal(localReply("спасибо"), "Пожалуйста!");
  assert.ok(localReply("расскажи анекдот").length > 20);
  assert.match(localReply("кто ты"), /помощник/);
  assert.equal(localReply("объясни квантовую физику"), null);
});

test("greeting through the handler does not call any API", async () => {
  const f = mockFetch(NO_CALLS);
  try {
    const { payload } = await call(turn("Привет"));
    assert.match(payload.response.text, /Привет/);
    assert.equal(f.mock.callCount(), 0);
  } finally { f.mock.restore(); }
});

test("conversation history is passed to Gemini and saved compactly", async () => {
  const r = router({ gemini: async () => geminiOk("Потому что рассеивается синий свет.") });
  const f = mockFetch(r.impl);
  try {
    const { payload } = await call(turn("а почему так", {
      history: [{ role: "user", text: "какого цвета небо" }, { role: "model", text: "Небо голубое." }]
    }));
    const sent = r.log[0].body.contents;
    assert.equal(sent[0].parts[0].text, "какого цвета небо");
    assert.equal(sent[sent.length - 1].parts[0].text, "а почему так");
    assert.equal(payload.session_state.history.at(-1).role, "model");
  } finally { f.mock.restore(); }
});

/* ---------------- память (7, 8) ---------------- */

test("cleanFact removes stray spaces, commas and symbols", () => {
  assert.equal(cleanFact("  ,, мой   любимый цвет — зелёный!! "), "мой любимый цвет — зелёный");
  assert.equal(cleanFact(", что мой кот Барсик ;"), "мой кот Барсик");
  assert.equal(cleanFact("мой дом ★ 5"), "мой дом 5");
});

test("memory commands are parsed", () => {
  assert.deepEqual(
    parseMemoryCommand("Алиса, запомни, что мой любимый цвет зелёный."),
    { type: "remember", fact: "мой любимый цвет зелёный" }
  );
  assert.equal(parseMemoryCommand("запомни").fact, "");
  assert.equal(parseMemoryCommand("что ты помнишь?").type, "list");
  assert.equal(parseMemoryCommand("забудь мой любимый цвет").type, "forget");
  assert.equal(parseMemoryCommand("какая погода"), null);
});

test("'мда, а какой мой любимый цвет?' is answered from memory", () => {
  const facts = ["мой любимый цвет зелёный"];
  assert.equal(
    answerFromMemoryQuestion("мда, а какой мой любимый цвет?", facts),
    "Твой любимый цвет — зелёный."
  );
  assert.equal(
    answerFromMemoryQuestion("какой мой любимый цвет?", [" ,, мой  любимый цвет зелёный. "]),
    "Твой любимый цвет — зелёный."
  );
});

test("unrelated or non-personal questions are not answered from memory", () => {
  const facts = ["мой любимый цвет зелёный"];
  assert.equal(answerFromMemoryQuestion("какая столица Франции?", facts), null);
  assert.equal(answerFromMemoryQuestion("как мне заварить чай?", facts), null);
  assert.equal(answerFromMemoryQuestion("какой мой любимый цвет?", []), null);
});

test("handler: memory question is answered locally, Gemini not called", async () => {
  const f = mockFetch(NO_CALLS);
  try {
    const { payload } = await call(
      turn("мда, а какой мой любимый цвет?", { facts: ["мой любимый цвет зелёный"] })
    );
    assert.match(payload.response.text, /зелёный/);
    assert.equal(f.mock.callCount(), 0);
  } finally { f.mock.restore(); }
});

test("handler: missing fact gets an honest answer through Gemini, never a guess from memory", async () => {
  const r = router({ gemini: async () => geminiOk("Я не знаю, ты мне не говорил.") });
  const f = mockFetch(r.impl);
  try {
    const { payload } = await call(turn("какое у меня любимое животное?", { facts: ["мой любимый цвет зелёный"] }));
    assert.equal(r.log.length, 1);
    assert.match(r.log[0].body.systemInstruction.parts[0].text, /не подменяй сохранённый факт/);
    assert.ok(payload.response.text.length > 0);
  } finally { f.mock.restore(); }
});

test("remember / forget / list commands persist through user_state_update", async () => {
  let { payload } = await call(turn("Запомни, что мой любимый цвет зелёный", { facts: [] }));
  assert.deepEqual(payload.user_state_update, { memory: { facts: ["мой любимый цвет зелёный"] } });
  assert.match(payload.response.text, /запомнила/);

  ({ payload } = await call(
    turn("забудь мой любимый цвет", { facts: ["мой любимый цвет зелёный", "мой кот Барсик"] })
  ));
  assert.deepEqual(payload.user_state_update.memory.facts, ["мой кот Барсик"]);

  ({ payload } = await call(turn("что ты помнишь?", { facts: ["мой кот Барсик"] })));
  assert.match(payload.response.text, /Барсик/);
});

test("fitFacts keeps the newest facts when the storage limit is exceeded", () => {
  const many = Array.from({ length: 30 }, (_, i) => `факт номер ${i} ${"я".repeat(60)}`);
  const kept = fitFacts(many);
  assert.ok(kept.length < many.length);
  assert.ok(kept[kept.length - 1].startsWith("факт номер 29"));
});

/* ---------------- 1–4. стиль ответов: краткий / подробный ---------------- */

test("1. ordinary question: short mode prompt and token limit, goes to Gemini directly", async () => {
  const r = router({ gemini: async () => geminiOk("Париж. Это столица и крупнейший город Франции.") });
  const f = mockFetch(r.impl);
  try {
    const { payload } = await call(turn("Какая столица Франции?"));
    assert.equal(r.log.length, 1);
    assert.equal(r.log[0].api, "gemini");
    const body = r.log[0].body;
    assert.match(body.systemInstruction.parts[0].text, /Режим: краткий/);
    assert.match(body.systemInstruction.parts[0].text, /2–5 предложений/);
    assert.equal(body.generationConfig.maxOutputTokens, 350);
    assert.equal(body.generationConfig.temperature, undefined);
    assert.equal(payload.session_state.detail, undefined);
  } finally { f.mock.restore(); }
});

test("2. 'расскажи подробно' switches to detailed mode and keeps it for the topic", async () => {
  const r = router({ gemini: async () => geminiOk("Развёрнутый ответ.") });
  const f = mockFetch(r.impl);
  try {
    let { payload } = await call(turn("Расскажи подробно, как работает процессор"));
    let body = r.log[0].body;
    assert.match(body.systemInstruction.parts[0].text, /Режим: подробный/);
    assert.equal(body.generationConfig.maxOutputTokens, 600);
    assert.equal(payload.session_state.detail, 1);

    // Уточняющий вопрос по той же теме остаётся подробным.
    ({ payload } = await call(turn("а зачем ему кэш", {
      detail: true,
      history: [
        { role: "user", text: "Расскажи подробно, как работает процессор" },
        { role: "model", text: "Развёрнутый ответ." }
      ]
    })));
    body = r.log[1].body;
    assert.match(body.systemInstruction.parts[0].text, /Режим: подробный/);
    assert.equal(payload.session_state.detail, 1);

    // Другая тема — возврат к краткому режиму.
    ({ payload } = await call(turn("Какая столица Австралии и сколько там живёт людей", {
      detail: true,
      history: [
        { role: "user", text: "Расскажи подробно, как работает процессор" },
        { role: "model", text: "Развёрнутый ответ." }
      ]
    })));
    body = r.log[2].body;
    assert.match(body.systemInstruction.parts[0].text, /Режим: краткий/);
    assert.equal(payload.session_state.detail, undefined);
  } finally { f.mock.restore(); }
});

test("2b. bare 'объясни подробнее' re-asks the previous question in detail", async () => {
  const r = router({ gemini: async () => geminiOk("Подробный ответ.") });
  const f = mockFetch(r.impl);
  try {
    await call(turn("Объясни подробнее", {
      history: [{ role: "user", text: "Что такое TDP" }, { role: "model", text: "Тепловыделение." }]
    }));
    const sent = r.log[0].body.contents;
    assert.match(sent[sent.length - 1].parts[0].text, /Объясни подробнее: Что такое TDP/);
    assert.match(r.log[0].body.systemInstruction.parts[0].text, /Режим: подробный/);
  } finally { f.mock.restore(); }
});

test("2c. 'расскажи подробнее' without any previous question asks what to explain", async () => {
  const f = mockFetch(NO_CALLS);
  try {
    const { payload } = await call(turn("Расскажи подробнее"));
    assert.match(payload.response.text, /О чём рассказать подробно/);
    assert.equal(payload.session_state.detail, 1);
    assert.equal(f.mock.callCount(), 0);
  } finally { f.mock.restore(); }
});

test("3. 'короче' returns to short mode immediately", async () => {
  const r = router({ gemini: async () => geminiOk("Коротко.") });
  const f = mockFetch(r.impl);
  try {
    const history = [{ role: "user", text: "Что такое TDP" }, { role: "model", text: "Длинный ответ." }];
    let { payload } = await call(turn("короче", { detail: true, history }));
    assert.match(r.log[0].body.systemInstruction.parts[0].text, /Режим: краткий/);
    assert.equal(payload.session_state.detail, undefined);

    ({ payload } = await call(turn("а теперь расскажи кратко, что такое кэш", { detail: true, history })));
    assert.match(r.log[1].body.systemInstruction.parts[0].text, /Режим: краткий/);
    assert.equal(payload.session_state.detail, undefined);
  } finally { f.mock.restore(); }
});

test("mode helpers: bare requests and topic change", () => {
  assert.equal(isBareModeRequest("а можно подробнее?"), true);
  assert.equal(isBareModeRequest("расскажи подробно про Токио"), false);
  assert.equal(sameTopic("а почему так", []), true);
  assert.equal(sameTopic("давай сменим тему, расскажи что-нибудь другое", []), false);
});

test("4. technical question about CPU power goes to Gemini (no search) with the tech-style prompt", async () => {
  const answer = "TDP у Xeon E3-1220 v2 — 69 Вт. Это показатель тепловыделения процессора, а не точное потребление всего компьютера.";
  const r = router({ gemini: async () => geminiOk(answer) });
  const f = mockFetch(r.impl);
  try {
    const { payload } = await call(turn("Какое потребление у Xeon E3-1220 v2?"));
    assert.equal(r.log.length, 1);
    assert.equal(r.log[0].api, "gemini");
    const prompt = r.log[0].body.systemInstruction.parts[0].text;
    assert.match(prompt, /процессоры, видеокарты/);
    assert.match(prompt, /TDP — это тепловыделение/);
    assert.match(prompt, /Не выдумывай факты, числа и результаты тестов/);
    assert.equal(payload.response.text, answer);
  } finally { f.mock.restore(); }
});

/* ---------------- 9–11. Gemini: успех, 503/429, таймаут ---------------- */

test("9. successful Gemini answer is returned and saved to history", async () => {
  const f = mockFetch(async () => geminiOk("Париж."));
  try {
    const { payload } = await call(turn("Какая столица Франции?"));
    assert.equal(payload.response.text, "Париж.");
    assert.deepEqual(payload.session_state.history.map(x => x.role), ["user", "model"]);
  } finally { f.mock.restore(); }
});

test("10a. 503 on the primary model falls back to the second model", async () => {
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

test("10b. 503 on both models gives a clear message and does not pollute history", async () => {
  const f = mockFetch(async () => json({ error: { code: 503 } }, 503));
  try {
    const { payload } = await call(turn("Какая столица Франции?"));
    assert.match(payload.response.text, /перегружена/);
    assert.equal(f.mock.callCount(), 2); // без бесконечных повторов
    assert.equal(payload.session_state.history.length, 0);
  } finally { f.mock.restore(); }
});

test("10c. 429 on both models gives a clear message and keeps history clean", async () => {
  const f = mockFetch(async () => json({ error: { code: 429 } }, 429));
  try {
    const { payload } = await call(turn("Расскажи про космос"));
    assert.match(payload.response.text, /лимит/);
    assert.equal(payload.session_state.history.length, 0);
  } finally { f.mock.restore(); }
});

test("Gemini request starts with a user turn", async () => {
  let sent;
  const f = mockFetch(async (_u, opts) => { sent = JSON.parse(opts.body); return geminiOk("Ок."); });
  try {
    await call(turn("Как дела у тебя сегодня на работе", {
      history: [{ role: "model", text: "стартовая реплика" }, { role: "user", text: "раз" }, { role: "model", text: "два" }]
    }));
    assert.equal(sent.contents[0].role, "user");
    assert.equal(sent.contents[sent.contents.length - 1].role, "user");
  } finally { f.mock.restore(); }
});

test("11. hanging Gemini still yields a reply well inside the Yandex 4.5 s limit", async () => {
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
    assert.match(payload.response.text, /не успела|не успела ответить|отведённое время/);
    assert.equal(payload.session_state.history.length, 0);
  } finally { f.mock.restore(); }
});

/* ---------------- 5. погода ---------------- */

test("search intent: no false positives, no searching for what Gemini can answer", () => {
  assert.equal(isSearch("Какая погода в Москве сегодня?"), true);
  assert.equal(isSearch("что нового в мире"), true);
  assert.equal(isSearch("поищи в интернете характеристики Xeon E3-1220 v2"), true);
  assert.equal(isSearch("курс доллара сегодня"), true);
  assert.equal(isSearch("Погодите, я передумал"), false);
  assert.equal(isSearch("температура тела при гриппе"), false);
  assert.equal(isSearch("найди разницу между процессором и видеокартой"), false);
  assert.equal(isSearch("Расскажи сказку"), false);
  assert.equal(isSearch("Какое потребление у Xeon E3-1220 v2?"), false);
});

test("extractCity handles prepositions, bare names and missing city", () => {
  assert.equal(extractCity("какая погода в Москве сегодня"), "в москве");
  assert.equal(extractCity("будет ли дождь завтра в Нижнем Новгороде"), "в нижнем новгороде");
  assert.equal(extractCity("какая погода сегодня"), "");
  assert.equal(extractCity("погода в выходные"), "");
  assert.equal(extractCity("Москва"), "москва");
});

test("5a. weather without a city asks for the city and does not search", async () => {
  const f = mockFetch(NO_CALLS);
  try {
    const { payload } = await call(turn("какая погода сегодня"));
    assert.match(payload.response.text, /какого города/i);
    assert.equal(payload.session_state.pending.kind, "weather");
    assert.equal(f.mock.callCount(), 0);
  } finally { f.mock.restore(); }
});

test("5b. follow-up with just a city name runs the weather search", async () => {
  const r = router({
    serper: async () => json({ organic: [{ title: "Погода в Москве", snippet: "Сегодня в Москве +12°C, облачно. Ветер 5 м/с." }] })
  });
  const f = mockFetch(r.impl);
  try {
    const { payload } = await call(turn("Москва", { pending: { kind: "weather", day: "сегодня" } }));
    assert.equal(r.log.length, 1); // только поиск, Gemini для погоды не нужен
    assert.match(r.log[0].body.q, /погода москва сегодня/);
    assert.match(payload.response.text, /\+12/);
    assert.equal(payload.session_state.pending, undefined);
  } finally { f.mock.restore(); }
});

test("5c. weather answer: city, temperature, conditions, wind, advice — and no snippet junk", async () => {
  const r = router({
    serper: async () => json({
      organic: [{
        title: "Погода в Иглино — Яндекс Погода",
        snippet: "Сегодня в Иглино +7°C, ясно. Ветер 3 м/с, влажность 60%. Прогноз на 10 дней, реклама, подписаться на рассылку."
      }]
    })
  });
  const f = mockFetch(r.impl);
  try {
    const { payload } = await call(turn("какая погода в Иглино сегодня"));
    const text = payload.response.text;
    assert.equal(r.log[0].body.q, "погода в иглино сегодня");
    assert.match(text, /^В Иглино сегодня около \+7 °C, ясно, ветер слабый \(3 м\/с\)\./);
    assert.match(text, /лёгкую куртку/);
    assert.doesNotMatch(text, /Яндекс|реклама|рассылк|10 дней|влажность/);
  } finally { f.mock.restore(); }
});

test("5d. results about another city or another day are not presented as the answer", () => {
  const other = buildWeatherAnswer(
    [{ title: "Погода в Сочи", snippet: "Сегодня +20°C, солнечно." }],
    { city: "в москве", day: "сегодня" }
  );
  assert.match(other, /Не нашла надёжных данных/);
  assert.doesNotMatch(other, /\+20/);

  const forecastForToday = buildWeatherAnswer(
    [{ title: "Погода в Москве", snippet: "Завтра в Москве +3°C, снег." }],
    { city: "в москве", day: "сегодня" }
  );
  assert.match(forecastForToday, /Не нашла надёжных данных/);

  const tomorrow = buildWeatherAnswer(
    [{ title: "Погода в Москве", snippet: "Сегодня +9°C, дождь. Завтра +3°C, снег." }],
    { city: "в москве", day: "завтра" }
  );
  assert.match(tomorrow, /завтра около \+3 °C, снег/);
  assert.doesNotMatch(tomorrow, /\+9/);
});

test("5e. rain adds an umbrella hint and negative temperatures are formatted", () => {
  const rain = buildWeatherAnswer(
    [{ title: "Погода в Уфе", snippet: "Сейчас в Уфе +10°C, небольшой дождь." }],
    { city: "в уфе", day: "сегодня" }
  );
  assert.match(rain, /зонт/);
  const cold = buildWeatherAnswer(
    [{ title: "Погода в Уфе", snippet: "Сегодня в Уфе −5°C, снег." }],
    { city: "в уфе", day: "сегодня" }
  );
  assert.match(cold, /около -5 °C/);
});

/* ---------------- 6. новости ---------------- */

const NEWS = {
  news: [
    { title: "Запущена новая ракета", date: "2 часа назад", snippet: "Ракета стартовала с космодрома и вывела на орбиту три спутника связи.", source: "РИА" },
    { title: "Открыт новый мост", date: "5 часов назад", snippet: "Мост через реку соединил два района города и сократит время в пути.", source: "ТАСС" }
  ]
};

test("6a. news are retold by Gemini from search results, grounded in sources", async () => {
  const summary = "Новая ракета стартовала 2 часа назад и вывела на орбиту три спутника связи. Это расширит покрытие связи.";
  const r = router({
    serper: async () => json(NEWS),
    gemini: async () => geminiOk(summary)
  });
  const f = mockFetch(r.impl);
  try {
    const { payload } = await call(turn("расскажи последние новости"));
    assert.equal(r.log[0].api, "serper");
    assert.equal(r.log[0].body.tbs, "qdr:d");
    assert.equal(r.log[1].api, "gemini");
    const prompt = r.log[1].body.systemInstruction.parts[0].text;
    assert.match(prompt, /что произошло, кого или что это затрагивает/);
    assert.match(prompt, /не придумывай подробности/);
    assert.equal(payload.response.text, summary);
  } finally { f.mock.restore(); }
});

test("6b. a summary with invented numbers is rejected in favour of the source text", async () => {
  const r = router({
    serper: async () => json(NEWS),
    gemini: async () => geminiOk("Ракета стартовала и вывела на орбиту 47 спутников.")
  });
  const f = mockFetch(r.impl);
  try {
    const { payload } = await call(turn("расскажи последние новости"));
    assert.doesNotMatch(payload.response.text, /47/);
    assert.match(payload.response.text, /Запущена новая ракета \(2 часа назад\)/);
    assert.match(payload.response.text, /не полный текст статей/);
  } finally { f.mock.restore(); }
});

test("6c. if Gemini is down the news fall back to headlines with snippets and dates", async () => {
  const r = router({
    serper: async () => json(NEWS),
    gemini: async () => json({ error: { code: 503 } }, 503)
  });
  const f = mockFetch(r.impl);
  try {
    const { payload } = await call(turn("какие сегодня новости"));
    assert.match(payload.response.text, /Открыт новый мост \(5 часов назад\)/);
    assert.match(payload.response.text, /Мост через реку/);
  } finally { f.mock.restore(); }
});

/* ---------------- 12. недоступность Serper ---------------- */

test("12a. Serper network failure gives an honest 'search unavailable' message", async () => {
  const f = mockFetch(async () => { throw new Error("network down"); });
  try {
    for (const q of ["расскажи последние новости", "какая погода в Москве сегодня"]) {
      const { payload } = await call(turn(q));
      assert.match(payload.response.text, /Поиск сейчас недоступен/);
      assert.equal(payload.session_state.history.length, 2);
    }
  } finally { f.mock.restore(); }
});

test("12b. Serper HTTP error and empty results are distinguished", async () => {
  const r1 = router({ serper: async () => json({ message: "error" }, 500) });
  let f = mockFetch(r1.impl);
  try {
    const { payload } = await call(turn("какая погода в Москве"));
    assert.match(payload.response.text, /Поиск сейчас недоступен/);
  } finally { f.mock.restore(); }

  const r2 = router({ serper: async () => json({ news: [] }) });
  f = mockFetch(r2.impl);
  try {
    const { payload } = await call(turn("последние новости про космос"));
    assert.match(payload.response.text, /не нашла/);
    assert.equal(r2.log.length, 1); // без результатов Gemini не вызывается
  } finally { f.mock.restore(); }
});

test("12c. missing SERPER_API_KEY does not crash", async () => {
  const saved = process.env.SERPER_API_KEY;
  delete process.env.SERPER_API_KEY;
  const f = mockFetch(NO_CALLS);
  try {
    const { payload } = await call(turn("какая погода в Москве"));
    assert.match(payload.response.text, /Поиск сейчас недоступен/);
  } finally {
    process.env.SERPER_API_KEY = saved;
    f.mock.restore();
  }
});

test("general search result is summarised by Gemini only when search is requested", async () => {
  const r = router({
    serper: async () => json({ organic: [{ title: "Курс доллара", snippet: "Официальный курс доллара ЦБ на сегодня составляет 90,5 рубля.", date: "" }] }),
    gemini: async () => geminiOk("Курс доллара по данным ЦБ — 90,5 рубля.")
  });
  const f = mockFetch(r.impl);
  try {
    const { payload } = await call(turn("курс доллара сегодня"));
    assert.equal(r.log.map(x => x.api).join(), "serper,gemini");
    assert.match(payload.response.text, /90,5/);
  } finally { f.mock.restore(); }
});
