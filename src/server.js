import express from "express";
import dotenv from "dotenv";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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