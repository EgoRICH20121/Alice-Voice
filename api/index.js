
const MODEL = "gemini-3.5-flash-lite";

const TOTAL_BUDGET_MS = 3900;
const GEMINI_TIMEOUT_MS = 3400;
const SERPER_TIMEOUT_MS = 1200;

const MAX_TEXT = 1024;
const MAX_HISTORY = 12;

const SYSTEM_INSTRUCTION = `
Ты — голосовой собеседник Алисы. Отвечай на русском языке
естественно, дружелюбно и кратко, как умная колонка.

Правила:
- На простые вопросы отвечай обычно одним-двумя предложениями.
- Не повторяй вопрос пользователя.
- Не добавляй вступления и предложения помощи без необходимости.
- Учитывай историю разговора.
- Не выдумывай факты, даты, цены, погоду и личную информацию.
- Если не знаешь ответа, честно скажи об этом.
- Если просят подробности, отвечай подробнее.
- Не используй Markdown, таблицы и списки без необходимости.
`.trim();

const SEARCH_SYSTEM_INSTRUCTION = `
Ты — редактор ответов голосового помощника Алисы.
Твоя задача — составить короткий, связный и полезный ответ
на основе предоставленных результатов интернет-поиска.

Правила:
- Отвечай по-русски, естественно, как для умной колонки.
- Не перечисляй подряд заголовки сайтов.
- Объединяй совпадающую информацию и выделяй главное.
- Новости: сообщи, что произошло, суть события и дату,
  только если дата подтверждается результатами.
- Погода: отвечай только для запрошенного населённого пункта.
  Назови температуру и прогноз, только если они есть в источниках.
  Не подменяй населённый пункт соседним городом или регионом.
- Не придумывай температуру, даты, события и цифры.
- Если источники противоречат друг другу или данных мало,
  прямо обозначь это.
- Не называй информацию последней, если результаты этого не подтверждают.
- Обычно отвечай в 1–3 коротких предложениях.
- Не добавляй ненужных вступлений, ссылок и предложений помощи.
`.trim();

function cleanText(value, max = MAX_TEXT) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function getRemainingTime(deadline) {
  return Math.max(0, deadline - Date.now());
}

function getHistory(body, currentText = "") {
  const candidates = [
    body?.state?.session?.history,
    body?.session_state?.history
  ];

  let history = candidates.find(Array.isArray) || [];

  history = history
    .filter(item =>
      item &&
      (item.role === "user" || item.role === "model") &&
      typeof item.text === "string"
    )
    .map(item => ({
      role: item.role,
      text: cleanText(item.text, 700)
    }))
    .filter(item => item.text);

  // Не добавляем текущее сообщение повторно,
  // если платформа уже включила его в историю.
  if (
    history.length &&
    history[history.length - 1].role === "user" &&
    history[history.length - 1].text === currentText
  ) {
    history.pop();
  }

  // Объединяем подряд идущие сообщения одной роли.
  const normalized = [];

  for (const item of history) {
    const last = normalized[normalized.length - 1];

    if (last && last.role === item.role) {
      last.text = cleanText(`${last.text}. ${item.text}`, 1000);
    } else {
      normalized.push({ ...item });
    }
  }

  return normalized.slice(-MAX_HISTORY);
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

function isWeatherIntent(text) {
  return /\b(погод\w*|температур\w*|осадк\w*|дожд\w*|снег\w*|ветер\w*|прогноз погоды)\b/i
    .test(text);
}

function isNewsIntent(text) {
  return /\b(новост\w*|последн\w*|свеж\w*|сегодняшн\w*|что случил\w*|что произошло|последние события|нового в)\b/i
    .test(text);
}

function isExplicitSearchIntent(text) {
  return /\b(найди|найти|поищи|поиск|в интернете|проверь в интернете|посмотри в интернете)\b/i
    .test(text);
}

function isSearchIntent(text) {
  return (
    isWeatherIntent(text) ||
    isNewsIntent(text) ||
    isExplicitSearchIntent(text)
  );
}

function extractSearchQuery(text) {
  return cleanText(
    text.replace(
      /^(?:алиса[\s,]*)?(?:найди|найти|поищи|поиск|посмотри|проверь|расскажи|скажи|покажи)\s*/i,
      ""
    ),
    180
  ) || cleanText(text, 180);
}

async function fetchJsonWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(100, timeoutMs)
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

async function searchWeb(query, deadline) {
  const apiKey = process.env.SERPER_API_KEY;

  if (!apiKey) {
    console.error("SERPER_API_KEY is missing");
    return null;
  }

  // Оставляем время для краткого пересказа и ответа Алисе.
  const remaining = getRemainingTime(deadline);
  const timeout = Math.min(
    SERPER_TIMEOUT_MS,
    remaining - 1800
  );

  if (timeout < 300) {
    console.error("Not enough time to start web search");
    return null;
  }

  try {
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
      timeout
    );

    if (!response.ok) {
      console.error("Serper HTTP status:", response.status);
      return null;
    }

    const results = [];

    if (data.answerBox?.answer) {
      results.push({
        title: "Краткий ответ",
        snippet: cleanText(data.answerBox.answer, 350)
      });
    } else if (data.answerBox?.snippet) {
      results.push({
        title: "Краткий ответ",
        snippet: cleanText(data.answerBox.snippet, 350)
      });
    }

    const organic = Array.isArray(data.organic)
      ? data.organic
      : [];

    for (const item of organic.slice(0, 5)) {
      const title = cleanText(item?.title, 150);
      const snippet = cleanText(item?.snippet, 300);

      if (!title && !snippet) continue;

      results.push({
        title,
        snippet
      });
    }

    return results.length ? results : null;
  } catch (error) {
    console.error(
      "Search error:",
      error?.name || "Error",
      cleanText(error?.message, 180)
    );

    return null;
  }
}

async function callGemini(contents, systemInstruction, timeoutMs) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error("GEMINI_API_KEY is missing");
    return { answer: null, reason: "missing_key" };
  }

  if (timeoutMs < 300) {
    return { answer: null, reason: "insufficient_time" };
  }

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
            parts: [{ text: systemInstruction }]
          },
          contents,
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 120,
            thinkingConfig: {
              thinkingLevel: "MINIMAL"
            }
          }
        })
      },
      timeoutMs
    );

    if (!response.ok) {
      console.error(
        "Gemini HTTP status:",
        response.status,
        cleanText(data?.error?.message, 200)
      );

      return {
        answer: null,
        reason: `http_${response.status}`
      };
    }

    const parts = data?.candidates?.[0]?.content?.parts;
    const answer = Array.isArray(parts)
      ? parts.map(part => part.text || "").join("").trim()
      : "";

    if (!answer) {
      console.error(
        "Gemini returned no text:",
        data?.candidates?.[0]?.finishReason || "unknown"
      );

      return { answer: null, reason: "empty_answer" };
    }

    return {
      answer: cleanText(answer),
      reason: null
    };
  } catch (error) {
    console.error(
      "Gemini request error:",
      error?.name || "Error",
      cleanText(error?.message, 180)
    );

    return {
      answer: null,
      reason: error?.name === "AbortError" ? "timeout" : "network_error"
    };
  }
}

async function askGemini(userText, history, deadline) {
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

  const timeout = Math.min(
    GEMINI_TIMEOUT_MS,
    getRemainingTime(deadline) - 350
  );

  const result = await callGemini(
    contents,
    SYSTEM_INSTRUCTION,
    timeout
  );

  if (result.answer) return result.answer;

  if (result.reason === "http_429") {
    return "Сейчас слишком много запросов. Попробуйте немного позже.";
  }

  return "Нейросеть сейчас не успела ответить. Попробуйте ещё раз.";
}

function fallbackSearchAnswer(results, weather) {
  if (!results?.length) {
    return "Сейчас не удалось получить данные из интернета. Попробуйте немного позже.";
  }

  const useful = results
    .filter(item => item.snippet)
    .slice(0, 2)
    .map(item => item.snippet);

  if (!useful.length) {
    return "Поиск не нашёл достаточно информации для ответа.";
  }

  // Запасной ответ, если Gemini не успел сделать выжимку.
  // Это лучше, чем выдавать длинный список заголовков.
  const answer = cleanText(useful.join(". "), 650);

  return weather
    ? `По найденному прогнозу: ${answer}`
    : `Кратко по найденным материалам: ${answer}`;
}

async function summarizeSearch(query, results, history, deadline, weather) {
  const searchContext = results
    .map((item, index) =>
      `${index + 1}. ${item.title}\n${item.snippet}`
    )
    .join("\n\n")
    .slice(0, 3200);

  const prompt = `
Запрос пользователя: ${query}

${weather
  ? "Это запрос о погоде. Укажи только данные для запрошенного населённого пункта. Если населённый пункт не указан или температура не найдена, не придумывай их."
  : "Составь короткую выжимку по найденным материалам. Не выдавай список заголовков вместо ответа."}

Результаты поиска:
${searchContext}

Сформулируй итоговый ответ для голосового помощника.
`.trim();

  // Для поиска берём только несколько последних сообщений:
  // контекст не должен вытеснять свежие результаты.
  const recentHistory = history.slice(-4);

  const contents = [
    ...recentHistory.map(item => ({
      role: item.role,
      parts: [{ text: item.text }]
    })),
    {
      role: "user",
      parts: [{ text: prompt }]
    }
  ].slice(-6);

  const timeout = Math.min(
    2500,
    getRemainingTime(deadline) - 350
  );

  const result = await callGemini(
    contents,
    SEARCH_SYSTEM_INSTRUCTION,
    timeout
  );

  return result.answer || fallbackSearchAnswer(results, weather);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  // Общий бюджет меньше лимита Яндекса:
  // часть времени нужна на передачу ответа платформе.
  const deadline = Date.now() + TOTAL_BUDGET_MS;

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

  const history = getHistory(body, userText);

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
  ].slice(-MAX_HISTORY);

  try {
    if (isSearchIntent(userText)) {
      const query = extractSearchQuery(userText);
      const weather = isWeatherIntent(userText);

      console.log("Search request:", query);

      const results = await searchWeb(query, deadline);

      if (!results) {
        const message = weather
          ? "Не удалось получить прогноз погоды. Попробуйте ещё раз позже."
          : "Сейчас не удалось найти информацию в интернете. Попробуйте ещё раз позже.";

        return aliceResponse(res, message, updatedHistory);
      }

      const answer = await summarizeSearch(
        query,
        results,
        history,
        deadline,
        weather
      );

      return aliceResponse(res, answer, [
        ...updatedHistory,
        { role: "model", text: answer }
      ].slice(-MAX_HISTORY));
    }

    const answer = await askGemini(
      userText,
      history,
      deadline
    );

    return aliceResponse(res, answer, [
      ...updatedHistory,
      { role: "model", text: answer }
    ].slice(-MAX_HISTORY));
  } catch (error) {
    console.error(
      "Webhook error:",
      error?.name || "Error",
      cleanText(error?.message || "Unknown error", 180)
    );

    return aliceResponse(
      res,
      "Произошла временная ошибка. Попробуйте ещё раз.",
      updatedHistory
    );
  }
}
