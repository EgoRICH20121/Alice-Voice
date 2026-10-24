
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;

const TOTAL_RESPONSE_BUDGET_MS = 4200;
const SERPER_TIMEOUT_MS = 1400;
const GEMINI_TIMEOUT_MS = 3800;

const SYSTEM_PROMPT = [
  "Ты — полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и понятно.",
  "Обычно используй 1–3 коротких предложения.",
  "Не используй Markdown, таблицы и длинные вступления.",
  "Для актуальных данных опирайся на результаты поиска, если они переданы.",
  "Если актуальные данные не удалось проверить через поиск, честно сообщи об этом.",
  "Не выдумывай новости, даты, цены и другие факты."
].join(" ");

function aliceResponse(text, endSession = false, history = []) {
  return {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: { history }
  };
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) {
    return text || "Не удалось подготовить ответ.";
  }

  const candidate = text.slice(0, MAX_ALICE_TEXT - 1);
  const sentenceEnd = Math.max(
    candidate.lastIndexOf(". "),
    candidate.lastIndexOf("! "),
    candidate.lastIndexOf("? ")
  );

  if (sentenceEnd >= 300) {
    return candidate.slice(0, sentenceEnd + 1).trim();
  }

  const lastSpace = candidate.lastIndexOf(" ");
  return (
    lastSpace > 200 ? candidate.slice(0, lastSpace) : candidate
  ).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) return [];

  return history
    .filter(
      item =>
        item &&
        (item.role === "user" || item.role === "model") &&
        typeof item.text === "string"
    )
    .slice(-MAX_HISTORY_MESSAGES)
    .map(item => ({
      role: item.role,
      text: item.text.slice(0, MAX_HISTORY_MESSAGE_CHARS)
    }));
}

async function fetchJson(url, options, timeoutMs) {
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

    const data = await response.json().catch(() => ({}));
    return { response, data };
  } finally {
    clearTimeout(timer);
  }
}

function isAbortError(error) {
  return (
    error?.name === "AbortError" ||
    /aborted|aborterror|operation was aborted/i.test(
      String(error?.message || "")
    )
  );
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;

  if (!key || timeoutMs < 200) return "";

  try {
    console.log("Starting Serper search.");

    const { response, data } = await fetchJson(
      "https://google.serper.dev/search",
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
          num: 3
        })
      },
      timeoutMs
    );

    if (!response.ok) {
      console.warn("Serper HTTP status:", response.status);
      return "";
    }

    const items = (Array.isArray(data.organic) ? data.organic : [])
      .slice(0, 3)
      .map((item, index) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);

        return `${index + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox = data.answerBox?.answer || data.answerBox?.snippet;

    if (answerBox) {
      items.unshift(
        `Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`
      );
    }

    console.log("Serper results received:", items.length);
    return items.join("\n");
  } catch (error) {
    console.warn(
      "Serper search failed:",
      isAbortError(error) ? "timeout" : String(error?.message || "unknown")
    );
    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) throw new Error("MISSING_GEMINI_KEY");
  if (timeoutMs < 250) throw new Error("TIME_BUDGET_EXHAUSTED");

  const model = String(
    process.env.GEMINI_MODEL || DEFAULT_MODEL
  ).trim();

  if (!/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new Error("INVALID_MODEL_NAME");
  }

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  let prompt = text;

  if (searchContext) {
    prompt +=
      "\n\nАктуальные результаты интернет-поиска:\n" +
      searchContext +
      "\nОтветь на вопрос на основе этих результатов. Не добавляй неподтверждённые сведения.";
  } else if (isSearchIntent(text)) {
    prompt +=
      "\n\nАктуальные результаты поиска не получены. Не утверждай, что проверил интернет, и не выдумывай свежие новости или данные.";
  }

  contents.push({
    role: "user",
    parts: [{ text: prompt }]
  });

  let result;

  try {
    result = await fetchJson(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }]
          },
          contents,
          generationConfig: {
            maxOutputTokens: 160,
            thinkingConfig: {
              thinkingLevel: "MINIMAL"
            }
          }
        })
      },
      Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
    );
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error("TIME_BUDGET_EXHAUSTED");
    }

    console.error("Gemini network error:", error?.message || "unknown");
    throw new Error("GEMINI_NETWORK_ERROR");
  }

  const { response, data } = result;

  if (!response.ok) {
    console.error("Gemini HTTP status:", response.status);

    if (response.status === 400) throw new Error("GEMINI_BAD_REQUEST");
    if (response.status === 401 || response.status === 403) {
      throw new Error("GEMINI_KEY_REJECTED");
    }
    if (response.status === 429) throw new Error("GEMINI_QUOTA");

    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];
  const answer = (candidate?.content?.parts || [])
    .map(part => typeof part.text === "string" ? part.text : "")
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) {
      throw new Error("GEMINI_BLOCKED");
    }

    throw new Error("GEMINI_EMPTY_RESPONSE");
  }

  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер не настроен. Проверьте GEMINI_API_KEY в Vercel.";

    case "GEMINI_KEY_REJECTED":
      return "Не удалось авторизоваться в Gemini. Проверьте API-ключ.";

    case "GEMINI_QUOTA":
      return "Достигнут лимит запросов Gemini. Попробуйте позже.";

    case "GEMINI_BAD_REQUEST":
      return "Gemini отклонила запрос. Попробуйте задать вопрос иначе.";

    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";

    case "GEMINI_NETWORK_ERROR":
    case "TIME_BUDGET_EXHAUSTED":
      return "Нейросеть отвечает слишком медленно. Попробуйте ещё раз.";

    case "GEMINI_EMPTY_RESPONSE":
      return "Нейросеть не вернула ответ. Попробуйте спросить иначе.";

    default:
      return "Не получилось получить ответ от нейросети. Попробуйте позже.";
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready."
    });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const startedAt = Date.now();
  const remainingMs = () =>
    TOTAL_RESPONSE_BUDGET_MS - (Date.now() - startedAt);

  const body =
    req.body && typeof req.body === "object" ? req.body : {};

  const text = String(
    body?.request?.command ||
    body?.request?.original_utterance ||
    ""
  ).trim();

  const oldHistory = safeHistory(body?.state?.session?.history);

  if (!text) {
    return res.status(200).json(
      aliceResponse(
        "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
        false,
        oldHistory
      )
    );
  }

  try {
    let searchContext = "";

    if (
      isSearchIntent(text) &&
      process.env.SERPER_API_KEY &&
      remainingMs() > 3000
    ) {
      const searchTimeout = Math.min(
        SERPER_TIMEOUT_MS,
        remainingMs() - 2600
      );

      searchContext = await searchWeb(text, searchTimeout);
    }

    const geminiTimeout = Math.min(
      GEMINI_TIMEOUT_MS,
      remainingMs() - 150
    );

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      geminiTimeout
    );

    const history = [
      ...oldHistory,
      {
        role: "user",
        text: text.slice(0, MAX_HISTORY_MESSAGE_CHARS)
      },
      {
        role: "model",
        text: answer.slice(0, MAX_HISTORY_MESSAGE_CHARS)
      }
    ].slice(-MAX_HISTORY_MESSAGES);

    return res.status(200).json(
      aliceResponse(answer, false, history)
    );
  } catch (error) {
    console.warn(
      "Alice webhook fallback:",
      error?.message || "unknown error"
    );

    return res.status(200).json(
      aliceResponse(errorForUser(error), false, oldHistory)
    );
  }
}

export {
  aliceResponse,
  fitAliceText,
  isSearchIntent,
  safeHistory
};
