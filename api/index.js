
const MODEL = "gemini-3.5-flash-lite";

const GEMINI_TIMEOUT_MS = 2700;
const SERPER_TIMEOUT_MS = 1100;

const MAX_TEXT = 1024;
const MAX_HISTORY = 12;

const SYSTEM_INSTRUCTION = `
Ты — голосовой собеседник Алисы. Отвечай на русском языке
естественно, дружелюбно и кратко, как умная колонка.

Правила:
- На простой вопрос отвечай обычно одним-двумя предложениями.
- Не повторяй вопрос и не добавляй ненужные вступления.
- Не предлагай помощь в конце каждого ответа.
- Если просят подробности, объясняй подробнее.
- Учитывай историю разговора.
- Не выдумывай факты о пользователе.
- Не используй Markdown, таблицы и длинные списки без необходимости.
`.trim();

const SEARCH_SUMMARY_INSTRUCTION = `
Ты — голосовой новостной помощник Алисы.
Составь короткий, связный ответ на русском языке по предоставленным
результатам интернет-поиска.

Правила:
- Сначала ответь непосредственно на вопрос пользователя.
- Для новостей назови главные события и объясни, что произошло.
- Для спорта сообщи результат матча, команды и дату, если они есть
  в результатах.
- Для погоды назови населённый пункт, температуру и важные условия,
  если эти данные присутствуют в результатах.
- Для других вопросов дай короткую выжимку без лишних подробностей.
- Обычно достаточно двух-трёх предложений.
- Не перечисляй поисковые заголовки один за другим.
- Не выдумывай факты, цифры, результаты, даты и температуру.
- Если результаты противоречат друг другу или не дают ответа,
  честно сообщи об этом.
- Не говори, что у тебя нет доступа к интернету: тебе уже переданы
  результаты поиска.
- Не используй Markdown.
`.trim();

function cleanText(value, max = MAX_TEXT) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
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
      text: cleanText(item.text, 700)
    }));
}

function aliceResponse(res, text, history = []) {
  const safeText =
    cleanText(text) ||
    "Не получилось подготовить ответ. Попробуйте ещё раз.";

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

function isWeatherQuery(text) {
  return /\bпогод\w*\b|\bтемператур\w*\b|\bбудет ли дождь\b|\bидёт ли дождь\b|\bидет ли дождь\b|\bпрогноз погоды\b/i
    .test(text);
}

function isNewsQuery(text) {
  return /\bновост\w*\b|\bпоследн\w+\s+событ\w*\b|\bчто произошло\b|\bчто случилось\b|\bчто нового\b|\bсвеж\w+\s+новост\w*\b|\bновост\w+\s+про\b|\bновост\w+\s+о\b/i
    .test(text);
}

function isSportsQuery(text) {
  const sports =
    /\bфутбол\w*\b|\bматч\w*\b|\bхокке\w*\b|\bбаскетбол\w*\b|\bтеннис\w*\b|\bспорт\w*\b|\bчемпионат\w*\b|\bтурнир\w*\b|\bлига\b|\bлигу\b|\bкоманд\w*\b|\bигр\w*\b|\bсчёт\b|\bсчет\b|\bвыиграл\w*\b|\bпобедил\w*\b|\bрезультат\w*\b/i;

  const current =
    /\bпоследн\w*\b|\bсегодня\b|\bвчера\b|\bсейчас\b|\bкто выиграл\b|\bкто победил\b|\bрезультат\w*\b|\bсчёт\b|\bсчет\b|\bматч\b/i;

  return sports.test(text) && current.test(text);
}

function isCurrentInfoQuery(text) {
  return (
    isWeatherQuery(text) ||
    isNewsQuery(text) ||
    isSportsQuery(text) ||
    /\bкурс валют\b|\bкурс доллара\b|\bкурс евро\b|\bцена сегодня\b|\bактуальн\w*\b|\bв реальном времени\b|\bпоследн\w+\s+(?:верси\w*|данн\w*|результат\w*)\b/i
      .test(text)
  );
}

function makeSearchQuery(text, history = []) {
  const original = cleanText(text, 220);
  const lower = original.toLowerCase();

  if (isWeatherQuery(original)) {
    const placeMatch = original.match(
      /(?:погод\w*|температур\w*|дождь)\s+(?:в|во|на)\s+(.+)/i
    );

    const place = placeMatch
      ? cleanText(
          placeMatch[1]
            .replace(/\b(?:сегодня|завтра|сейчас|на неделю|на завтра)\b/gi, ""),
          100
        )
      : "";

    if (place) {
      return `Погода сейчас и сегодня в населённом пункте ${place}: текущая температура в градусах Цельсия, ощущается как, осадки, ветер. Указывай данные именно для ${place}.`;
    }

    return `Погода сейчас и сегодня: ${original}. Если населённый пункт не указан, не угадывай местоположение пользователя.`;
  }

  if (isNewsQuery(original)) {
    const topic = original
      .replace(/\b(?:расскажи|скажи|покажи|найди|поищи)\b/gi, "")
      .replace(/\b(?:последние|последние свежие|свежие|актуальные)\s+новости\b/gi, "")
      .replace(/\bновости\b/gi, "")
      .replace(/^\s*(?:про|о|об|по поводу)\s+/i, "")
      .trim();

    return topic
      ? `Самые свежие новости по теме "${topic}". Укажи дату публикации и главные события.`
      : `Самые свежие важные новости на сегодня. Укажи дату публикации и главные события.`;
  }

  if (isSportsQuery(original)) {
    return `Найди актуальный ответ на вопрос: "${original}". Используй самые свежие доступные результаты, даты и названия команд.`;
  }

  return original;
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
      SERPER_TIMEOUT_MS
    );

    if (!response.ok) {
      console.error("Serper HTTP status:", response.status);
      return null;
    }

    const results = [];

    if (data.answerBox?.answer) {
      results.push(
        `Прямой ответ: ${cleanText(data.answerBox.answer, 350)}`
      );
    } else if (data.answerBox?.snippet) {
      results.push(
        `Прямой ответ: ${cleanText(data.answerBox.snippet, 350)}`
      );
    }

    if (data.knowledgeGraph?.description) {
      results.push(
        `Описание: ${cleanText(data.knowledgeGraph.description, 250)}`
      );
    }

    const organic = Array.isArray(data.organic)
      ? data.organic
      : [];

    for (const item of organic.slice(0, 5)) {
      const title = cleanText(item?.title, 140);
      const snippet = cleanText(item?.snippet, 300);
      const date = cleanText(item?.date, 50);

      if (title || snippet) {
        results.push(
          [
            title ? `Источник: ${title}` : "",
            date ? `Дата: ${date}` : "",
            snippet ? `Содержание: ${snippet}` : ""
          ]
            .filter(Boolean)
            .join(". ")
        );
      }
    }

    if (!results.length) return null;

    return results.join("\n").slice(0, 3000);
  } catch (error) {
    console.error(
      "Serper error:",
      error?.name || "Error",
      cleanText(error?.message, 180)
    );
    return null;
  }
}

async function askGemini(userText, history = [], options = {}) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error("GEMINI_API_KEY is missing");
    return null;
  }

  const systemInstruction =
    options.systemInstruction || SYSTEM_INSTRUCTION;

  const contents = [
    ...history.map(item => ({
      role: item.role,
      parts: [{ text: item.text }]
    })),
    {
      role: "user",
      parts: [{ text: userText }]
    }
  ].slice(-10);

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
            maxOutputTokens: options.maxOutputTokens || 120,
            thinkingConfig: {
              thinkingLevel: "MINIMAL"
            }
          }
        })
      },
      options.timeoutMs || GEMINI_TIMEOUT_MS
    );

    if (!response.ok) {
      console.error(
        "Gemini HTTP status:",
        response.status,
        cleanText(data?.error?.message, 200)
      );
      return null;
    }

    const answer = data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    return answer ? cleanText(answer) : null;
  } catch (error) {
    console.error(
      "Gemini error:",
      error?.name || "Error",
      cleanText(error?.message, 180)
    );
    return null;
  }
}

function searchFallback(results, weather) {
  const text = cleanText(
    results
      .split("\n")
      .map(line =>
        line
          .replace(/^Источник:\s*/i, "")
          .replace(/^Содержание:\s*/i, "")
      )
      .filter(Boolean)
      .slice(0, 2)
      .join(". "),
    650
  );

  if (text) {
    return weather
      ? `Вот данные о погоде из поиска. ${text}`
      : `Вот что удалось найти. ${text}`;
  }

  return "Поиск не вернул достаточно данных. Попробуйте сформулировать вопрос иначе.";
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
  ].slice(-MAX_HISTORY);

  try {
    if (isCurrentInfoQuery(userText)) {
      const query = makeSearchQuery(userText, history);

      console.log("Search request:", query);

      const results = await searchWeb(query);

      if (!results) {
        const fallback =
          "Сейчас не удалось получить данные из интернета. Попробуйте ещё раз немного позже.";

        return aliceResponse(res, fallback, [
          ...updatedHistory,
          { role: "model", text: fallback }
        ]);
      }

      const prompt = `
Вопрос пользователя: ${userText}

Поисковый запрос: ${query}

Результаты интернет-поиска:
${results}

Составь короткий и понятный устный ответ на основе этих данных.
Не перечисляй заголовки подряд. Не добавляй сведения, которых нет
в результатах. Если найденные данные не позволяют ответить на вопрос,
скажи об этом прямо.
`.trim();

      // Сначала ищем данные, затем пробуем превратить их в связный ответ.
      // Если Gemini не успеет ответить, используем найденные сведения.
      const answer = await askGemini(prompt, [], {
        systemInstruction: SEARCH_SUMMARY_INSTRUCTION,
        timeoutMs: 2200,
        maxOutputTokens: 140
      });

      const finalAnswer =
        answer || searchFallback(results, isWeatherQuery(userText));

      return aliceResponse(res, finalAnswer, [
        ...updatedHistory,
        { role: "model", text: finalAnswer }
      ]);
    }

    const answer = await askGemini(userText, history);

    const finalAnswer =
      answer ||
      "Нейросеть временно не ответила. Попробуйте повторить вопрос.";

    return aliceResponse(res, finalAnswer, [
      ...updatedHistory,
      { role: "model", text: finalAnswer }
    ]);
  } catch (error) {
    console.error(
      "Webhook error:",
      error?.name || "Error",
      cleanText(error?.message || "Unknown error", 180)
    );

    const message =
      "Возникла временная ошибка. Попробуйте повторить вопрос.";

    return aliceResponse(res, message, [
      ...updatedHistory,
      { role: "model", text: message }
    ]);
  }
}
