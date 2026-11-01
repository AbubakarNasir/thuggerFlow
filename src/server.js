import express from "express";
import helmet from "helmet";
import "dotenv/config";

import tradingViewWebhookRouter from "./routes/tradingViewWebhook.js";
import telegramWebhookRouter from "./routes/telegramWebhook.js";
import tradingViewRateLimiter from "./middleware/tradingViewRateLimiter.js";

import { pool } from "./db.js";
import { startNotificationWorker } from "./workers/notificationWorker.js";

const app = express();

app.use(
    helmet({
        hsts:
            process.env.NODE_ENV === "production"
                ? {
                      maxAge: 31536000,
                      includeSubDomains: true,
                      preload: false,
                  }
                : false,
    })
);

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "127.0.0.1";

// --------------------------------------------------
// 1. TRADINGVIEW RATE LIMITER
// --------------------------------------------------

app.use(
    "/api/webhooks/tradingview",
    tradingViewRateLimiter
);

// --------------------------------------------------
// 2. REQUEST PARSING
// --------------------------------------------------

app.use(express.json({ limit: "32kb" }));

// --------------------------------------------------
// 3. API ROUTES
// --------------------------------------------------

app.use("/api/webhooks", tradingViewWebhookRouter);
app.use("/api/telegram", telegramWebhookRouter);

// --------------------------------------------------
// 4. HEALTH ENDPOINTS
// --------------------------------------------------

app.get("/health", (req, res) => {
    res.status(200).json({
        status: "ok",
        app: "ThuggerFlow",
        mode: "development",
    });
});

app.get("/health/db", async (req, res) => {
    try {
        await pool.query("SELECT 1");

        res.status(200).json({
            status: "ok",
            database: "connected",
            mode: "development",
        });
    } catch (error) {
        console.error("Database health check failed:", error.message);

        res.status(503).json({
            status: "error",
            database: "unavailable",
            mode: "development",
        });
    }
});

// --------------------------------------------------
// 5. GLOBAL ERROR HANDLER
// --------------------------------------------------

app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
        return res.status(400).json({
            error: "Malformed JSON",
        });
    }

    if (err.status === 413 || err.type === "entity.too.large") {
        return res.status(413).json({
            error: "Payload too large",
        });
    }

    console.error("Unhandled server error:", err.message);

    return res.status(500).json({
        error: "Internal server error",
    });
});

// --------------------------------------------------
// 6. NOTIFICATION WORKER
// --------------------------------------------------

let stopWorker = null;
let shuttingDown = false;

function startWorker() {
    try {
        stopWorker = startNotificationWorker();
    } catch (error) {
        console.error(
            "Could not start notification worker:",
            error.message
        );
    }
}

// --------------------------------------------------
// 7. SERVER START
// --------------------------------------------------

const server = app.listen(PORT, HOST, () => {
    console.log(`ThuggerFlow server is running at http://${HOST}:${PORT}`);
    startWorker();
});

// --------------------------------------------------
// 8. GRACEFUL SHUTDOWN
// --------------------------------------------------

async function shutdown(signal) {
    if (shuttingDown) return;

    shuttingDown = true;
    console.log(`${signal} received. Shutting down gracefully...`);

    try {
        await new Promise((resolve, reject) => {
            server.close((error) => {
                if (error) reject(error);
                else resolve();
            });
        });

        if (stopWorker) {
            await stopWorker();
        }

        await pool.end();

        console.log("ThuggerFlow shut down successfully.");
        process.exit(0);
    } catch (error) {
        console.error("Shutdown error:", error.message);
        process.exit(1);
    }
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));