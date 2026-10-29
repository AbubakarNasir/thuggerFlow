import { Router } from "express";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";

const router = Router();

const allowedEventTypes = new Set([
  "potential",
  "confirmed",
  "cancelled",
  "expired",
  "daily_bias",
  "heartbeat",
]);

router.post("/tradingview", async (req, res) => {
  const correlationId = randomUUID();
  const body = req.body;

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({
      error: "Invalid JSON event",
      correlationId,
    });
  }

  const { event_id, event_type, setup_id } = body;

  const invalidFields = [];

  if (typeof event_id !== "string" || !event_id.trim()) {
    invalidFields.push("event_id");
  }

  if (
    typeof event_type !== "string" ||
    !allowedEventTypes.has(event_type)
  ) {
    invalidFields.push("event_type");
  }

  if (
    setup_id !== undefined &&
    (typeof setup_id !== "string" || !setup_id.trim())
  ) {
    invalidFields.push("setup_id");
  }

  if (invalidFields.length > 0) {
    try {
      await pool.query(
        `INSERT INTO signal_events (
          event_id,
          event_type,
          correlation_id,
          processing_status,
          rejection_category
        )
        VALUES ($1, $2, $3, 'rejected', $4)`,
        [
          `rejected:${correlationId}`,
          "invalid_event",
          correlationId,
          `invalid_fields:${invalidFields.join(",")}`,
        ]
      );
    } catch (error) {
      console.error("Rejection audit failed:", error.message);

      return res.status(500).json({
        error: "Could not record rejection",
        correlationId,
      });
    }

    return res.status(400).json({
      error: "Event validation failed",
      invalidFields,
      correlationId,
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO signal_events (
        event_id,
        event_type,
        setup_id,
        instrument,
        timeframe,
        bar_timestamp,
        correlation_id,
        schema_version,
        payload
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9
      )
      ON CONFLICT (event_id) DO NOTHING
      RETURNING event_id`,
      [
        event_id,
        event_type,
        setup_id ?? null,
        body.instrument ?? null,
        body.timeframe ?? null,
        body.bar_timestamp ?? null,
        correlationId,
        body.schema_version ?? null,
        body,
      ]
    );

    if (result.rowCount === 0) {
      return res.status(200).json({
        status: "duplicate_ignored",
        correlationId,
      });
    }

    return res.status(202).json({
      status: "event_received",
      event_id,
      correlationId,
    });
  } catch (error) {
    console.error("Webhook processing failed:", error.message);

    return res.status(500).json({
      error: "Could not accept event",
      correlationId,
    });
  }
});

export default router;
