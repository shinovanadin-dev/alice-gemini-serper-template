const DEFAULT_MODEL = "gemini-3.5-flash-lite";
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1200;
const MAX_ALICE_TEXT = 1024;
const TOTAL_RESPONSE_BUDGET_MS = 3600;
const SERPER_TIMEOUT_MS = 600;
const GEMINI_TIMEOUT_MS = 2500;

const SYSTEM_PROMPT = [
  "Ты полезный голосовой помощник в навыке Яндекс Алисы.",
  "Отвечай естественно, по-русски, кратко и так, чтобы ответ было удобно слушать.",
  "Обычно используй 1–3 коротких предложения.",
  "Не используй Markdown, таблицы, списки с символами или длинные вступления.",
  "Если вопрос требует актуальных данных и переданы результаты поиска, опирайся на них.",
  "Не выдумывай отсутствующие факты.",
  "Если не знаешь ответа, честно скажи об этом."
].join(" ");

function aliceResponse(text, endSession = false, history = [], session = {}) {
  const response = {
    version: "1.0",
    response: {
      text: fitAliceText(text),
      end_session: endSession
    },
    session_state: {
      history: safeHistory(history)
    }
  };

  // Передаём идентификаторы сессии, полученные от Яндекса.
  if (session && typeof session === "object") {
    const sessionData = {};

    if (typeof session.session_id === "string") {
      sessionData.session_id = session.session_id;
    }

    if (Number.isInteger(session.message_id)) {
      sessionData.message_id = session.message_id;
    }

    if (typeof session.user_id === "string") {
      sessionData.user_id = session.user_id;
    }

    if (Object.keys(sessionData).length > 0) {
      response.session = sessionData;
    }
  }

  return response;
}

function fitAliceText(value) {
  const text = String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (text.length <= MAX_ALICE_TEXT) {
    return text || "Привет! Чем могу помочь?";
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
    lastSpace > 200
      ? candidate.slice(0, lastSpace)
      : candidate
  ).trim() + "…";
}

function isSearchIntent(text) {
  return /\b(latest|today|current|news|weather|price|exchange rate|recent|search|look up)\b|сегодня|сейчас|последн|новост|погод|курс валют|найди|поищи|актуальн|сколько стоит|свежие данные/i.test(text);
}

function safeHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

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

    return {
      response,
      data
    };
  } finally {
    clearTimeout(timer);
  }
}

async function searchWeb(query, timeoutMs) {
  const key = process.env.SERPER_API_KEY;

  if (!key || timeoutMs < 150) {
    return "";
  }

  try {
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
      Math.min(SERPER_TIMEOUT_MS, timeoutMs)
    );

    if (!response.ok) {
      console.warn(
        "SERPER_HTTP_ERROR",
        response.status
      );

      return "";
    }

    const items = (
      Array.isArray(data.organic)
        ? data.organic
        : []
    )
      .slice(0, 3)
      .map((item, index) => {
        const title = String(item.title || "").slice(0, 180);
        const snippet = String(item.snippet || "").slice(0, 350);
        const link = String(item.link || "").slice(0, 240);

        return `${index + 1}. ${title}: ${snippet} ${link}`.trim();
      });

    const answerBox =
      data.answerBox?.answer ||
      data.answerBox?.snippet;

    if (answerBox) {
      items.unshift(
        `Краткий ответ поисковика: ${String(answerBox).slice(0, 350)}`
      );
    }

    return items.length > 0
      ? items.join("\n")
      : "";
  } catch (error) {
    console.warn(
      "SERPER_REQUEST_ERROR",
      error?.name || "UnknownError"
    );

    return "";
  }
}

async function askGemini(text, history, searchContext, timeoutMs) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error("MISSING_GEMINI_KEY");
  }

  if (timeoutMs < 250) {
    throw new Error("TIME_BUDGET_EXHAUSTED");
  }

  const model = String(
    process.env.GEMINI_MODEL || DEFAULT_MODEL
  ).trim();

  if (!/^[A-Za-z0-9._-]+$/.test(model)) {
    throw new Error("INVALID_MODEL_NAME");
  }

  const contents = safeHistory(history).map(item => ({
    role: item.role,
    parts: [
      {
        text: item.text
      }
    ]
  }));

  const prompt = searchContext
    ? `${text}\n\nРезультаты поиска в интернете:\n${searchContext}\nИспользуй их только там, где они относятся к вопросу.`
    : text;

  contents.push({
    role: "user",
    parts: [
      {
        text: prompt
      }
    ]
  });

  const { response, data } = await fetchJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: SYSTEM_PROMPT
            }
          ]
        },
        contents,
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 240
        }
      })
    },
    Math.min(GEMINI_TIMEOUT_MS, timeoutMs)
  );

  if (!response.ok) {
    const status = Number(response.status);

    console.error(
      "GEMINI_HTTP_ERROR",
      status
    );

    if (status === 401 || status === 403) {
      throw new Error("GEMINI_KEY_REJECTED");
    }

    if (status === 429) {
      throw new Error("GEMINI_QUOTA");
    }

    throw new Error("GEMINI_REQUEST_FAILED");
  }

  const candidate = data?.candidates?.[0];

  const answer = (
    candidate?.content?.parts || []
  )
    .map(part =>
      typeof part.text === "string"
        ? part.text
        : ""
    )
    .join("")
    .trim();

  if (!answer) {
    if (data?.promptFeedback?.blockReason) {
      throw new Error("GEMINI_BLOCKED");
    }

    throw new Error("GEMINI_EMPTY_RESPONSE");
  }

  if (candidate?.finishReason === "MAX_TOKENS") {
    console.warn("GEMINI_MAX_TOKENS_REACHED");
  }

  return answer;
}

function errorForUser(error) {
  switch (error?.message) {
    case "MISSING_GEMINI_KEY":
      return "Сервер пока не настроен. Проверьте переменную GEMINI_API_KEY в настройках Vercel.";

    case "GEMINI_KEY_REJECTED":
      return "Не удалось подключиться к Gemini. Проверьте API-ключ в настройках Vercel.";

    case "GEMINI_QUOTA":
      return "Сейчас превышен лимит запросов к Gemini. Попробуйте немного позже.";

    case "GEMINI_BLOCKED":
      return "Я не смогла обработать этот запрос. Попробуйте спросить иначе.";

    case "GEMINI_EMPTY_RESPONSE":
      return "Нейросеть вернула пустой ответ. Попробуйте задать вопрос ещё раз.";

    case "GEMINI_REQUEST_FAILED":
      return "Не удалось получить ответ от Gemini. Проверьте доступность сервиса и настройки API.";

    case "INVALID_MODEL_NAME":
      return "В настройках сервера указано некорректное имя модели Gemini.";

    case "TIME_BUDGET_EXHAUSTED":
    case "AbortError":
      return "Мне нужно немного больше времени для ответа. Попробуйте задать вопрос короче.";

    default:
      return "Не получилось получить ответ от нейросети. Попробуйте ещё раз чуть позже.";
  }
}

export default async function handler(req, res) {
  // Проверка доступности вебхука через браузер.
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      service: "alice-gemini-serper",
      message: "Webhook is ready. Yandex Dialogs should send POST requests to /api."
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
    req.body && typeof req.body === "object"
      ? req.body
      : {};

  // Диагностика: фиксируем факт получения POST без записи текста
  // пользователя и без записи секретных ключей.
  console.info("ALICE_POST_RECEIVED", {
    hasRequest: Boolean(body.request),
    hasSession: Boolean(body.session),
    hasSessionId: Boolean(body.session?.session_id),
    hasCommand: typeof body.request?.command === "string",
    hasOriginalUtterance:
      typeof body.request?.original_utterance === "string",
    contentType: req.headers["content-type"] || null
  });

  const session = body.session || {};

  const text = String(
    body?.request?.command ||
    body?.request?.original_utterance ||
    ""
  ).trim();

  const oldHistory = safeHistory(
    body?.state?.session?.history
  );

  // Алиса может прислать пустую команду при запуске навыка.
  if (!text) {
    console.info("ALICE_LAUNCH_REQUEST");

    return res.status(200).json(
      aliceResponse(
        "Привет! Я могу ответить на вопрос или найти актуальную информацию. Что хочешь узнать?",
        false,
        oldHistory,
        session
      )
    );
  }

  try {
    let searchContext = "";

    if (
      isSearchIntent(text) &&
      process.env.SERPER_API_KEY
    ) {
      searchContext = await searchWeb(
        text,
        Math.min(
          SERPER_TIMEOUT_MS,
          Math.max(0, remainingMs() - 2600)
        )
      );
    }

    const answer = await askGemini(
      text,
      oldHistory,
      searchContext,
      Math.max(
        0,
        Math.min(
          GEMINI_TIMEOUT_MS,
          remainingMs() - 600
        )
      )
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

    console.info("ALICE_RESPONSE_READY", {
      answerLength: answer.length,
      elapsedMs: Date.now() - startedAt
    });

    return res.status(200).json(
      aliceResponse(
        answer,
        false,
        history,
        session
      )
    );
  } catch (error) {
    const safeError =
      error?.name === "AbortError" ||
      error?.message === "AbortError"
        ? new Error("TIME_BUDGET_EXHAUSTED")
        : error;

    console.error("ALICE_WEBHOOK_ERROR", {
      code: safeError?.message || "UNKNOWN_ERROR",
      elapsedMs: Date.now() - startedAt
    });

    return res.status(200).json(
      aliceResponse(
        errorForUser(safeError),
        false,
        oldHistory,
        session
      )
    );
  }
}

export {
  aliceResponse,
  fitAliceText,
  isSearchIntent,
  safeHistory
};
