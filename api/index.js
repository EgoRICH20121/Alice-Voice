const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const FALLBACK_MODEL =
  process.env.GEMINI_FALLBACK_MODEL || "gemini-3.1-flash-lite";

const MAX_ALICE_TEXT = 1024;
const MAX_HISTORY = 8;
const MAX_FACTS = 10;
const MAX_FACTS_BYTES = 850; // лимит user_state Алисы — 1024 байта, оставляем запас

// Яндекс Диалоги ждут ответ 4,5 с, считая сеть и холодный старт.
// Свой бюджет делаем заметно меньше.
const TOTAL_BUDGET_MS = 3200;
const GEMINI_FIRST_TIMEOUT_MS = 2000;
const GEMINI_RETRY_TIMEOUT_MS = 1500;
const SERPER_TIMEOUT_MS = 1800;
const MIN_ATTEMPT_MS = 600;
const SAFETY_MS = 250;

const SYSTEM_PROMPT = [
  "Ты — голосовой помощник навыка Яндекс Алисы.",
  "Отвечай естественно, по-русски, дружелюбно и по существу.",
  "Обычно ответ должен занимать 1–3 коротких предложения.",
  "Учитывай переданную историю и явно сохранённые факты пользователя.",
  "Не выдумывай факты. Если не знаешь — прямо скажи об этом.",
  "Не используй Markdown, эмодзи, таблицы, заголовки и списки, если пользователь не просит.",
  "Ты не имеешь доступа к интернету в этом ответе: про погоду, новости и текущие события не придумывай данные."
].join(" ");

/* ------------------------------ тексты ------------------------------ */

function clean(value, max = MAX_ALICE_TEXT) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, max);
}

function fitAliceText(value) {
  const text = clean(value, 5000);

  if (!text) {
    return "Не удалось подготовить ответ. Попробуйте ещё раз.";
  }

  if (text.length <= MAX_ALICE_TEXT) return text;

  const cut = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    cut.lastIndexOf(". "),
    cut.lastIndexOf("! "),
    cut.lastIndexOf("? ")
  );

  if (sentenceEnd > 250) {
    return cut.slice(0, sentenceEnd + 1).trim();
  }

  const space = cut.lastIndexOf(" ");

  return (space > 200 ? cut.slice(0, space) : cut).trim() + "…";
}

function safeHistory(value) {
  if (!Array.isArray(value)) return [];

  const result = [];

  for (const item of value.slice(-MAX_HISTORY * 2)) {
    if (
      !item ||
      !["user", "model"].includes(item.role) ||
      typeof item.text !== "string"
    ) continue;

    const text = clean(item.text, 700);
    if (!text) continue;

    const entry = { role: item.role, parts: [{ text }] };
    const previous = result[result.length - 1];

    if (previous && previous.role === entry.role) {
      previous.parts[0].text += "\n" + text;
    } else {
      result.push(entry);
    }
  }

  while (result.length && result[0].role !== "user") {
    result.shift();
  }

  return result.slice(-MAX_HISTORY);
}

/* ------------------------------ память ------------------------------ */

const EDGE_JUNK = /^[\s,.:;!?"'«»()\-–—]+|[\s,.:;!?"'«»()\-–—]+$/g;

// Приводит факт к аккуратному виду: без лишних пробелов, запятых,
// «мусорных» символов по краям и лишнего слова «что» в начале.
function cleanFact(value, max = 120) {
  let s = clean(value, 400)
    .replace(/[^\p{L}\p{N}\s.,:;!?%()«»"'№/+\-–—]/gu, " ")
    .replace(/([,.;:!?])\1+/g, "$1")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(EDGE_JUNK, "")
    .replace(/^что\s+/i, "")
    .replace(EDGE_JUNK, "");

  return s.slice(0, max).replace(EDGE_JUNK, "").trim();
}

// Для сравнения: нижний регистр, ё→е, только буквы и цифры.
function normalizeFact(value) {
  return String(value ?? "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

// Мягкое сравнение слов с учётом окончаний: цвет/цвета, кот/кота, собака/собаку.
function wordsMatch(a, b) {
  if (a === b) return true;

  const min = Math.min(a.length, b.length);
  const max = Math.max(a.length, b.length);
  if (min < 3) return false;

  let common = 0;
  while (common < min && a[common] === b[common]) common++;

  return common >= min - 1 && common >= max * 0.6;
}

const FILLERS = [
  "мда", "а", "ну", "так", "слушай", "алиса", "кстати", "и", "вот", "эй",
  "ладно", "хм", "эм", "ага", "окей", "ок", "скажи", "подскажи", "напомни",
  "пожалуйста", "скажите"
];

const QUESTION_WORDS = [
  "какой", "какая", "какое", "какие", "какого", "какую", "каком", "какому",
  "каким", "как", "где", "когда", "что", "сколько", "кто", "чей", "чья",
  "чье", "чьи", "куда", "откуда", "почему", "зачем"
];

const PERSONAL_WORDS = [
  "мой", "моя", "мое", "мои", "моего", "моей", "моих", "мою", "моему",
  "моим", "моем", "меня", "мне", "мной", "я"
];

const STOP_WORDS = new Set([
  ...FILLERS, ...QUESTION_WORDS, ...PERSONAL_WORDS,
  "ты", "тебе", "помнишь", "знаешь", "помню", "это", "есть", "был", "была",
  "были", "было", "быть", "называется", "про", "за", "у", "о", "об", "обо",
  "ли", "не", "на", "в", "по", "мы", "нам", "то", "же", "бы", "уже", "еще"
]);

function contentWords(text) {
  return normalizeFact(text)
    .split(" ")
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

function factMatches(words, fact) {
  const tokens = normalizeFact(fact).split(" ");
  return words.every(w => tokens.some(t => wordsMatch(w, t)));
}

function getMemory(body) {
  const facts = body?.state?.user?.memory?.facts;
  if (!Array.isArray(facts)) return [];

  return fitFacts(facts.filter(x => typeof x === "string"));
}

// Оставляет самые НОВЫЕ факты, если не помещаются в лимит хранилища.
function fitFacts(facts) {
  const picked = []; // от новых к старым

  for (const raw of [...facts].reverse()) {
    const fact = cleanFact(raw);

    if (
      !fact ||
      picked.some(x => normalizeFact(x) === normalizeFact(fact))
    ) continue;

    if (picked.length >= MAX_FACTS) break;

    const size = Buffer.byteLength(
      JSON.stringify({ memory: { facts: [...picked, fact] } }),
      "utf8"
    );

    if (size <= MAX_FACTS_BYTES) picked.push(fact);
  }

  return picked.reverse();
}

function speakFact(fact, query) {
  const body = fact.replace(/[.!?]+$/, "");

  if (/любим\S*\s+цвет/i.test(normalizeFact(query))) {
    const m = body.match(/любим\S*\s+цвет\s+(?:это\s+|—\s*|-\s*)?(.+)$/i);
    if (m) return `Твой любимый цвет — ${m[1].trim()}.`;
  }

  const possessive = {
    мой: "Твой", моя: "Твоя", моё: "Твоё", мое: "Твоё", мои: "Твои"
  };

  const first = body.split(/\s+/)[0]?.toLocaleLowerCase("ru-RU");

  if (possessive[first]) {
    return `${possessive[first]} ${body.slice(first.length).trim()}.`;
  }

  if (/^у меня\s/i.test(body)) return `У тебя ${body.slice(7).trim()}.`;
  if (/^меня\s/i.test(body)) return `Тебя ${body.slice(5).trim()}.`;

  return `Ты просил запомнить: ${body}.`;
}

// Отвечаем на вопросы о сохранённых фактах без обращения к Gemini.
function answerFromMemoryQuestion(text, rawFacts) {
  const facts = (Array.isArray(rawFacts) ? rawFacts : [])
    .map(f => cleanFact(f))
    .filter(Boolean);

  if (!facts.length) return null;

  const tokens = normalizeFact(text).split(" ");

  const isPersonal = tokens.some(t => PERSONAL_WORDS.includes(t));
  const isQuestion =
    /\?/.test(String(text)) ||
    tokens.some(t => QUESTION_WORDS.includes(t)) ||
    tokens.includes("помнишь") ||
    tokens.includes("знаешь");

  if (!isPersonal || !isQuestion) return null;

  const wanted = contentWords(text);
  if (!wanted.length) return null;

  const found = [...facts].reverse().find(f => factMatches(wanted, f));
  return found ? speakFact(found, text) : null;
}

function parseMemoryCommand(text) {
  const t = String(text).trim();

  let m = t.match(
    /^(?:алиса[, ]+)?запомни(?:\s+пожалуйста)?[\s,:;—-]*(?:что\s+)?(.*)$/i
  );

  if (m) return { type: "remember", fact: cleanFact(m[1]) };

  m = t.match(
    /^(?:алиса[, ]+)?(?:забудь|удали из памяти|не запоминай)\s*(.*)$/i
  );

  if (m) {
    return {
      type: "forget",
      target: clean(m[1]).replace(/^что\s+/i, "").replace(/[.!?]+$/, "")
    };
  }

  if (
    /^(?:алиса[, ]+)?(?:что ты помнишь|что ты обо мне помнишь|что ты обо мне знаешь|что запомнила)(?: обо мне)?\s*\??$/i
      .test(t)
  ) {
    return { type: "list" };
  }

  return null;
}

function memoryResponse(command, oldFacts) {
  const facts = fitFacts(oldFacts);

  if (command.type === "remember") {
    if (!command.fact) {
      return { text: "Что именно запомнить?", facts, update: false };
    }

    const next = fitFacts([...facts, command.fact]);

    return {
      text: `Хорошо, запомнила: ${command.fact}.`,
      facts: next,
      update: true
    };
  }

  if (command.type === "list" || !command.target) {
    if (!facts.length) {
      return {
        text: "Пока у меня нет сохранённых фактов.",
        facts,
        update: false
      };
    }

    const tail = command.type === "list"
      ? ""
      : " Чтобы удалить факт, скажи, что именно забыть.";

    return {
      text: `Я помню: ${facts.join("; ")}.${tail}`,
      facts,
      update: false
    };
  }

  const words = contentWords(command.target);
  const target = normalizeFact(command.target);

  const kept = facts.filter(f => {
    const hit =
      normalizeFact(f).includes(target) ||
      (words.length && factMatches(words, f));
    return !hit;
  });

  const changed = kept.length !== facts.length;

  return {
    text: changed
      ? "Хорошо, удалила это из памяти."
      : "Не нашла такой факт в сохранённой памяти.",
    facts: kept,
    update: changed
  };
}

/* ------------------------------ ответ Алисе ------------------------------ */

function response(res, text, history, userStateUpdate, sessionExtra) {
  const payload = {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: false
    },
    session_state: {
      ...(sessionExtra || {}),
      history: Array.isArray(history)
        ? history.slice(-MAX_HISTORY * 2)
        : []
    }
  };

  if (userStateUpdate) {
    payload.user_state_update = userStateUpdate;
  }

  return res.status(200).json(payload);
}

function buildHistory(history, userText, answer) {
  const h = Array.isArray(history)
    ? history.map(x => ({ role: x.role, text: clean(x.text, 700) }))
    : [];

  const last = h[h.length - 1];

  if (!last || last.role !== "user" || last.text !== userText) {
    h.push({ role: "user", text: clean(userText, 700) });
  }

  h.push({ role: "model", text: clean(answer, 700) });

  return h.slice(-MAX_HISTORY * 2);
}

function extractHistory(body) {
  const old = Array.isArray(body?.state?.session?.history)
    ? body.state.session.history
    : [];

  return old
    .filter(
      x => x &&
        ["user", "model"].includes(x.role) &&
        typeof x.text === "string"
    )
    .slice(-MAX_HISTORY * 2)
    .map(x => ({ role: x.role, text: clean(x.text, 700) }));
}

/* ------------------------------ определение запроса ------------------------------ */

const WEATHER_RE =
  /(?<![\p{L}])погод(?:а|ы|е|у|ой|ою)(?![\p{L}])|сколько градусов|будет ли (?:дождь|снег)|температур\w* (?:на улице|за окном|воздуха)/iu;

const NEWS_RE =
  /(?<![\p{L}])новост[\p{L}]*|что (?:произошло|случилось|нового) (?:сегодня|вчера|в мире|в стране)|события (?:в мире|дня)/iu;

const SPORTS_RE =
  /кто выиграл|кто победил|результат\w* матч|сч[её]т матч|последн\w* матч|футбол.*(сегодня|вчера|сч[её]т|матч)|хокке.*(сегодня|вчера|сч[её]т|матч)/iu;

const GENERIC_SEARCH_RE =
  /(найди|найти|поищи|в интернете|актуальн\w*|курс валют|цена сегодня|последняя информация)/iu;

function isWeather(text) { return WEATHER_RE.test(text); }
function isNews(text) { return NEWS_RE.test(text); }
function isSports(text) { return SPORTS_RE.test(text); }

function isSearch(text) {
  return (
    isWeather(text) ||
    isNews(text) ||
    isSports(text) ||
    GENERIC_SEARCH_RE.test(text)
  );
}

function searchKind(text) {
  if (isWeather(text)) return "weather";
  if (isNews(text)) return "news";
  if (isSports(text)) return "sports";
  return "general";
}

const CITY_STOP = new Set([
  "сегодня", "завтра", "послезавтра", "сейчас", "вчера", "утром", "днем",
  "днём", "вечером", "ночью", "неделю", "неделе", "недели", "выходные",
  "выходных", "выходным", "будет", "ли", "дождь", "дождя", "снег", "снега",
  "градусов", "какая", "какой", "какое", "какие", "погода", "погоду",
  "погоды", "погоде", "погодой", "температура", "температуру", "температуры",
  "скажи", "подскажи", "расскажи", "покажи", "узнай", "найди", "пожалуйста",
  "алиса", "мне", "хочу", "узнать", "про", "о", "об", "на", "в", "во", "для",
  "по", "там", "тут", "у", "нас", "ближайшие", "ближайшую", "дни", "день",
  "этой", "эту", "что", "а", "и", "мда", "ну"
]);

const WEATHER_PREPS = new Set(["в", "во", "для", "по"]);

// Возвращает «в москве», «нижний новгород» или "" — если города нет.
function extractCity(text) {
  const tokens =
    String(text).toLocaleLowerCase("ru-RU").match(/[\p{L}-]+/gu) || [];

  for (let i = 0; i < tokens.length - 1; i++) {
    if (!WEATHER_PREPS.has(tokens[i])) continue;

    const city = [];

    for (let j = i + 1; j < tokens.length && city.length < 3; j++) {
      if (CITY_STOP.has(tokens[j])) break;
      city.push(tokens[j]);
    }

    if (city.length) {
      return tokens[i] === "для"
        ? city.join(" ")
        : `${tokens[i]} ${city.join(" ")}`;
    }
  }

  const rest = tokens.filter(t => !CITY_STOP.has(t));
  return rest.length && rest.length <= 2 ? rest.join(" ") : "";
}

function weatherDay(text) {
  const t = String(text).toLocaleLowerCase("ru-RU");
  if (/послезавтра/.test(t)) return "послезавтра";
  if (/завтра/.test(t)) return "завтра";
  if (/недел/.test(t)) return "на неделю";
  return "сегодня";
}

function cityStems(city) {
  return String(city)
    .toLocaleLowerCase("ru-RU")
    .match(/[\p{L}-]+/gu)
    ?.filter(t => !WEATHER_PREPS.has(t) && t.length > 2)
    .map(t => t.slice(0, 4)) || [];
}

function generalQuery(text) {
  return clean(
    text.replace(
      /^(?:алиса[, ]*)?(?:найди|найти|поищи|расскажи|скажи)\s*/i,
      ""
    ),
    180
  ) || text;
}

/* ------------------------------ сеть ------------------------------ */

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, timeoutMs));

  try {
    const r = await fetch(url, { ...options, signal: controller.signal });
    const raw = await r.text();
    let data = {};

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {}

    return { r, data };
  } finally {
    clearTimeout(timer);
  }
}

async function gemini(text, history, memory, timeoutMs, model = MODEL) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) throw new Error("MISSING_GEMINI_API_KEY");
  if (timeoutMs < 300) throw new Error("NO_TIME_LEFT");

  const contents = safeHistory(history);
  const last = contents[contents.length - 1];

  if (!last || last.role !== "user" || last.parts[0].text !== text) {
    if (last && last.role === "user") {
      last.parts[0].text += "\n" + text;
    } else {
      contents.push({ role: "user", parts: [{ text }] });
    }
  }

  // Запрос не должен начинаться с реплики модели.
  const sliced = contents.slice(-MAX_HISTORY);
  while (sliced.length && sliced[0].role !== "user") sliced.shift();

  const prompt = SYSTEM_PROMPT + (
    memory.length
      ? " Сохранённые факты пользователя: " + memory.join("; ") + "."
      : ""
  );

  let result;

  try {
    result = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key
        },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: prompt }] },
          contents: sliced,
          // temperature не передаём: для моделей Gemini 3.5/3.6 параметры
          // сэмплинга объявлены устаревшими.
          generationConfig: { maxOutputTokens: 300 }
        })
      },
      timeoutMs
    );
  } catch (e) {
    console.error("Gemini fetch failed:", model, e?.name, e?.message);

    throw new Error(
      e?.name === "AbortError" ? "GEMINI_TIMEOUT" : "GEMINI_NETWORK_ERROR"
    );
  }

  if (!result.r.ok) {
    const status = result.r.status;

    console.error(
      "Gemini HTTP error:",
      model,
      status,
      JSON.stringify(result.data?.error || {}).slice(0, 600)
    );

    if (status === 400) throw new Error("GEMINI_BAD_REQUEST");
    if (status === 401 || status === 403) throw new Error("GEMINI_KEY_REJECTED");
    if (status === 429) throw new Error("GEMINI_QUOTA");

    throw new Error("GEMINI_HTTP_" + status);
  }

  const answer = (result.data?.candidates?.[0]?.content?.parts || [])
    .filter(p => !p.thought)
    .map(p => p.text || "")
    .join("")
    .trim();

  if (!answer) {
    console.error(
      "Gemini empty response:",
      model,
      JSON.stringify(
        result.data?.promptFeedback ||
        result.data?.candidates?.[0]?.finishReason ||
        {}
      ).slice(0, 500)
    );

    throw new Error("GEMINI_EMPTY_RESPONSE");
  }

  return clean(answer);
}

function isRetriable(error) {
  const m = error?.message || "";

  return (
    m === "GEMINI_QUOTA" ||
    m === "GEMINI_TIMEOUT" ||
    m === "GEMINI_NETWORK_ERROR" ||
    m === "GEMINI_EMPTY_RESPONSE" ||
    /^GEMINI_HTTP_5\d\d$/.test(m)
  );
}

// Основная модель → одна попытка на запасной модели (если хватает времени).
// 503/429 на одной модели часто не повторяются на другой.
async function askGemini(text, history, memory, remaining) {
  const models = [MODEL];
  if (FALLBACK_MODEL && FALLBACK_MODEL !== MODEL) models.push(FALLBACK_MODEL);
  if (models.length < 2) models.push(MODEL);

  let lastError = null;

  for (let i = 0; i < models.length; i++) {
    const cap = i === 0 ? GEMINI_FIRST_TIMEOUT_MS : GEMINI_RETRY_TIMEOUT_MS;
    const timeoutMs = Math.min(cap, remaining() - SAFETY_MS);

    if (timeoutMs < MIN_ATTEMPT_MS) {
      lastError = lastError || new Error("NO_TIME_LEFT");
      break;
    }

    try {
      return await gemini(text, history, memory, timeoutMs, models[i]);
    } catch (e) {
      lastError = e;

      if (!isRetriable(e)) throw e;

      // Лимит на той же модели повторять бессмысленно.
      if (e.message === "GEMINI_QUOTA" && models[i + 1] === models[i]) break;

      console.warn(`Gemini ${models[i]} failed (${e.message}); next attempt.`);
    }
  }

  throw lastError || new Error("NO_TIME_LEFT");
}

async function serper(query, kind, timeoutMs) {
  const key = process.env.SERPER_API_KEY;

  if (!key) {
    console.error("SERPER_API_KEY is missing");
    return null;
  }

  if (timeoutMs < 300) return null;

  try {
    const news = kind === "news";

    const { r, data } = await fetchJson(
      `https://google.serper.dev/${news ? "news" : "search"}`,
      {
        method: "POST",
        headers: { "X-API-KEY": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          q: query,
          gl: "ru",
          hl: "ru",
          num: 5,
          ...(news ? { tbs: "qdr:d" } : {})
        })
      },
      timeoutMs
    );

    if (!r.ok) {
      console.error("Serper HTTP error:", r.status, JSON.stringify(data).slice(0, 400));
      return null;
    }

    const arr = news ? data.news : data.organic;

    const results = (Array.isArray(arr) ? arr : [])
      .slice(0, 5)
      .map(x => ({
        title: clean(x.title, 160),
        date: clean(x.date, 60),
        snippet: clean(x.snippet, 260)
      }))
      .filter(x => x.title || x.snippet);

    const box = data.answerBox;

    if (box && typeof box === "object") {
      const parts = [
        box.answer,
        box.snippet,
        box.temperature && `${box.temperature}${box.unit || ""}`,
        box.weather
      ].filter(Boolean);

      if (parts.length) {
        results.unshift({
          title: "Ответ",
          date: clean(box.date, 60),
          snippet: clean(parts.join(", "), 260)
        });
      }
    }

    return results.length ? results : null;
  } catch (e) {
    console.error("Serper fetch failed:", e?.name, e?.message);
    return null;
  }
}

/* ------------------------------ ответ по результатам поиска ------------------------------ */

const TEMP_RE = /[+\-−–]?\d{1,2}(?:[.,]\d)?\s?(?:°|градус)/iu;

function uniqueResults(results) {
  const seen = new Set();

  return (results || []).filter(x => {
    const key = normalizeFact(x.snippet || x.title);
    if (!key || key.length < 12 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Не выдаём случайные данные за достоверные: берём только то, что
// подтверждается результатами, и честно говорим, если не нашли.
function buildSearchAnswer(kind, results, ctx = {}) {
  const list = uniqueResults(results);

  if (kind === "weather") {
    const stems = cityStems(ctx.city || "");

    const relevant = list.filter(x => {
      const hay = `${x.title} ${x.snippet}`.toLocaleLowerCase("ru-RU");
      return (
        TEMP_RE.test(x.snippet || "") &&
        (!stems.length || stems.some(s => hay.includes(s)))
      );
    });

    if (!relevant.length) {
      return `Не нашла надёжных данных о погоде ${ctx.city || ""}. Лучше посмотреть в приложении погоды.`
        .replace(/\s+/g, " ");
    }

    const top = relevant[0];
    const when = top.date ? ` (${top.date})` : "";

    return `По данным поиска, погода ${ctx.city || ""} ${ctx.day || ""}${when}: ${top.snippet} Данные из интернета могут быть неточными.`
      .replace(/\s+/g, " ");
  }

  if (!list.length) {
    if (kind === "news") {
      return "Свежих новостей за последние сутки не нашла. Попробуй уточнить тему.";
    }
    if (kind === "sports") {
      return "Не нашла подтверждённый результат матча. Уточните команды или турнир.";
    }
    return "Поиск не вернул подходящих результатов. Попробуйте сформулировать запрос иначе.";
  }

  if (kind === "news") {
    const lines = list
      .slice(0, 3)
      .map(x => (x.date ? `${x.title} (${x.date})` : x.title));

    return `Главное по данным поиска за последние сутки: ${lines.join("; ")}.`;
  }

  const lines = list
    .slice(0, 2)
    .map(x => x.snippet || x.title);

  const tail = kind === "sports"
    ? " Проверьте дату матча: поиск мог вернуть не самый свежий результат."
    : "";

  return `По данным поиска: ${lines.join(" ")}${tail}`;
}

/* ------------------------------ локальные ответы ------------------------------ */

function localReply(text) {
  const t = text.toLocaleLowerCase("ru-RU").trim().replace(/[!.?]+$/, "");

  if (
    /^(привет|приветик|здравствуй|здравствуйте|доброе утро|добрый день|добрый вечер|хай|салют|алиса привет)$/i
      .test(t)
  ) {
    return "Привет! Рада тебя слышать. Что хочешь узнать?";
  }

  if (/^(как дела|как у тебя дела|ты как)$/i.test(t)) {
    return "Всё хорошо, спасибо! Готова помочь. А у тебя как?";
  }

  if (/^(спасибо|спасибо большое|благодарю)$/i.test(t)) {
    return "Пожалуйста!";
  }

  if (/^(расскажи анекдот|анекдот|расскажи шутку|пошути|скажи шутку)$/i.test(t)) {
    const jokes = [
      "Программист звонит в библиотеку: «У вас есть книги про паранойю?» Библиотекарь шёпотом отвечает: «Они прямо за вами».",
      "Покупатель спрашивает: «У вас есть компьютер, который никогда не зависает?» Продавец: «Есть. Но он уже три дня не отвечает».",
      "Учитель спрашивает: «Почему опоздал?» Ученик: «На дороге знак был: “Осторожно, дети!” Вот я и шёл осторожно»."
    ];

    return jokes[Math.floor(Math.random() * jokes.length)];
  }

  if (/^(кто ты|как тебя зовут|ты кто)$/i.test(t)) {
    return "Я голосовой помощник Алисы с подключённой нейросетью. Могу отвечать на вопросы и искать актуальную информацию.";
  }

  return null;
}

function errorText(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_API_KEY":
      return "На сервере не задан GEMINI_API_KEY. Проверь переменные окружения Vercel.";
    case "GEMINI_KEY_REJECTED":
      return "Gemini отклонила API-ключ. Проверь GEMINI_API_KEY в Vercel.";
    case "GEMINI_QUOTA":
      return "У Gemini закончился доступный лимит запросов. Попробуй позже.";
    case "GEMINI_BAD_REQUEST":
      return "Gemini отклонила формат запроса. Ошибка записана в лог Vercel.";
    case "GEMINI_HTTP_503":
      return "Gemini сейчас перегружена и временно не отвечает. Попробуй ещё раз через несколько секунд.";
    case "GEMINI_TIMEOUT":
    case "NO_TIME_LEFT":
      return "Нейросеть не успела ответить за отведённое время. Попробуй ещё раз.";
    case "GEMINI_NETWORK_ERROR":
      return "Сервер не смог соединиться с Gemini. Попробуй ещё раз.";
    case "GEMINI_EMPTY_RESPONSE":
      return "Gemini не вернула текстовый ответ. Попробуй задать вопрос иначе.";
    default:
      return "Не удалось получить ответ от нейросети. Код ошибки записан в лог Vercel.";
  }
}

/* ------------------------------ обработка реплики ------------------------------ */

// Возвращает { text, history, userStateUpdate?, sessionExtra? }.
// Ошибки Gemini пробрасываются наружу: в историю они не попадают.
async function processTurn(body, history, remaining) {
  const text = clean(
    body?.request?.original_utterance || body?.request?.command || "",
    500
  );

  // Яндекс Диалоги периодически шлют служебный "ping".
  if (text.toLowerCase() === "ping") {
    return { text: "pong", history };
  }

  const memory = getMemory(body);

  if (!text) {
    return { text: "Привет! Задай вопрос, и я постараюсь помочь.", history };
  }

  const memCommand = parseMemoryCommand(text);

  if (memCommand) {
    const result = memoryResponse(memCommand, memory);

    return {
      text: result.text,
      history: buildHistory(history, text, result.text),
      userStateUpdate: result.update
        ? { memory: { facts: result.facts } }
        : null
    };
  }

  const local = localReply(text);

  if (local) {
    return { text: local, history: buildHistory(history, text, local) };
  }

  const memoryAnswer = answerFromMemoryQuestion(text, memory);

  if (memoryAnswer) {
    return {
      text: memoryAnswer,
      history: buildHistory(history, text, memoryAnswer)
    };
  }

  const pending = body?.state?.session?.pending;
  const wordCount = (text.match(/[\p{L}-]+/gu) || []).length;

  const weatherFollowUp =
    pending?.kind === "weather" && !isSearch(text) && wordCount <= 4;

  if (isSearch(text) || weatherFollowUp) {
    const kind = weatherFollowUp ? "weather" : searchKind(text);
    let query;
    const ctx = {};

    if (kind === "weather") {
      ctx.city = extractCity(text);
      ctx.day = weatherDay(weatherFollowUp ? `${pending.day || ""} ${text}` : text);

      if (!ctx.city) {
        const ask = "Для какого города нужна погода?";

        return {
          text: ask,
          history: buildHistory(history, text, ask),
          sessionExtra: { pending: { kind: "weather", day: ctx.day } }
        };
      }

      query = `погода ${ctx.city} ${ctx.day}`;
    } else if (kind === "news") {
      query = generalQuery(text);
    } else if (kind === "sports") {
      query = `${text} счёт результат`;
    } else {
      query = generalQuery(text);
    }

    console.log("Search query:", query);

    const results = await serper(
      query,
      kind,
      Math.min(SERPER_TIMEOUT_MS, remaining() - SAFETY_MS)
    );

    const answer = buildSearchAnswer(kind, results, ctx);

    return { text: answer, history: buildHistory(history, text, answer) };
  }

  const answer = await askGemini(text, history, memory, remaining);

  return { text: answer, history: buildHistory(history, text, answer) };
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-voice",
      model: MODEL
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const started = Date.now();
  const remaining = () => TOTAL_BUDGET_MS - (Date.now() - started);

  let body = req.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  if (!body || typeof body !== "object") body = {};

  const history = extractHistory(body);

  // Жёсткий дедлайн: что бы ни происходило, отвечаем до лимита Диалогов.
  let timer;

  const deadline = new Promise(resolve => {
    timer = setTimeout(
      () => resolve({
        text: "Не успела ответить вовремя. Повтори вопрос, пожалуйста.",
        history
      }),
      Math.max(200, remaining() - 100)
    );
  });

  let result;

  try {
    result = await Promise.race([
      processTurn(body, history, remaining),
      deadline
    ]);
  } catch (error) {
    console.error("Alice handler error:", error?.message || error);
    result = { text: errorText(error), history };
  } finally {
    clearTimeout(timer);
  }

  return response(
    res,
    result.text,
    result.history,
    result.userStateUpdate,
    result.sessionExtra
  );
}

export {
  clean,
  cleanFact,
  fitAliceText,
  fitFacts,
  safeHistory,
  parseMemoryCommand,
  memoryResponse,
  localReply,
  answerFromMemoryQuestion,
  isSearch,
  extractCity,
  buildSearchAnswer
};
