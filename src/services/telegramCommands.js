import { pool } from "../db.js";
import { sendTelegramMessage } from "./telegramAdapter.js";

function parseCommand(text) {
    if (typeof text !== "string") return null;

    const match = text.trim().match(
        /^\/([a-z_]+)(?:@[a-z0-9_]+)?(?:\s|$)/i
    );

    return match ? match[1].toLowerCase() : null;
}

async function registerTelegramUser(client, message) {
    const user = message.from;
    const chat = message.chat;

    await client.query(
        `
        INSERT INTO telegram_users (
            telegram_user_id,
            chat_id,
            username,
            first_name,
            last_name
        )
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (telegram_user_id)
        DO UPDATE SET
            chat_id = EXCLUDED.chat_id,
            username = EXCLUDED.username,
            first_name = EXCLUDED.first_name,
            last_name = EXCLUDED.last_name,
            updated_at = NOW()
        `,
        [
            String(user.id),
            String(chat.id),
            user.username ?? null,
            user.first_name ?? null,
            user.last_name ?? null,
        ]
    );
}

export async function handleTelegramUpdate(update) {
    const message = update?.message;
    const command = parseCommand(message?.text);

    if (!message || !command) {
        return { status: "ignored" };
    }

    if (
        !message.from?.id ||
        !message.chat?.id ||
        message.chat.type !== "private"
    ) {
        return { status: "ignored" };
    }

    if (!/^\d+$/.test(String(update.update_id))) {
        throw new Error("Invalid Telegram update ID");
    }

    const client = await pool.connect();
    let reply;

    try {
        await client.query("BEGIN");

        const updateResult = await client.query(
            `
            INSERT INTO telegram_updates (update_id)
            VALUES ($1)
            ON CONFLICT (update_id) DO NOTHING
            RETURNING update_id
            `,
            [String(update.update_id)]
        );

        if (updateResult.rowCount === 0) {
            await client.query("COMMIT");

            return { status: "duplicate_ignored" };
        }

        await registerTelegramUser(client, message);

        const telegramUserId = String(message.from.id);

        switch (command) {
            case "start":
                reply =
                    "Welcome to ThuggerFlow!\n\n" +
                    "Your NAS100/US100 market analysis and setup alerts start here.\n\n" +
                    "Commands:\n" +
                    "/subscribe - Receive signal notifications\n" +
                    "/unsubscribe - Stop notifications\n" +
                    "/status - Check your subscription and system status\n" +
                    "/help - Show available commands";
                break;

            case "subscribe":
                await client.query(
                    `
                    INSERT INTO subscriptions (
                        telegram_user_id,
                        status,
                        subscribed_at,
                        unsubscribed_at
                    )
                    VALUES ($1, 'active', NOW(), NULL)
                    ON CONFLICT (telegram_user_id)
                    DO UPDATE SET
                        status = 'active',
                        subscribed_at = NOW(),
                        unsubscribed_at = NULL,
                        updated_at = NOW()
                    `,
                    [telegramUserId]
                );

                reply =
                    "You're now subscribed to ThuggerFlow alerts.\n\n" +
                    "Use /unsubscribe whenever you want to stop notifications.";
                break;

            case "unsubscribe":
                await client.query(
                    `
                    INSERT INTO subscriptions (
                        telegram_user_id,
                        status,
                        unsubscribed_at
                    )
                    VALUES ($1, 'inactive', NOW())
                    ON CONFLICT (telegram_user_id)
                    DO UPDATE SET
                        status = 'inactive',
                        unsubscribed_at = NOW(),
                        updated_at = NOW()
                    `,
                    [telegramUserId]
                );

                reply =
                    "You have been unsubscribed from ThuggerFlow alerts.\n\n" +
                    "You can subscribe again anytime with /subscribe.";
                break;

            case "status": {
                const subscriptionResult = await client.query(
                    `
                    SELECT status
                    FROM subscriptions
                    WHERE telegram_user_id = $1
                    `,
                    [telegramUserId]
                );

                const systemResult = await client.query(
                    `
                    SELECT component, status
                    FROM system_status
                    ORDER BY component
                    `
                );

                const subscription =
                    subscriptionResult.rows[0]?.status ?? "not subscribed";

                const systemLines = systemResult.rows.length
                    ? systemResult.rows.map(
                        (item) => `- ${item.component}: ${item.status}`
                    ).join("\n")
                    : "No component status has been reported yet.";

                reply =
                    `ThuggerFlow Status\n\n` +
                    `Subscription: ${subscription}\n\n` +
                    `System components:\n${systemLines}`;
                break;
            }

            case "help":
                reply =
                    "ThuggerFlow Commands:\n\n" +
                    "/start - Register and get started\n" +
                    "/subscribe - Receive signal notifications\n" +
                    "/unsubscribe - Stop notifications\n" +
                    "/status - Check subscription and system status\n" +
                    "/help - Show this message";
                break;

            default:
                reply =
                    "I don't recognise that command.\n\n" +
                    "Use /help to see available commands.";
        }

        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }

    await sendTelegramMessage(message.chat.id, { text: reply });

    return { status: "processed", command };
}