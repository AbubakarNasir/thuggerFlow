const TELEGRAM_API = "https://api.telegram.org";

async function telegramRequest(method, payload) {
    const token = process.env.TELEGRAM_BOT_TOKEN;

    if (!token) {
        throw new Error("TELEGRAM_BOT_TOKEN is not configured");
    }

    const response = await fetch(
        `${TELEGRAM_API}/bot${token}/${method}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(payload ?? {}),
            signal: AbortSignal.timeout(15000),
        }
    );

    const data = await response.json();

    if (!response.ok || !data.ok) {
        throw new Error(
            `Telegram API ${method} failed: ${
                data.description ?? `HTTP ${response.status}`
            }`
        );
    }

    return data.result;
}

export async function getTelegramBot() {
    return telegramRequest("getMe");
}

export async function sendTelegramMessage(chatId, payload) {
    if (!chatId) {
        throw new Error("Missing Telegram chat ID");
    }

    if (
        !payload ||
        typeof payload.text !== "string" ||
        !payload.text.trim()
    ) {
        throw new Error("Notification payload must contain text");
    }

    return telegramRequest("sendMessage", {
        chat_id: String(chatId),
        text: payload.text,
    });
}
