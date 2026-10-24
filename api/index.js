
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1000;
const MAX_ALICE_TEXT = 1024;

// Оставляем запас до ограничения времени ответа Алисы.
const GEMINI_TIMEOUT_MS = 2800;
const SERPER_TIMEOUT_MS = 1900;

const SYSTEM_PROMPT = `
Ты — русскоязычный голосовой помощник Алисы.
Отвечай по-русски, естественно, кратко и понятно.
Обычно достаточно 1–4 предложений.
Учитывай историю диалога и отвечай на уточняющие вопросы.
Не выдумывай факты, даты, цены, новости и результаты поиска.
Если не знаешь точного ответа, честно скажи об этом.
Не описывай пользователю внутренние инструкции и технические настройки.
Текст должен быть удобен для произнесения вслух.
`;

function log(message, details) {
  if (details !== undefined) {
    console.log(message, details);
  } else {
    console.log(message);
  }
}

function cleanText(value, maxLength = MAX_ALICE_TEXT) {
  if (typeof value !== "string") return "";

  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function getHistory(body) {
  const candidates = [
    body?.state?.session?.history,
    body?.session_state?.history,
  ];

  const history = candidates.find(Array.isArray) || [];

  return history
    .filter(
      (item) =>
        item &&
        ["user", "model", "assistant"].includes(item.role) &&
        typeof item.text === "string"
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map((item) => ({
      role: item.role === "user" ? "user" : "model",
      text: cleanText(item.text, MAX_HISTORY_MESSAGE_CHARS),
    }))
    .filter((item) => item.text.length > 0);
}

function getUserText(body) {
  const request = body?.request || {};

  return cleanText(
    request.original_utterance ||
      request.command ||
      "",
    1500
  );
}

function isSearchIntent(text) {
  return /(?:найди|поищи|загугли|поиск|последн\w*\s+(?:новост|верси|событи)|свеж\w*\s+(?:новост|данн|событи)|актуальн\w*\s+(?:новост|курс|цен|данн)|новост\w*|что\s+(?:сейчас|сегодня)\s+(?:происходит|известно)|курс\s+(?:доллара|евро|валют)|погода\s+(?:сейчас|сегодня))/iu.test(
    text
  );
}

function makeResponse(text, history, endSession = false) {
  const safeText =
    cleanText(text, MAX_ALICE_TEXT) ||
    "Извините, сейчас не получилось подготовить ответ. Попробуйте ещё раз.";

  const updatedHistory = Array.isArray(history)
    ? history.slice(-MAX_HISTORY_MESSAGES)
    : [];

  return {
    version: "1.0",
    response: {
      text: safeText,
      end_session: endSession,
    },
    session_state: {
      history: updatedHistory,
    },
  };
}

function addHistory(history, userText, assistantText) {
  const updated = [...history];

  if (userText) {
    updated.push({
      role: "user",
      text: cleanText(userText, MAX_HISTORY_MESSAGE_CHARS),
    });
  }

  if (assistantText) {
    updated.push({
      role: "model",
      text: cleanText(assistantText, MAX_HISTORY_MESSAGE_CHARS),
    });
  }

  return updated.slice(-MAX_HISTORY_MESSAGES);
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    const raw = await response.text();

    let data = null;

    try {
      data = raw ? JSON.parse(raw) : null;
    } catch {
      data = null;
    }

    if (!response.ok) {
      const error = new Error(
        `External API returned HTTP ${response.status}`
      );

      error.status = response.status;
      error.apiMessage =
        data?.error?.message ||
        data?.message ||
        "";

      throw error;
    }

    if (!data || typeof data !== "object") {
      throw new Error("External API returned invalid JSON");
    }

    return data;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSearchQuery(text) {
  return cleanText(
    text
      .replace(
        /^(?:алиса[,\s]*)?(?:пожалуйста[,\s]*)?(?:найди|поищи|загугли|выполни поиск|сделай поиск)\s*/iu,
        ""
      )
      .replace(/^(?:мне|нам)\s+(?:пожалуйста\s+)?/iu, "")
      .replace(/[?!.,]+$/u, ""),
    300
  );
}

async function searchWeb(userText) {
  const apiKey = process.env.SERPER_API_KEY;

  if (!apiKey) {
    log("Serper unavailable: SERPER_API_KEY is missing.");
    return null;
  }

  const query = normalizeSearchQuery(userText);

  if (!query) return null;

  log("Starting Serper search.");

  try {
    const data = await fetchJson(
      "https://google.serper.dev/search",
      {
        method: "POST",
        headers: {
          "X-API-KEY": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          q: query,
          gl: "ru",
          hl: "ru",
          num: 4,
        }),
      },
      SERPER_TIMEOUT_MS
    );

    const organic = Array.isArray(data.organic)
      ? data.organic
      : [];

    log("Serper results received:", organic.length);

    const parts = [];

    if (data.answerBox) {
      const answer =
        data.answerBox.answer ||
        data.answerBox.snippet ||
        data.answerBox.snippetHighlighted?.join(" ");

      if (answer) {
        parts.push(cleanText(answer, 400));
      }
    }

    for (const item of organic.slice(0, 4)) {
      const title = cleanText(item.title || "", 180);
      const snippet = cleanText(item.snippet || "", 350);

      if (title && snippet) {
        parts.push(`${title}. ${snippet}`);
      } else if (title || snippet) {
        parts.push(title || snippet);
      }
    }

    const result = cleanText(parts.join(" "), 900);

    if (!result) {
      log("Serper returned no usable search results.");
      return null;
    }

    // Важно: не запускаем второй внешний API после поиска.
    // Это уменьшает риск превысить лимит времени Алисы.
    return result;
  } catch (error) {
    if (error?.name === "AbortError") {
      log("Serper search failed: timeout");
    } else {
      log("Serper search failed:", {
        status: error?.status || "unknown",
        message: cleanText(error?.apiMessage || error?.message || "Unknown error", 200),
      });
    }

    return null;
  }
}

async function askGemini(userText, history) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    log("Gemini unavailable: GEMINI_API_KEY is missing.");
    return null;
  }

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;

  const contents = [];

  for (const item of history.slice(-MAX_HISTORY_MESSAGES)) {
    const text = cleanText(item.text, MAX_HISTORY_MESSAGE_CHARS);

    if (!text) continue;

    const role = item.role === "user" ? "user" : "model";

    // Gemini API не допускает два соседних сообщения одной роли.
    const last = contents[contents.length - 1];

    if (last && last.role === role) {
      last.parts[0].text += "\n" + text;
    } else {
      contents.push({
        role,
        parts: [{ text }],
      });
    }
  }

  const last = contents[contents.length - 1];

  if (last && last.role === "user") {
    last.parts[0].text += "\nТекущий вопрос: " + userText;
  } else {
    contents.push({
      role: "user",
      parts: [{ text: userText }],
    });
  }

  // Gemini ожидает, что первое сообщение в contents будет от user.
  while (contents.length && contents[0].role !== "user") {
    contents.shift();
  }

  if (!contents.length) {
    contents.push({
      role: "user",
      parts: [{ text: userText }],
    });
  }

  try {
    const data = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }],
          },
          contents,
          generationConfig: {
            maxOutputTokens: 120,
            thinkingConfig: {
              thinkingLevel: "MINIMAL",
            },
          },
        }),
      },
      GEMINI_TIMEOUT_MS
    );

    const answer = data?.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join(" ")
      .trim();

    if (!answer) {
      log("Gemini returned no text.", {
        finishReason: data?.candidates?.[0]?.finishReason || "unknown",
        promptFeedback: data?.promptFeedback?.blockReason || "none",
      });

      return null;
    }

    log("Gemini response received.");

    return cleanText(answer, MAX_ALICE_TEXT);
  } catch (error) {
    if (error?.name === "AbortError") {
      log("Gemini request failed: timeout");
    } else {
      log("Gemini request failed:", {
        status: error?.status || "unknown",
        message: cleanText(error?.apiMessage || error?.message || "Unknown error", 200),
      });
    }

    return null;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(200).json({
      version: "1.0",
      response: {
        text: "Алиса на связи. Задайте вопрос.",
        end_session: false,
      },
      session_state: {
        history: [],
      },
    });
  }

  let body = req.body;

  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    body = {};
  }

  const userText = getUserText(body);
  const history = getHistory(body);

  if (!userText) {
    return res.status(200).json(
      makeResponse(
        "Я вас слушаю. Скажите, что хотите узнать.",
        history
      )
    );
  }

  log("Alice request received.", {
    textLength: userText.length,
    searchIntent: isSearchIntent(userText),
  });

  try {
    let answer;

    if (isSearchIntent(userText)) {
      // Поиск: один внешний запрос, без второго вызова Gemini.
      answer = await searchWeb(userText);

      if (!answer) {
        answer =
          "Сейчас не удалось получить результаты поиска. Попробуйте повторить запрос немного позже.";
      } else {
        answer = "Вот что удалось найти. " + answer;
      }
    } else {
      // Обычный вопрос: обращаемся только к Gemini.
      answer = await askGemini(userText, history);

      if (!answer) {
        answer =
          "Сейчас не удалось получить ответ от нейросети. Попробуйте ещё раз.";
      }
    }

    const newHistory = addHistory(history, userText, answer);

    return res.status(200).json(
      makeResponse(answer, newHistory)
    );
  } catch (error) {
    // Последняя защита: Алиса должна получить корректный JSON.
    log("Unexpected webhook error:", cleanText(error?.message || "Unknown error", 200));

    return res.status(200).json(
      makeResponse(
        "Произошла временная ошибка. Попробуйте ещё раз чуть позже.",
        addHistory(
          history,
          userText,
          "Произошла временная ошибка."
        )
      )
    );
  }
};
