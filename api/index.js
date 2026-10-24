const MODEL = "gemini-3.5-flash-lite";

const TOTAL_BUDGET_MS = 4100;
const SERPER_TIMEOUT_MS = 1000;
const GEMINI_TIMEOUT_MS = 2800;

const MAX_TEXT = 1024;
const MAX_HISTORY = 12;

const SYSTEM_INSTRUCTION = `
Ты — голосовой помощник Алисы. Говори по-русски, естественно,
дружелюбно и кратко, как умная колонка.

Правила:
- На простые вопросы отвечай обычно одним-двумя предложениями.
- На приветствие отвечай коротко.
- Не повторяй вопрос пользователя.
- Не добавляй вступления и предложения помощи без необходимости.
- Для сравнений называй главное отличие и практический вывод.
- Если пользователь просит подробности, объясняй подробнее.
- Учитывай историю разговора, но не выдумывай факты.
- Не используй Markdown, таблицы и сложные списки.
- Для новостей указывай главное событие и его значение.
- Не выдавай старые сведения за последние новости.
- Если данных недостаточно, честно сообщи об этом.
`.trim();

const SEARCH_INSTRUCTION = `
Ты готовишь короткий устный ответ для умной колонки Алисы.
Используй предоставленные результаты поиска, а не свои догадки.

Правила:
- Отвечай по-русски, связно и естественно.
- Не зачитывай результаты поиска по номерам и не перечисляй
  подряд названия сайтов.
- Объедини информацию в короткую выжимку с главным смыслом.
- Для новостей назови 1–3 важных события и объясни, что произошло.
- Не называй новость последней, если дата или актуальность не подтверждена.
- Для погоды сообщи именно запрошенный населённый пункт,
  температуру, ощущения или осадки, если они есть в результатах.
- Не подменяй погоду в указанном населённом пункте погодой в регионе.
- Для спортивных результатов назови матч, участников и результат,
  только если эти сведения присутствуют в источниках.
- Не придумывай температуру, даты, результаты, цены и факты.
- Если результаты не позволяют уверенно ответить, скажи об этом.
- Обычно достаточно 1–3 коротких предложений.
- Не используй Markdown, нумерацию и вступления.
`.trim();

function cleanText(value, max = MAX_TEXT) {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function getRemainingTime(startTime) {
  return Math.max(
    0,
    TOTAL_BUDGET_MS - (Date.now() - startTime)
  );
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
        typeof item.text === "string" &&
        item.text.trim()
    )
    .slice(-MAX_HISTORY)
    .map(item => ({
      role: item.role,
      text: cleanText(item.text, 800)
    }));
}

function fitMemoryFacts(facts) {
  const result = [];

  for (const value of facts.slice(-12)) {
    const fact = cleanText(value, 120);
    if (!fact) continue;

    const candidate = [...result, fact];

    // Храним запас до лимита Яндекс Диалогов в 1 КБ.
    if (
      Buffer.byteLength(
        JSON.stringify({ memory: { facts: candidate } }),
        "utf8"
      ) > 850
    ) {
      continue;
    }

    result.push(fact);
  }

  return result;
}

function getUserMemory(body) {
  const facts = body?.state?.user?.memory?.facts;

  if (!Array.isArray(facts)) return [];

  return fitMemoryFacts(
    facts.filter(
      item => typeof item === "string" && item.trim()
    )
  );
}

function getMemoryCommand(text) {
  const remember = text.match(
    /^(?:алиса[, ]*)?(?:запомни|запомни пожалуйста)\s*(?:,?\s*что\s*)?(.+)$/i
  );

  if (remember) {
    const fact = cleanText(
      remember[1].replace(/[.!?]+$/, ""),
      120
    );

    if (fact && !/^(это|всё|ничего)$/i.test(fact)) {
      return { type: "remember", fact };
    }
  }

  const forget = text.match(
    /^(?:алиса[, ]*)?(?:забудь|удали из памяти|не запоминай)\s*(?:,?\s*)?(.*)$/i
  );

  if (forget) {
    return {
      type: "forget",
      target: cleanText(
        forget[1].replace(/[.!?]+$/, ""),
        180
      )
    };
  }

  return null;
}

function normalizeFact(value) {
  return cleanText(value, 180)
    .toLocaleLowerCase("ru-RU")
    .replace(/[.,!?;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function memoryCommandResult(command, memory) {
  if (command.type === "remember") {
    const normalized = normalizeFact(command.fact);

    const facts = memory.filter(
      item => normalizeFact(item) !== normalized
    );

    facts.push(command.fact);

    return {
      facts: fitMemoryFacts(facts),
      answer: `Хорошо, запомнила: ${command.fact}.`,
      changed: true
    };
  }

  if (!command.target) {
    return {
      facts: memory,
      answer: memory.length
        ? `Я помню: ${memory.join("; ")}. Чтобы удалить факт, скажи, что именно забыть.`
        : "Пока у меня нет сохранённых фактов.",
      changed: false
    };
  }

  const target = normalizeFact(command.target);
  const targetWords = target
    .split(" ")
    .filter(word => word.length > 2);

  const kept = memory.filter(fact => {
    const normalized = normalizeFact(fact);

    return !(
      normalized.includes(target) ||
      target.includes(normalized) ||
      (
        targetWords.length > 0 &&
        targetWords.every(
          word => normalized.includes(word)
        )
      )
    );
  });

  const changed = kept.length !== memory.length;

  return {
    facts: fitMemoryFacts(kept),
    answer: changed
      ? "Хорошо, удалила это из памяти."
      : "Не нашла такой факт в сохранённой памяти.",
    changed
  };
}

function buildHistory(history, userText, answer) {
  const result = [...history];

  // Не добавляем запрос повторно, если он уже есть в истории.
  const last = result[result.length - 1];

  if (
    !last ||
    last.role !== "user" ||
    last.text !== userText
  ) {
    result.push({
      role: "user",
      text: userText
    });
  }

  result.push({
    role: "model",
    text: cleanText(answer)
  });

  return result.slice(-MAX_HISTORY);
}

function aliceResponse(
  res,
  text,
  history = [],
  userStateUpdate = null
) {
  const safeText =
    cleanText(text) ||
    "Не удалось подготовить ответ. Попробуйте ещё раз.";

  const payload = {
    version: "1.0",
    response: {
      text: safeText,
      end_session: false
    },
    session_state: {
      history: history.slice(-MAX_HISTORY)
    }
  };

  if (userStateUpdate) {
    payload.user_state_update = userStateUpdate;
  }

  return res.status(200).json(payload);
}

function isWeatherIntent(text) {
  return /погод\w*|температур\w*|сколько градусов|будет ли дождь|идёт ли дождь|осадки/i
    .test(text);
}

function isNewsIntent(text) {
  return /последн\w*\s+новост\w*|новост\w*|что произошло|что случилось|что нового|свеж\w*\s+новост\w*|события в мире/i
    .test(text);
}

function isSportsIntent(text) {
  return /кто выиграл|кто победил|результат\w*\s+матч|сч[её]т\s+матч|последн\w*\s+матч|матч\w*\s+(сегодня|вчера)|футбол\w*.*(сегодня|вчера|сч[её]т|матч)|хокке\w*.*(сегодня|вчера|сч[её]т|матч)|спортивн\w*\s+новост/i
    .test(text);
}

function isSearchIntent(text) {
  return (
    isWeatherIntent(text) ||
    isNewsIntent(text) ||
    isSportsIntent(text) ||
    /(найди|найти|поищи|поиск|в интернете|актуальн\w*|курс валют|цена сегодня)/i
      .test(text)
  );
}

function extractSearchQuery(text) {
  const original = cleanText(text, 180);

  if (isWeatherIntent(original)) {
    // Сохраняем название населённого пункта из исходного запроса.
    const location = original
      .replace(/^(?:алиса[, ]*)?/i, "")
      .replace(/^(?:какая|какая сейчас|скажи|расскажи|узнай)\s+/i, "")
      .replace(/^погод[ауеы]?\s*/i, "")
      .replace(/\s+(?:сегодня|сейчас|завтра|на неделю|на сегодня).*$/i, "")
      .trim();

    return location
      ? `погода ${location} сегодня температура осадки прогноз`
      : "погода сегодня температура осадки прогноз";
  }

  if (isSportsIntent(original)) {
    return `${original} последний результат матча`;
  }

  if (isNewsIntent(original)) {
    return `${original} новости за последние 24 часа дата публикации`;
  }

  return original
    .replace(
      /^(?:алиса[, ]*)?(?:найди|найти|поищи|поиск|скажи|расскажи|покажи)\s*/i,
      ""
    )
    .trim() || original;
}

async function fetchJsonWithTimeout(
  url,
  options,
  timeoutMs
) {
  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    Math.max(1, timeoutMs)
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

async function searchWeb(query, timeoutMs) {
  const apiKey = process.env.SERPER_API_KEY;

  if (!apiKey) {
    console.error("SERPER_API_KEY is missing");
    return null;
  }

  if (timeoutMs <= 0) return null;

  try {
    const newsSearch = isNewsIntent(query);

    const endpoint = newsSearch
      ? "https://google.serper.dev/news"
      : "https://google.serper.dev/search";

    const { response, data } = await fetchJsonWithTimeout(
      endpoint,
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
          num: newsSearch ? 6 : 5,
          ...(newsSearch ? { tbs: "qdr:d" } : {})
        })
      },
      timeoutMs
    );

    if (!response.ok) {
      console.error("Serper HTTP status:", response.status);
      return null;
    }

    const results = [];

    if (data.answerBox?.answer) {
      results.push({
        title: "Прямой ответ",
        snippet: cleanText(data.answerBox.answer, 350),
        date: ""
      });
    } else if (data.answerBox?.snippet) {
      results.push({
        title: "Краткий ответ",
        snippet: cleanText(data.answerBox.snippet, 350),
        date: ""
      });
    }

    const organic = newsSearch
      ? (Array.isArray(data.news) ? data.news : [])
      : (Array.isArray(data.organic) ? data.organic : []);

    for (const item of organic.slice(0, newsSearch ? 6 : 5)) {
      const title = cleanText(item?.title, 180);
      const snippet = cleanText(item?.snippet, 350);
      const date = cleanText(item?.date, 80);

      if (title || snippet) {
        results.push({
          title,
          snippet,
          date
        });
      }
    }

    return results.length ? results : null;
  } catch (error) {
    console.error(
      "Search error:",
      error?.name || "Error",
      cleanText(error?.message, 160)
    );

    return null;
  }
}

function formatSearchResults(results) {
  return results
    .map((item, index) => {
      const parts = [
        `Источник ${index + 1}`,
        item.title,
        item.date ? `Дата: ${item.date}` : "",
        item.snippet
      ].filter(Boolean);

      return parts.join(". ");
    })
    .join("\n")
    .slice(0, 3800);
}

async function askGemini(
  userText,
  history,
  timeoutMs,
  searchResults = null,
  userMemory = []
) {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error("GEMINI_API_KEY is missing");
    return null;
  }

  if (timeoutMs <= 0) return null;

  const recentHistory = history.slice(-8);

  const contents = recentHistory.map(item => ({
    role: item.role,
    parts: [{ text: item.text }]
  }));

  if (searchResults) {
    contents.push({
      role: "user",
      parts: [{
        text:
          `Запрос пользователя: ${userText}\n\n` +
          `Результаты актуального поиска:\n${searchResults}\n\n` +
          "Составь короткий ответ строго по найденным сведениям."
      }]
    });
  } else {
    const last = contents[contents.length - 1];

    // Текущий запрос добавляем ровно один раз.
    if (
      !last ||
      last.role !== "user" ||
      last.parts?.[0]?.text !== userText
    ) {
      contents.push({
        role: "user",
        parts: [{ text: userText }]
      });
    }
  }

  // Gemini ожидает чередование user/model, а не две user-реплики подряд.
  const normalizedContents = [];

  for (const item of contents) {
    const previous = normalizedContents[
      normalizedContents.length - 1
    ];

    if (previous?.role === item.role) {
      if (item.role === "user") {
        previous.parts[0].text +=
          "\n" + item.parts.map(p => p.text || "").join("\n");
      } else {
        normalizedContents.push(item);
      }
    } else {
      normalizedContents.push(item);
    }
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
            parts: [{
              text:
                (searchResults
                  ? SEARCH_INSTRUCTION
                  : SYSTEM_INSTRUCTION) +
                (userMemory.length
                  ? "\n\nСохранённые факты, которые пользователь явно просил запомнить. Используй их, когда вопрос относится к ним; не выдумывай другие факты: " +
                    userMemory.join("; ")
                  : "")
            }]
          },
          contents: normalizedContents.slice(-8),
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: searchResults ? 180 : 120,
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
        cleanText(data?.error?.message, 220)
      );

      return null;
    }

    const answer = data?.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();

    if (!answer) {
      console.error("Gemini returned no text");
      return null;
    }

    return cleanText(answer);
  } catch (error) {
    console.error(
      "Gemini request error:",
      error?.name || "Error",
      cleanText(error?.message, 160)
    );

    return null;
  }
}

function fallbackSearchAnswer(
  results,
  weather,
  news,
  sports
) {
  if (!results?.length) {
    if (weather) {
      return "Не удалось получить свежий прогноз для этого населённого пункта. Попробуйте ещё раз.";
    }

    if (sports) {
      return "Не удалось найти подтверждённый результат матча. Уточните команды или турнир.";
    }

    if (news) {
      return "Сейчас не удалось получить свежие новости. Попробуйте ещё раз немного позже.";
    }

    return "Сейчас не удалось найти информацию в интернете. Попробуйте ещё раз.";
  }

  const snippets = results
    .map(item => item.snippet || item.title)
    .filter(Boolean);

  if (weather) {
    return cleanText(
      snippets.slice(0, 2).join(". "),
      MAX_TEXT
    );
  }

  if (sports) {
    return cleanText(
      snippets.slice(0, 2).join(". "),
      MAX_TEXT
    );
  }

  return cleanText(
    snippets.slice(0, 3).join(". "),
    MAX_TEXT
  );
}

export default async function handler(req, res) {
  const startTime = Date.now();

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
  const userMemory = getUserMemory(body);

  if (!userText) {
    return aliceResponse(
      res,
      "Не расслышала вопрос. Повторите, пожалуйста.",
      history
    );
  }

  const memoryCommand = getMemoryCommand(userText);

  if (memoryCommand) {
    const result = memoryCommandResult(
      memoryCommand,
      userMemory
    );

    const update = result.changed
      ? { memory: { facts: result.facts } }
      : null;

    return aliceResponse(
      res,
      result.answer,
      buildHistory(history, userText, result.answer),
      update
    );
  }

  const weather = isWeatherIntent(userText);
  const news = isNewsIntent(userText);
  const sports = isSportsIntent(userText);

  try {
    if (isSearchIntent(userText)) {
      const query = extractSearchQuery(userText);

      console.log("Search request:", query);

      const searchTimeout = Math.min(
        SERPER_TIMEOUT_MS,
        getRemainingTime(startTime) - 300
      );

      const results = await searchWeb(
        query,
        Math.max(0, searchTimeout)
      );

      let answer = null;

      if (results?.length) {
        const remaining = getRemainingTime(startTime);

        // Поиск и краткая выжимка выполняются последовательно,
        // но на Gemini выделяется только оставшееся время.
        if (remaining > 500) {
          answer = await askGemini(
            userText,
            history,
            Math.min(
              GEMINI_TIMEOUT_MS,
              remaining - 250
            ),
            formatSearchResults(results),
            userMemory
          );
        }

        if (!answer) {
          answer = fallbackSearchAnswer(
            results,
            weather,
            news,
            sports
          );
        }
      } else {
        answer = fallbackSearchAnswer(
          null,
          weather,
          news,
          sports
        );
      }

      return aliceResponse(
        res,
        answer,
        buildHistory(history, userText, answer)
      );
    }

    const remaining = getRemainingTime(startTime);

    const answer = await askGemini(
      userText,
      history,
      Math.min(
        GEMINI_TIMEOUT_MS,
        Math.max(0, remaining - 200)
      ),
      null,
      userMemory
    );

    const finalAnswer =
      answer ||
      "Нейросеть временно не ответила. Попробуйте повторить вопрос.";

    return aliceResponse(
      res,
      finalAnswer,
      buildHistory(history, userText, finalAnswer)
    );
  } catch (error) {
    console.error(
      "Webhook error:",
      error?.name || "Error",
      cleanText(error?.message || "Unknown error", 200)
    );

    const message = isSearchIntent(userText)
      ? "Сейчас не удалось получить ответ. Попробуйте ещё раз."
      : "Нейросеть временно не ответила. Попробуйте повторить вопрос.";

    return aliceResponse(
      res,
      message,
      buildHistory(history, userText, message)
    );
  }
}
