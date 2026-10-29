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

  const lifecycleEventTypes = new Set([
    "potential",
    "confirmed",
    "cancelled",
    "expired",
  ]);

  const isLifecycleEvent = lifecycleEventTypes.has(event_type);

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

  if (isLifecycleEvent) {
    if (typeof setup_id !== "string" || !setup_id.trim()) {
      invalidFields.push("setup_id");
    }

    if (body.instrument !== "US100") {
      invalidFields.push("instrument");
    }

    if (body.timeframe !== "M15") {
      invalidFields.push("timeframe");
    }

    if (
      typeof body.bar_timestamp !== "string" ||
      Number.isNaN(Date.parse(body.bar_timestamp))
    ) {
      invalidFields.push("bar_timestamp");
    }

    if (!["long", "short"].includes(body.direction)) {
      invalidFields.push("direction");
    }

    if (
      !Number.isInteger(body.confidence_score) ||
      body.confidence_score < 0 ||
      body.confidence_score > 100
    ) {
      invalidFields.push("confidence_score");
    }

    if (["potential", "confirmed"].includes(event_type)) {
      if (
        typeof body.entry !== "number" ||
        !Number.isFinite(body.entry) ||
        body.entry <= 0
      ) {
        invalidFields.push("entry");
      }

      if (
        typeof body.stop_loss !== "number" ||
        !Number.isFinite(body.stop_loss) ||
        body.stop_loss <= 0
      ) {
        invalidFields.push("stop_loss");
      }

      if (
        typeof body.entry === "number" &&
        Number.isFinite(body.entry) &&
        body.entry > 0 &&
        typeof body.stop_loss === "number" &&
        Number.isFinite(body.stop_loss) &&
        body.stop_loss > 0 &&
        ["long", "short"].includes(body.direction)
      ) {
        if (
          body.direction === "long" &&
          body.stop_loss >= body.entry
        ) {
          invalidFields.push("stop_loss");
        }

        if (
          body.direction === "short" &&
          body.stop_loss <= body.entry
        ) {
          invalidFields.push("stop_loss");
        }
      }

      if (
        !Array.isArray(body.targets) ||
        !body.targets.every(
          (target) =>
            typeof target === "number" &&
            Number.isFinite(target) &&
            target > 0
        )
      ) {
        invalidFields.push("targets");
      }

      if (
        typeof body.entry === "number" &&
        Number.isFinite(body.entry) &&
        body.entry > 0 &&
        Array.isArray(body.targets) &&
        ["long", "short"].includes(body.direction)
      ) {
        const hasInvalidTarget = body.targets.some((target) => {
          if (typeof target !== "number" || !Number.isFinite(target)) {
            return false; // Existing validation handles invalid target types.
          }

          if (body.direction === "long") {
            return target <= body.entry;
          }

          return target >= body.entry;
        });

        if (hasInvalidTarget) {
          invalidFields.push("targets");
        }
      }
    }
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
