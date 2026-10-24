const MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const MAX_ALICE_TEXT = 1024;
const MAX_HISTORY = 8;
const TOTAL_BUDGET_MS = 4100;
const GEMINI_TIMEOUT_MS = 3500;
const SERPER_TIMEOUT_MS = 2200;

const SYSTEM_PROMPT = [
  "Ты — голосовой помощник навыка Яндекс Алисы.",
  "Отвечай естественно, по-русски, дружелюбно и по существу.",
  "Обычно ответ должен занимать 1–3 коротких предложения.",
  "Учитывай переданную историю и явно сохранённые факты пользователя.",
  "Не выдумывай факты. Если не знаешь — прямо скажи об этом.",
  "Не используй Markdown, таблицы, заголовки и списки, если пользователь не просит.",
  "Для актуальных данных используй предоставленные результаты поиска и укажи, если их недостаточно."
].join(" ");

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
  if (!text) return "Не удалось подготовить ответ. Попробуйте ещё раз.";
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

function getMemory(body) {
  const facts = body?.state?.user?.memory?.facts;

  if (!Array.isArray(facts)) return [];

  return facts
    .filter(x => typeof x === "string")
    .map(x => clean(x, 120).replace(/^[\s,.:;—-]+/, ""))
    .filter(Boolean)
    .slice(-10);
}

function normalizeFact(s) {
  return clean(s, 180)
    .toLocaleLowerCase("ru-RU")
    .replace(/[.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseMemoryCommand(text) {
  let m = text.match(
    /^(?:алиса[, ]*)?запомни(?: пожалуйста)?(?:\s*,?\s*(?:что\s*)?)?(.+)$/i
  );

  if (m) {
    const fact = clean(m[1])
      .replace(/^[\s,.:;—-]+/, "")
      .replace(/[.!?]+$/, "");

    if (fact) {
      return { type: "remember", fact: clean(fact, 120) };
    }
  }

  m = text.match(
    /^(?:алиса[, ]*)?(?:забудь|удали из памяти|не запоминай)\s*(.*)$/i
  );

  if (m) {
    return {
      type: "forget",
      target: clean(m[1]).replace(/[.!?]+$/, "")
    };
  }

  if (/^(?:что ты помнишь|что ты обо мне помнишь|что запомнила)\??$/i.test(text.trim())) {
    return { type: "list" };
  }

  return null;
}

function fitFacts(facts) {
  const out = [];

  for (const f of facts.slice(-12)) {
    const fact = clean(f, 120).replace(/^[\s,.:;—-]+/, "");

    if (!fact || out.some(x => normalizeFact(x) === normalizeFact(fact))) {
      continue;
    }

    const test = [...out, fact];

    if (
      Buffer.byteLength(
        JSON.stringify({ memory: { facts: test } }),
        "utf8"
      ) <= 850
    ) {
      out.push(fact);
    }
  }

  return out;
}

function memoryResponse(command, oldFacts) {
  let facts = fitFacts(oldFacts);

  if (command.type === "remember") {
    facts = fitFacts([
      ...facts.filter(
        x => normalizeFact(x) !== normalizeFact(command.fact)
      ),
      command.fact
    ]);

    return {
      text: `Хорошо, запомнила: ${command.fact}.`,
      facts,
      update: true
    };
  }

  if (command.type === "list") {
    return {
      text: facts.length
        ? `Я помню: ${facts.join("; ")}.`
        : "Пока у меня нет сохранённых фактов.",
      facts,
      update: false
    };
  }

  if (!command.target) {
    return {
      text: facts.length
        ? `Я помню: ${facts.join("; ")}. Чтобы удалить факт, скажи, что именно забыть.`
        : "Пока у меня нет сохранённых фактов.",
      facts,
      update: false
    };
  }

  const target = normalizeFact(command.target);
  const words = target.split(" ").filter(x => x.length > 2);

  const kept = facts.filter(f => {
    const n = normalizeFact(f);
    return !(
      n.includes(target) ||
      (words.length && words.every(w => n.includes(w)))
    );
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

function response(res, text, history, userStateUpdate) {
  const payload = {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: false
    },
    session_state: {
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
    ? history.map(x => ({
        role: x.role,
        text: clean(x.text, 700)
      }))
    : [];

  const last = h[h.length - 1];

  if (!last || last.role !== "user" || last.text !== userText) {
    h.push({ role: "user", text: clean(userText, 700) });
  }

  h.push({ role: "model", text: clean(answer, 700) });

  return h.slice(-MAX_HISTORY * 2);
}

function isWeather(text) {
  return /погод\w*|температур\w*|сколько градусов|будет ли дождь|осадки/i.test(text);
}

function isNews(text) {
  return /новост\w*|что произошло|что случилось|события в мире/i.test(text);
}

function isSports(text) {
  return /кто выиграл|кто победил|результат\w* матч|сч[её]т матч|последн\w* матч|футбол.*(сегодня|вчера|сч[её]т|матч)|хокке.*(сегодня|вчера|сч[её]т|матч)/i.test(text);
}

function isSearch(text) {
  return (
    isWeather(text) ||
    isNews(text) ||
    isSports(text) ||
    /(найди|найти|поищи|в интернете|актуальн\w*|курс валют|цена сегодня|последняя информация)/i.test(text)
  );
}

function searchQuery(text) {
  if (isWeather(text)) {
    const match = text.match(
      /(?:в|для|по)\s+([\p{L}-]+(?:\s+[\p{L}-]+){0,2})/iu
    );

    const location = match?.[1] || "";

    return location
      ? `погода ${location} сегодня температура осадки`
      : `${text} погода температура осадки`;
  }

  if (isNews(text)) {
    return `${text} последние новости за 24 часа дата`;
  }

  if (isSports(text)) {
    return `${text} результат матча`;
  }

  return clean(
    text.replace(
      /^(?:алиса[, ]*)?(?:найди|найти|поищи|расскажи|скажи)\s*/i,
      ""
    ),
    180
  ) || text;
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    Math.max(100, timeoutMs)
  );

  try {
    const r = await fetch(url, {
      ...options,
      signal: controller.signal
    });

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

async function gemini(text, history, memory, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) throw new Error("MISSING_GEMINI_API_KEY");
  if (timeoutMs < 300) throw new Error("NO_TIME_LEFT");

  const contents = safeHistory(history);
  const last = contents[contents.length - 1];

  if (!last || last.role !== "user" || last.parts[0].text !== text) {
    const entry = { role: "user", parts: [{ text }] };

    if (contents.length && contents[contents.length - 1].role === "user") {
      contents[contents.length - 1].parts[0].text += "\n" + text;
    } else {
      contents.push(entry);
    }
  }

  const prompt = SYSTEM_PROMPT + (
    memory.length
      ? " Сохранённые факты пользователя: " + memory.join("; ") + "."
      : ""
  );

  let result;

  try {
    result = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: prompt }]
          },
          contents: contents.slice(-MAX_HISTORY),
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 180
          }
        })
      },
      timeoutMs
    );
  } catch (e) {
    console.error("Gemini fetch failed:", e?.name, e?.message);
    throw new Error(
      e?.name === "AbortError"
        ? "GEMINI_TIMEOUT"
        : "GEMINI_NETWORK_ERROR"
    );
  }

  if (!result.r.ok) {
    console.error(
      "Gemini HTTP error:",
      result.r.status,
      JSON.stringify(result.data?.error || {}).slice(0, 600)
    );

    if (result.r.status === 400) throw new Error("GEMINI_BAD_REQUEST");
    if (result.r.status === 401 || result.r.status === 403) {
      throw new Error("GEMINI_KEY_REJECTED");
    }
    if (result.r.status === 429) throw new Error("GEMINI_QUOTA");

    throw new Error("GEMINI_HTTP_" + result.r.status);
  }

  const answer = (
    result.data?.candidates?.[0]?.content?.parts || []
  )
    .map(p => p.text || "")
    .join("")
    .trim();

  if (!answer) {
    console.error(
      "Gemini empty response:",
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

async function serper(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;

  if (!key) {
    console.error("SERPER_API_KEY is missing");
    return null;
  }

  try {
    const news = isNews(query);

    const { r, data } = await fetchJson(
      `https://google.serper.dev/${news ? "news" : "search"}`,
      {
        method: "POST",
        headers: {
          "X-API-KEY": key,
          "Content-Type": "application/json"
        },
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
      console.error(
        "Serper HTTP error:",
        r.status,
        JSON.stringify(data).slice(0, 400)
      );
      return null;
    }

    const arr = news ? data.news : data.organic;

    const results = (Array.isArray(arr) ? arr : [])
      .slice(0, 4)
      .map(x => ({
        title: clean(x.title, 160),
        date: clean(x.date, 60),
        snippet: clean(x.snippet, 260)
      }))
      .filter(x => x.title || x.snippet);

    if (data.answerBox?.answer) {
      results.unshift({
        title: "Ответ",
        date: "",
        snippet: clean(data.answerBox.answer, 260)
      });
    } else if (data.answerBox?.snippet) {
      results.unshift({
        title: "Ответ",
        date: "",
        snippet: clean(data.answerBox.snippet, 260)
      });
    }

    return results.length ? results : null;
  } catch (e) {
    console.error("Serper fetch failed:", e?.name, e?.message);
    return null;
  }
}

function searchFallback(results, kind) {
  if (!results?.length) {
    if (kind === "weather") {
      return "Не удалось получить свежий прогноз погоды. Попробуйте ещё раз чуть позже.";
    }

    if (kind === "news") {
      return "Не удалось получить свежие новости. Попробуйте ещё раз чуть позже.";
    }

    if (kind === "sports") {
      return "Не удалось найти подтверждённый результат матча. Уточните команды или турнир.";
    }

    return "Поиск сейчас не вернул результатов. Попробуйте сформулировать запрос иначе.";
  }

  const lines = results
    .slice(0, 3)
    .map(x => [x.title, x.date, x.snippet].filter(Boolean).join(". "));

  return fitAliceText(lines.join(". "));
}

function localReply(text) {
  const t = text
    .toLocaleLowerCase("ru-RU")
    .trim()
    .replace(/[!.?]+$/, "");

  if (/^(привет|приветик|здравствуй|здравствуйте|доброе утро|добрый день|добрый вечер|хай|салют|алиса привет)$/i.test(t)) {
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

  const text = clean(
    body?.request?.original_utterance ||
    body?.request?.command ||
    "",
    500
  );

  const oldHistory = Array.isArray(body?.state?.session?.history)
    ? body.state.session.history
    : [];

  const history = oldHistory
    .filter(x => x && ["user", "model"].includes(x.role) && typeof x.text === "string")
    .slice(-MAX_HISTORY * 2)
    .map(x => ({ role: x.role, text: clean(x.text, 700) }));

  const memory = getMemory(body);

  if (!text) {
    return response(
      res,
      "Привет! Задай вопрос, и я постараюсь помочь.",
      history
    );
  }

  const memCommand = parseMemoryCommand(text);

  if (memCommand) {
    const result = memoryResponse(memCommand, memory);

    const update = result.update
      ? { memory: { facts: result.facts } }
      : null;

    return response(
      res,
      result.text,
      buildHistory(history, text, result.text),
      update
    );
  }

  const local = localReply(text);

  if (local) {
    return response(
      res,
      local,
      buildHistory(history, text, local)
    );
  }

  try {
    if (isSearch(text)) {
      const query = searchQuery(text);
      console.log("Search query:", query);

      const results = await serper(
        query,
        Math.min(
          SERPER_TIMEOUT_MS,
          Math.max(100, remaining() - 500)
        )
      );

      const kind = isWeather(text)
        ? "weather"
        : isNews(text)
          ? "news"
          : isSports(text)
            ? "sports"
            : "general";

      const answer = searchFallback(results, kind);

      return response(
        res,
        answer,
        buildHistory(history, text, answer)
      );
    }

    const answer = await gemini(
      text,
      history,
      memory,
      Math.min(GEMINI_TIMEOUT_MS, remaining() - 250)
    );

    return response(
      res,
      answer,
      buildHistory(history, text, answer)
    );
  } catch (error) {
    console.error("Alice handler error:", error?.message || error);

    const message = errorText(error);

    return response(
      res,
      message,
      buildHistory(history, text, message)
    );
  }
}

export { clean, safeHistory, parseMemoryCommand, localReply, isSearch };
