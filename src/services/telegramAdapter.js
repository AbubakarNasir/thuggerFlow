
export async function sendTelegramMessage(chatId, payload) {
    if (!chatId) {
        throw new Error("Missing Telegram chat ID");
    }

    if (!payload || typeof payload !== "object") {
        throw new Error("Invalid notification payload");
    }

    const message = payload.text;

    if (typeof message !== "string" || !message.trim()) {
        throw new Error("Notification payload must contain text");
    }

    console.log("[SIMULATED TELEGRAM DELIVERY]", {
        chatId: String(chatId),
        message,
        timestamp: new Date().toISOString(),
    });

    // Simulate a successful delivery.
    return {
        ok: true,
        simulated: true,
    };
}