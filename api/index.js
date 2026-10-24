
const MODEL = "gemini-3.5-flash-lite";
const GEMINI_TIMEOUT_MS = 4600;
const SERPER_TIMEOUT_MS = 2800;
const MAX_TEXT = 1024;
const MAX_HISTORY = 6;

const SYSTEM_INSTRUCTION = `
Ты — голосовой помощник Алисы, отвечай на русском языке.
Отвечай естественно, понятно и преимущественно кратко.
Учитывай контекст предыдущих сообщений.
Не выдумывай факты, результаты поиска или новости.
Если не знаешь ответа, честно скажи об этом.
Не используй Markdown-таблицы и сложное форматирование:
твой ответ будет озвучен голосом.
`.trim();

function cleanText(value, max = MAX_TEXT) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function getHistory(body) {
  const history =
    body?.state?.session?.history ??
    body?.session_state?.history ??
    [];

  if (!Array.isArray(history)) return [];

  return history
    .filter(
      item =>
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

function aliceResponse(res, text, history = []) {
  const safeText =
    cleanText(text) ||
    "Не удалось подготовить ответ. Попробуйте ещё раз.";

  return res.status(200).json({
    version: "1.0",
    response: {
      text: safeText,
      end_session: false
    },
    session_state: {
      history: history.slice(-MAX_HISTORY)
    }
  });
}

function isSearchIntent(text) {
  return (
    /(найди|найти|поищи|поиск|последн\w*|новост\w*|свеж\w*|актуальн\w*|что случил\w*|сегодняшн\w*|курс валют|погод\w*|в интернете)/i
      .test(text)
  );
}

function extractSearchQuery(text) {
  return cleanText(
    text.replace(
      /^(?:алиса[, ]*)?(?:найди|найти|поищи|поиск|скажи|расскажи|покажи)\s*/i,
      ""
    ),
    180
  ) || cleanText(text, 180);
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

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
        num: 3
      })
    },
    SERPER_TIMEOUT_MS
  );

  if (!response.ok) {
    console.error("Serper HTTP status:", response.status);
    return null;
  }

  const results = [];

  if (data.answerBox?.answer) {
    results.push(cleanText(data.answerBox.answer, 250));
  } else if (data.answerBox?.snippet) {
    results.push(cleanText(data.answerBox.snippet, 250));
  }

  const organic = Array.isArray(data.organic)
    ? data.organic
    : [];

  for (const item of organic.slice(0, 3)) {
    const title = cleanText(item?.title, 140);
    const snippet = cleanText(item?.snippet, 240);

    if (title || snippet) {
      results.push(
        title && snippet
          ? `${title}. ${snippet}`
          : title || snippet
      );
    }
  }

  return results.length
    ? results.join(". ").slice(0, 850)
    : null;
}

async function askGemini(userText, history) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error("GEMINI_API_KEY is missing");
    return "Нейросеть пока не настроена. Проверьте ключ Gemini в настройках Vercel.";
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
          maxOutputTokens: 160,
          thinkingConfig: {
            thinkingLevel: "MINIMAL"
          }
        }
      })
    },
    GEMINI_TIMEOUT_MS
  );

  if (!response.ok) {
    console.error(
      "Gemini HTTP status:",
      response.status,
      cleanText(data?.error?.message, 250)
    );

    if (response.status === 429) {
      return "Слишком много запросов к нейросети. Попробуйте немного позже.";
    }

    return "Нейросеть временно недоступна. Попробуйте ещё раз.";
  }

  const answer = data?.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("")
    .trim();

  if (!answer) {
    console.error("Gemini returned no text");
    return "Не удалось получить ответ. Попробуйте задать вопрос иначе.";
  }

  return cleanText(answer);
}

// ВАЖНО: проект использует ES Modules, поэтому нужен export default.
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

  if (!body || typeof body !== "object") {
    body = {};
  }

  const request = body.request || {};
  const userText = cleanText(
    request.original_utterance || request.command || ""
  );
  const history = getHistory(body);

  if (!userText) {
    return aliceResponse(
      res,
      "Не расслышала вопрос. Повторите, пожалуйста.",
      history
    );
  }

  const updatedHistory = [
    ...history,
    { role: "user", text: userText }
  ];

  try {
    if (isSearchIntent(userText)) {
      const query = extractSearchQuery(userText);
      console.log("Search request:", query);

      // Поиск отвечает напрямую — без второго медленного запроса к Gemini.
      const results = await searchWeb(query);

      if (!results) {
        return aliceResponse(
          res,
          "Сейчас не получилось получить данные из интернета. Попробуйте ещё раз позже.",
          updatedHistory
        );
      }

      const answer = cleanText(
        `Вот что удалось найти. ${results}`,
        MAX_TEXT
      );

      return aliceResponse(res, answer, [
        ...updatedHistory,
        { role: "model", text: answer }
      ]);
    }

    const answer = await askGemini(userText, history);

    return aliceResponse(res, answer, [
      ...updatedHistory,
      { role: "model", text: answer }
    ]);
  } catch (error) {
    console.error(
      "Webhook error:",
      error?.name || "Error",
      cleanText(error?.message || "Unknown error", 200)
    );

    const message =
      error?.name === "AbortError"
        ? "Запрос занял слишком много времени. Попробуйте ещё раз."
        : "Произошла временная ошибка. Попробуйте ещё раз.";

    return aliceResponse(res, message, updatedHistory);
  }
}
