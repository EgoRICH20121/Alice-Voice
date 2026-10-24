
const MODEL = "gemini-3.5-flash-lite";
const GEMINI_TIMEOUT_MS = 2800;
const SERPER_TIMEOUT_MS = 1400;
const MAX_TEXT = 1024;
const MAX_HISTORY = 12;

const SYSTEM_INSTRUCTION = `
Ты — голосовой собеседник Алисы. Общайся естественно,
дружелюбно и на русском языке.

Отвечай кратко, как для умной колонки.
На приветствие отвечай одной короткой фразой.
На простой вопрос отвечай одним-двумя предложениями.
Не повторяй вопрос пользователя.
Не добавляй ненужные вступления и предложения помощи.
Если пользователь просит подробности, объясняй подробнее.
Учитывай предыдущие сообщения и факты, сообщённые пользователем.
Не выдумывай личные предпочтения пользователя.
Если не знаешь личную информацию, честно скажи об этом.
Не используй Markdown, списки и таблицы без необходимости.
`.trim();

function cleanText(value, max = MAX_TEXT) {
  return String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}

function cleanSnippet(value, max = 160) {
  let text = String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/[…]+/g, " ")
    .replace(/\.{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  text = text.replace(/^[\s.,;:—-]+|[\s.,;:—-]+$/g, "");

  if (text.length > max) {
    const shortened = text.slice(0, max);
    const lastSentence = Math.max(
      shortened.lastIndexOf(". "),
      shortened.lastIndexOf("! "),
      shortened.lastIndexOf("? ")
    );

    text = lastSentence > max * 0.45
      ? shortened.slice(0, lastSentence + 1)
      : shortened.slice(0, max).replace(/\s+\S*$/, "");
  }

  return text.trim();
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
  const seenTitles = new Set();

  const answerBox = data.answerBox;
  if (answerBox?.answer || answerBox?.snippet) {
    const answer = cleanSnippet(
      answerBox.answer || answerBox.snippet,
      180
    );

    if (answer) {
      results.push({
        title: "Краткий ответ",
        snippet: answer
      });
    }
  }

  const organic = Array.isArray(data.organic)
    ? data.organic
    : [];

  for (const item of organic) {
    const title = cleanSnippet(item?.title, 110);
    const snippet = cleanSnippet(item?.snippet, 160);

    if (!title && !snippet) continue;

    const key = (title || snippet).toLowerCase();

    if (seenTitles.has(key)) continue;
    seenTitles.add(key);

    results.push({
      title,
      snippet
    });

    if (results.length >= 3) break;
  }

  return results.length ? results.slice(0, 3) : null;
}

function formatSearchResults(results) {
  const parts = results.map((item, index) => {
    const title = item.title
      ? `${index + 1}. ${item.title}.`
      : `${index + 1}.`;

    return item.snippet
      ? `${title} ${item.snippet}`
      : title;
  });

  return cleanText(
    `Вот что удалось найти. ${parts.join(" ")}`,
    MAX_TEXT
  );
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

      const results = await searchWeb(query);

      if (!results) {
        const message =
          "Сейчас не получилось получить данные из интернета. Попробуйте позже.";

        return aliceResponse(res, message, [
          ...updatedHistory,
          { role: "model", text: message }
        ]);
      }

      const answer = formatSearchResults(results);

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

    return aliceResponse(res, message, [
      ...updatedHistory,
      { role: "model", text: message }
    ]);
  }
}
