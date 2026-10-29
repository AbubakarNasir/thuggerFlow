import express from "express";
import "dotenv/config";
import tradingViewWebhookRouter from "./routes/tradingViewWebhook.js";
import { pool } from "./db.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "32kb" }));
app.use("/api/webhooks", tradingViewWebhookRouter);

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

app.listen(PORT, () => {
    console.log(`ThuggerFlow server is running on port ${PORT}`);
});