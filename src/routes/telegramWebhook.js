import express from "express";
import { timingSafeEqual } from "node:crypto";
import { handleTelegramUpdate } from "../services/telegramCommands.js";

const router = express.Router();

router.post("/webhook", async (req, res, next) => {
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    const receivedSecret =
        req.get("x-telegram-bot-api-secret-token") ?? "";

    if (!expectedSecret) {
        return res.status(503).json({
            error: "Telegram webhook secret is not configured",
        });
    }

    const expected = Buffer.from(expectedSecret);
    const received = Buffer.from(receivedSecret);

    if (
        expected.length !== received.length ||
        !timingSafeEqual(expected, received)
    ) {
        return res.status(401).json({
            error: "Unauthorized webhook request",
        });
    }

    try {
        const result = await handleTelegramUpdate(req.body ?? {});

        return res.status(200).json({
            ok: true,
            ...result,
        });
    } catch (error) {
        console.error("Telegram webhook failed:", error.message);
        return next(error);
    }
});

export default router;