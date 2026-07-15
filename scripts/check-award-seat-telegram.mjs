const telegramBotToken = requiredEnv("TELEGRAM_BOT_TOKEN");
const telegramChatId = requiredEnv("TELEGRAM_CHAT_ID");
const telegramThreadId = process.env.TELEGRAM_MESSAGE_THREAD_ID?.trim();
const discordAdapterUrl = "https://telegram-adapter.invalid/discord-webhook";
const nativeFetch = globalThis.fetch.bind(globalThis);

globalThis.fetch = async (input, options = {}) => {
  const url = typeof input === "string" ? input : input?.url;

  if (url !== discordAdapterUrl) {
    return nativeFetch(input, options);
  }

  const payload = parseJson(options.body);
  const messages = discordPayloadToTelegramMessages(payload);

  for (const message of messages) {
    await sendTelegramMessage(message);
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

// The existing monitor still publishes a Discord-shaped payload internally.
// This adapter intercepts that one request and converts it to Telegram while
// leaving all Seats.aero requests and flight-search behaviour unchanged.
process.env.DISCORD_WEBHOOK_URL = discordAdapterUrl;
await import("./check-award-seat.mjs");

async function sendTelegramMessage(text) {
  const body = {
    chat_id: telegramChatId,
    text,
    disable_web_page_preview: true,
  };

