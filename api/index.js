
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1000;
const MAX_ALICE_TEXT = 1024;

const GEMINI_TIMEOUT_MS = 3000;
const SERPER_TIMEOUT_MS = 2600;
const TOTAL_RESPONSE_BUDGET_MS = 3600;

const SYSTEM_PROMPT = [
  "Ты — дружелюбный русскоязычный голосовой помощник Алисы.",
  "Отвечай на русском языке, естественно, кратко и понятно для озвучивания.",
  "Если вопрос простой, отвечай прямо.",
  "Не выдумывай факты, цифры, даты или источники.",
  "Если не знаешь ответа, честно скажи об этом.",
  "Не утверждай, что проверил интернет, если поиск не выполнялся."
].join(" ");

const GENERIC_ERROR_TEXT =
  "Извини, сейчас не получилось получить ответ. Попробуй ещё раз.";

const SEARCH_ERROR_TEXT =
  "Сейчас не получилось получить свежие результаты поиска. Попробуй ещё раз чуть позже.";

function cleanText(value, maxLength = MAX_HISTORY_MESSAGE_CHARS) {
  if (typeof value !== "string") return "";

  return Array.from(
    value
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, " ")
      .trim()
  )
    .slice(0, maxLength)
    .join("");
}

function fitAliceText(value) {
  const text = cleanText(String(value || ""), MAX_ALICE_TEXT);
  return text || GENERIC_ERROR_TEXT;
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter((item) => item && typeof item.text === "string")
    .map((item) => ({
      role:
        item.role === "model" || item.role === "assistant"
          ? "model"
          : "user",
      text: cleanText(item.text)
    }))
    .filter((item) => item.text.length > 0)
    .slice(-MAX_HISTORY_MESSAGES);
}

function makeResponse(text, history, endSession = false) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: Boolean(endSession)
    },
    session_state: {
      history: normalizeHistory(history)
    }
  };
}

function getCommand(body) {
  const request =
    body && typeof body === "object" ? body.request : null;

  return cleanText(
    (request &&
      (request.command || request.original_utterance)) ||
      body?.command ||
      "",
    1500
  );
}

function getHistory(body) {
  const stateHistory = body?.state?.session?.history;
  const sessionStateHistory = body?.session_state?.history;

  return normalizeHistory(
    Array.isArray(stateHistory)
      ? stateHistory
      : sessionStateHistory
  );
}

function isSearchIntent(text) {
  const value = String(text || "").toLowerCase();

  return (
    /\b(найди|найти|поищи|поиск|загугли|что нового|последн\w*\s+новост\w*|свеж\w*\s+новост\w*|актуальн\w*|сейчас происходит|на сегодня|сегодняшн\w*|курс валют|погода сейчас|когда выйдет|последние обновления)\b/i.test(
      value
    ) ||
    /(новости|обновления).{0,35}(майнкрафт|minecraft|игр|технолог|компьютер|мир|росси)/i.test(
      value
    )
  );
}

function makeSearchQuery(text) {
  let query = cleanText(text, 300);

  query = query
    .replace(/^\s*(алиса[,:]?\s*)/i, "")
    .replace(
      /^\s*(найди|найти|поищи|загугли|посмотри|расскажи|скажи)\s+/i,
      ""
    )
    .replace(
      /^\s*(последние|свежие|актуальные)\s+новости\s*/i,
      "новости "
    );

  return cleanText(query, 300) || text;
}

function getRemainingMs(startTime) {
  return Math.max(
    0,
    TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startTime)
  );
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(100, timeoutMs)
  );

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const raw = await response.text();

    let data;

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      throw new Error(
        `Invalid JSON response (HTTP ${response.status})`
      );
    }

    if (!response.ok) {
      const error = new Error(`HTTP ${response.status}`);
      error.status = response.status;

      throw error;
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function searchWeb(query, timeoutMs) {
  const apiKey = process.env.SERPER_API_KEY;

  if (!apiKey) {
    console.warn(
      "Serper unavailable: SERPER_API_KEY is not configured."
    );

    return {
      ok: false,
      reason: "missing_key",
      results: [],
      answerBox: ""
    };
  }

  try {
    console.log("Starting Serper search.");

    const data = await fetchJson(
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
      timeoutMs
    );

    const results = Array.isArray(data.organic)
      ? data.organic.slice(0, 3).map((item) => ({
          title: cleanText(
            item.title || "Результат поиска",
            180
          ),
          snippet: cleanText(
            item.snippet || item.description || "",
            350
          ),
          link: cleanText(item.link || "", 300),
          date: cleanText(item.date || "", 80)
        }))
      : [];

    const answerBox =
      data.answerBox &&
      (data.answerBox.answer || data.answerBox.snippet)
        ? cleanText(
            data.answerBox.answer || data.answerBox.snippet,
            400
          )
        : "";

    console.log(`Serper results received: ${results.length}.`);

    return {
      ok: true,
      results,
      answerBox
    };
  } catch (error) {
    const isTimeout =
      error?.name === "AbortError" ||
      /abort|timeout/i.test(String(error?.message || ""));

    console.warn(
      `Serper search failed: ${
        isTimeout
          ? "timeout"
          : `request_error${error?.status ? `_${error.status}` : ""}`
      }.`
    );

    return {
      ok: false,
      reason: isTimeout ? "timeout" : "request_error",
      results: [],
      answerBox: ""
    };
  }
}

function formatSearchResults(searchData) {
  if (searchData?.answerBox) {
    const extra = (searchData.results || [])
      .slice(0, 2)
      .map((item) => {
        const summary = item.snippet
          ? ` ${item.snippet}`
          : "";

        return `${item.title}.${summary}`;
      });

    return fitAliceText(
      [searchData.answerBox, ...extra].join(" ")
    );
  }

  const results = Array.isArray(searchData?.results)
    ? searchData.results
    : [];

  if (results.length === 0) {
    return SEARCH_ERROR_TEXT;
  }

  const pieces = results.slice(0, 3).map((item, index) => {
    const date = item.date
      ? ` Дата: ${item.date}.`
      : "";

    const snippet = item.snippet
      ? ` ${item.snippet}`
      : " Подробности можно найти по заголовку.";

    let source = "";

    try {
      if (item.link) {
        source = ` Источник: ${new URL(item.link).hostname.replace(
          /^www\./,
          ""
        )}.`;
      }
    } catch {
      source = "";
    }

    return `${index + 1}. ${item.title}.${date}${snippet}${source}`;
  });

  return fitAliceText(
    `Вот что удалось найти в интернете. ${pieces.join(" ")}`
  );
}

async function askGemini(userText, history, timeoutMs) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error(
      "Gemini unavailable: GEMINI_API_KEY is not configured."
    );

    return {
      ok: false,
      reason: "missing_key",
      text: GENERIC_ERROR_TEXT
    };
  }

  const priorMessages = normalizeHistory(history).map(
    (item) => ({
      role: item.role === "model" ? "model" : "user",
      parts: [{ text: item.text }]
    })
  );

  const contents = [
    ...priorMessages,
    {
      role: "user",
      parts: [{ text: userText }]
    }
  ];

  try {
    const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;

    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(model)}:generateContent`;

    const data = await fetchJson(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }]
          },
          contents,
          generationConfig: {
            temperature: 0.5,
            maxOutputTokens: 180,
            thinkingConfig: {
              thinkingLevel: "MINIMAL"
            }
          }
        })
      },
      timeoutMs
    );

    const answer = (
      data?.candidates?.[0]?.content?.parts || []
    )
      .map((part) =>
        typeof part.text === "string" ? part.text : ""
      )
      .join(" ")
      .trim();

    if (!answer) {
      console.warn("Gemini returned no text candidate.");

      return {
        ok: false,
        reason: "empty_response",
        text: GENERIC_ERROR_TEXT
      };
    }

    return {
      ok: true,
      text: fitAliceText(answer)
    };
  } catch (error) {
    const isTimeout =
      error?.name === "AbortError" ||
      /abort|timeout/i.test(String(error?.message || ""));

    const reason = isTimeout
      ? "timeout"
      : error?.status === 429
        ? "quota"
        : "request_error";

    console.warn(
      `Gemini request failed: ${
        isTimeout
          ? "timeout"
          : `request_error${error?.status ? `_${error.status}` : ""}`
      }.`
    );

    return {
      ok: false,
      reason,
      text: GENERIC_ERROR_TEXT
    };
  }
}

function sendJson(res, payload) {
  if (
    typeof res.status === "function" &&
    typeof res.json === "function"
  ) {
    return res.status(200).json(payload);
  }

  res.statusCode = 200;
  res.setHeader(
    "Content-Type",
    "application/json; charset=utf-8"
  );

  return res.end(JSON.stringify(payload));
}

export default async function handler(req, res) {
  const startedAt = Date.now();

  try {
    if (req.method && req.method !== "POST") {
      return sendJson(
        res,
        makeResponse(
          "Отправь мне вопрос голосом или текстом.",
          []
        )
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

    const command = getCommand(body);
    const previousHistory = getHistory(body);

    if (!command) {
      return sendJson(
        res,
        makeResponse(
          "Я на связи. Что хочешь узнать?",
          previousHistory
        )
      );
    }

    const updatedHistory = [
      ...previousHistory,
      {
        role: "user",
        text: cleanText(command)
      }
    ].slice(-MAX_HISTORY_MESSAGES);

    // Актуальный поиск: один сетевой запрос к Serper.
    // Не ждём Gemini после поиска, чтобы уложиться
    // в короткий тайм-аут вебхука Алисы.
    if (isSearchIntent(command)) {
      const remaining = getRemainingMs(startedAt);

      if (remaining < 500) {
        const text = SEARCH_ERROR_TEXT;

        return sendJson(
          res,
          makeResponse(
            text,
            [
              ...updatedHistory,
              { role: "model", text }
            ].slice(-MAX_HISTORY_MESSAGES)
          )
        );
      }

      const query = makeSearchQuery(command);

      const search = await searchWeb(
        query,
        Math.min(
          SERPER_TIMEOUT_MS,
          Math.max(100, remaining - 250)
        )
      );

      const text = formatSearchResults(search);

      return sendJson(
        res,
        makeResponse(
          text,
          [
            ...updatedHistory,
            { role: "model", text }
          ].slice(-MAX_HISTORY_MESSAGES)
        )
      );
    }

    // Обычные вопросы обрабатывает Gemini.
    const remaining = getRemainingMs(startedAt);

    if (remaining < 300) {
      const text = GENERIC_ERROR_TEXT;

      return sendJson(
        res,
        makeResponse(
          text,
          [
            ...updatedHistory,
            { role: "model", text }
          ].slice(-MAX_HISTORY_MESSAGES)
        )
      );
    }

    const gemini = await askGemini(
      command,
      previousHistory,
      Math.min(
        GEMINI_TIMEOUT_MS,
        Math.max(100, remaining - 200)
      )
    );

    const text = gemini.ok
      ? gemini.text
      : GENERIC_ERROR_TEXT;

    return sendJson(
      res,
      makeResponse(
        text,
        [
          ...updatedHistory,
          { role: "model", text }
        ].slice(-MAX_HISTORY_MESSAGES)
      )
    );
  } catch (error) {
    console.error(
      "Alice webhook handler failed:",
      cleanText(error?.message || "unknown error", 200)
    );

    return sendJson(
      res,
      makeResponse(GENERIC_ERROR_TEXT, [])
    );
  }
}

export {
  fitAliceText,
  isSearchIntent,
  normalizeHistory,
  searchWeb,
  askGemini
};
