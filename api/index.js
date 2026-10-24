
const MODEL = "gemini-3.5-flash-lite";
const GEMINI_TIMEOUT_MS = 2200;
const SERPER_TIMEOUT_MS = 1100;
const MAX_TEXT = 1024;
const MAX_HISTORY = 12;

const SYSTEM_INSTRUCTION = `
Ты — голосовой собеседник Алисы. Говори естественно,
дружелюбно и на русском языке.
Отвечай кратко, как для умной колонки.
На простые вопросы отвечай одним-двумя предложениями.
Если пользователь просит подробности, объясняй подробнее.
Учитывай историю разговора.
Не выдумывай факты и предпочтения пользователя.
Не используй Markdown без необходимости.
`.trim();

function cleanText(value, max = MAX_TEXT) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

function cleanSnippet(value, max = 300) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\.{2,}|[…]+/g, ".")
    .trim()
    .slice(0, max)
    .trim();
}

function getHistory(body) {
  const history =
    body?.state?.session?.history ??
    body?.session_state?.history ??
    [];

  if (!Array.isArray(history)) return [];

  return history
    .filter(item =>
      item &&
      (item.role === "user" || item.role === "model") &&
      typeof item.text === "string"
    )
    .slice(-MAX_HISTORY)
    .map(item => ({
      role: item.role,
      text: cleanText(item.text, 800)
    }));
}

function getSearchEnabled(body) {
  return (
    body?.state?.session?.search_enabled ??
    body?.session_state?.search_enabled ??
    true
  ) !== false;
}

function aliceResponse(res, text, history = [], searchEnabled = true) {
  return res.status(200).json({
    version: "1.0",
    response: {
      text: cleanText(text) ||
        "Не удалось подготовить ответ. Попробуйте ещё раз.",
      end_session: false
    },
    session_state: {
      history: history.slice(-MAX_HISTORY),
      search_enabled: searchEnabled
    }
  });
}

function isSearchIntent(text) {
  return /(найди|найти|поищи|поиск|последн\w* новост|новост\w*|свеж\w*|актуальн\w*|что случил\w*|сегодняшн\w*|курс валют|погод\w*|прогноз погоды|в интернете)/i
    .test(text);
}

function isWeatherIntent(text) {
  return /(погод\w*|температур\w*|прогноз погоды)/i.test(text);
}

function extractSearchQuery(text) {
  return cleanText(
    text.replace(
      /^(?:алиса[, ]*)?(?:найди|найти|поищи|поиск|расскажи|покажи|скажи)\s*/i,
      ""
    ),
    180
  ) || cleanText(text, 180);
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const rawText = await response.text();
    let data = {};

    try {
      data = rawText ? JSON.parse(rawText) : {};
    } catch {
      data = {};
    }

    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query) {
  const apiKey = process.env.SERPER_API_KEY;

  if (!apiKey) {
    console.error("SERPER_API_KEY is missing");
    return null;
  }

  const { response, data } = await fetchJsonWithTimeout(
    "https://google.serper.dev/search",
    {
      method: "POST",
      headers: {
        "X-API-KEY": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        q: query,
        gl: "ru",
        hl: "ru",
        num: 5
      })
    },
    SERPER_TIMEOUT_MS
  );

  if (!response.ok) {
    console.error("Serper HTTP status:", response.status);
    return null;
  }

  const results = [];
  const seen = new Set();

  const box = data.answerBox;
  if (box?.answer || box?.snippet) {
    const text = cleanSnippet(box.answer || box.snippet, 350);
    if (text) results.push({ title: "Краткий ответ", snippet: text });
  }

  const organic = Array.isArray(data.organic) ? data.organic : [];

  for (const item of organic) {
    const title = cleanSnippet(item?.title, 160);
    const snippet = cleanSnippet(item?.snippet, 300);
    const key = (title + snippet).toLowerCase();

    if ((!title && !snippet) || seen.has(key)) continue;
    seen.add(key);

    results.push({
      title,
      snippet,
      source: cleanText(item?.source || "", 100),
      date: cleanText(item?.date || "", 50)
    });

    if (results.length >= 4) break;
  }

  return results.length ? results : null;
}

async function summarizeSearch(userText, results, weather) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  const sourceText = results.map((item, i) =>
    `${i + 1}. ${item.title || "Материал"}`
    + `${item.date ? `; дата: ${item.date}` : ""}`
    + `${item.source ? `; источник: ${item.source}` : ""}`
    + `\n${item.snippet || ""}`
  ).join("\n\n").slice(0, 1800);

  const instruction = weather
    ? `Ты голосовой помощник. Кратко ответь на вопрос о погоде.
Используй только предоставленные результаты.
Ориентируйся на конкретный населённый пункт из запроса.
Скажи температуру и краткий прогноз, если они есть в источниках.
Не подменяй населённый пункт соседним городом или регионом.
Если текущая температура не найдена, не выдумывай её.
Обычно достаточно одного-двух предложений.
Не читай названия страниц и не перечисляй поисковые результаты.`
    : `Ты голосовой помощник, который готовит краткие сводки новостей.
Ответь на запрос пользователя, опираясь только на источники ниже.
Выдели главное и объясни, что произошло, без обрывков и повторов.
Для новостей используй две-три короткие фразы.
Если даты источников указаны, учитывай их при выборе свежих новостей.
Не выдавай старые материалы за сегодняшние.
Не выдумывай факты, даты, цифры и причинно-следственные связи.
Если результатов недостаточно, честно скажи об этом.
Не перечисляй заголовки подряд и не читай текст страниц дословно.
Ответ предназначен для озвучивания колонкой.`;

  try {
    const { response, data } = await fetchJsonWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: instruction }]
          },
          contents: [{
            role: "user",
            parts: [{
              text: `Вопрос пользователя: ${userText}\n\nРезультаты поиска:\n${sourceText}`
            }]
          }],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 120,
            thinkingConfig: {
              thinkingLevel: "MINIMAL"
            }
          }
        })
      },
      GEMINI_TIMEOUT_MS
    );

    if (!response.ok) {
      console.error("Search summary Gemini status:", response.status);
      return null;
    }

    const answer = data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    return answer ? cleanText(answer, MAX_TEXT) : null;
  } catch (error) {
    console.error(
      "Search summary error:",
      error?.name || "Error"
    );
    return null;
  }
}

async function askGemini(userText, history) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return "Нейросеть пока не настроена. Проверьте ключ Gemini в Vercel.";
  }

  const contents = [
    ...history.map(item => ({
      role: item.role,
      parts: [{ text: item.text }]
    })),
    {
      role: "user",
      parts: [{ text: userText }]
    }
  ].slice(-8);

  try {
    const { response, data } = await fetchJsonWithTimeout(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: SYSTEM_INSTRUCTION }]
          },
          contents,
          generationConfig: {
            temperature: 0.6,
            maxOutputTokens: 100,
            thinkingConfig: {
              thinkingLevel: "MINIMAL"
            }
          }
        })
      },
      GEMINI_TIMEOUT_MS
    );

    if (!response.ok) {
      console.error("Gemini HTTP status:", response.status);

      if (response.status === 429) {
        return "Слишком много запросов к нейросети. Попробуйте позже.";
      }

      return "Нейросеть временно недоступна. Попробуйте ещё раз.";
    }

    const answer = data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    return answer
      ? cleanText(answer)
      : "Не удалось получить ответ. Попробуйте ещё раз.";
  } catch (error) {
    console.error("Gemini request error:", error?.name || "Error");

    return error?.name === "AbortError"
      ? "Запрос занял слишком много времени. Попробуйте ещё раз."
      : "Нейросеть временно недоступна. Попробуйте ещё раз.";
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return aliceResponse(
      res,
      "Я готова отвечать на вопросы. Спросите, что вас интересует."
    );
  }

  let body = req.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  if (!body || typeof body !== "object") body = {};

  const request = body.request || {};
  const userText = cleanText(
    request.original_utterance || request.command || ""
  );
  const history = getHistory(body);
  let searchEnabled = getSearchEnabled(body);

  if (!userText) {
    return aliceResponse(
      res,
      "Не расслышала вопрос. Повторите, пожалуйста.",
      history,
      searchEnabled
    );
  }

  const updatedHistory = [
    ...history,
    { role: "user", text: userText }
  ];

  if (/^(?:алиса[, ]*)?(?:выключи|отключи)\s+(?:умный\s+)?поиск[.! ]*$/i.test(userText)) {
    searchEnabled = false;
    const answer = "Поиск выключен. Буду отвечать без поиска в интернете.";

    return aliceResponse(res, answer, [
      ...updatedHistory,
      { role: "model", text: answer }
    ], searchEnabled);
  }

  if (/^(?:алиса[, ]*)?(?:включи|активируй)\s+(?:умный\s+)?поиск[.! ]*$/i.test(userText)) {
    searchEnabled = true;
    const answer = "Поиск включён.";

    return aliceResponse(res, answer, [
      ...updatedHistory,
      { role: "model", text: answer }
    ], searchEnabled);
  }

  try {
    if (searchEnabled && isSearchIntent(userText)) {
      const weather = isWeatherIntent(userText);
      const query = extractSearchQuery(userText);

      console.log("Search request:", query, "weather:", weather);

      const results = await searchWeb(query);

      if (!results) {
        const answer = "Не получилось получить данные из интернета. Попробуйте позже.";

        return aliceResponse(res, answer, [
          ...updatedHistory,
          { role: "model", text: answer }
        ], searchEnabled);
      }

      const summary = await summarizeSearch(userText, results, weather);

      const fallback = cleanText(
        results.map(item =>
          [item.title, item.snippet].filter(Boolean).join(". ")
        ).join(". "),
        MAX_TEXT
      );

      const answer = summary || (
        fallback
          ? `Не удалось подготовить краткую сводку. Вот найденные данные: ${fallback}`
          : "Не удалось подготовить ответ по результатам поиска."
      );

      return aliceResponse(res, answer, [
        ...updatedHistory,
        { role: "model", text: answer }
      ], searchEnabled);
    }

    const answer = await askGemini(userText, history);

    return aliceResponse(res, answer, [
      ...updatedHistory,
      { role: "model", text: answer }
    ], searchEnabled);
  } catch (error) {
    console.error(
      "Webhook error:",
      error?.name || "Error",
      cleanText(error?.message || "Unknown error", 200)
    );

    const answer = "Произошла временная ошибка. Попробуйте ещё раз.";

    return aliceResponse(res, answer, [
      ...updatedHistory,
      { role: "model", text: answer }
    ], searchEnabled);
  }
}
