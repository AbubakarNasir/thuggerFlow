import express from "express";
import "dotenv/config";
import tradingViewWebhookRouter from "./routes/tradingViewWebhook.js";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use("/api/webhooks", tradingViewWebhookRouter);

app.get("/health", (req, res) => {
    res.status(200).json({ 
        status: "ok",
        app: "ThuggerFlow",
        mode: "development", 
    });
});

app.listen(PORT, () => {
    console.log(`ThuggerFlow server is running on port ${PORT}`);
});