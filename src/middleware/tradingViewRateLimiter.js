import { isIP } from "node:net";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";

const tradingViewRateLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 60,

    standardHeaders: "draft-8",
    legacyHeaders: false,

    keyGenerator: (req) => {
        const cloudflareIp = req.get("CF-Connecting-IP");

        const clientIp =
            typeof cloudflareIp === "string" &&
            isIP(cloudflareIp)
                ? cloudflareIp
                : req.socket.remoteAddress;

        if (!clientIp || !isIP(clientIp)) {
            return "unknown-client";
        }

        return ipKeyGenerator(clientIp);
    },

    handler: (req, res) => {
        return res.status(429).json({
            error: "Too many webhook requests. Please try again later.",
        });
    },

    message: {
        error: "Too many webhook requests.",
    },
});

export default tradingViewRateLimiter;