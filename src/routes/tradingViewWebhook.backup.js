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

  if (body.schema_version !== "1.0") {
    invalidFields.push("schema_version");
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
        body.targets.length === 0 ||
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

      if (
        typeof body.entry === "number" &&
        Number.isFinite(body.entry) &&
        body.entry > 0 &&
        typeof body.stop_loss === "number" &&
        Number.isFinite(body.stop_loss) &&
        body.stop_loss > 0 &&
        Array.isArray(body.targets) &&
        body.targets.length > 0 &&
        Number.isFinite(body.targets[0]) &&
        ["long", "short"].includes(body.direction)
      ) {
        const risk = Math.abs(body.entry - body.stop_loss);
        const reward = Math.abs(body.targets[0] - body.entry);

        if (risk === 0) {
          invalidFields.push("stop_loss");
        } else {
          const riskRewardRatio = reward / risk;

          if (riskRewardRatio < 2) {
            invalidFields.push("targets");
          }
        }
      }
    }
  }

  if (event_type === "heartbeat") {
    if (body.instrument !== "US100") {
      invalidFields.push("instrument");
    }

    if (body.timeframe !== "M15") {
      invalidFields.push("timeframe");
    }

    const heartbeatTimestamp =
      typeof body.bar_timestamp === "string"
        ? Date.parse(body.bar_timestamp)
        : NaN;

    const now = Date.now();
    const futureToleranceMs = 60_000;
    const staleThresholdMs = 20 * 60_000;

    if (
      !Number.isFinite(heartbeatTimestamp) ||
      heartbeatTimestamp > now + futureToleranceMs ||
      heartbeatTimestamp < now - staleThresholdMs
    ) {
      invalidFields.push("bar_timestamp");
    }
  }

  if (event_type === "daily_bias") {
    if (body.instrument !== "US100") {
      invalidFields.push("instrument");
    }

    if (body.timeframe !== "D1") {
      invalidFields.push("timeframe");
    }

    const dailyBiasTimestamp =
      typeof body.bar_timestamp === "string"
        ? Date.parse(body.bar_timestamp)
        : NaN;

    const now = Date.now();
    const futureToleranceMs = 60_000;
    const maxAgeMs = 24 * 60 * 60 * 1_000;

    if (
      !Number.isFinite(dailyBiasTimestamp) ||
      dailyBiasTimestamp > now + futureToleranceMs ||
      dailyBiasTimestamp < now - maxAgeMs
    ) {
      invalidFields.push("bar_timestamp");
    }

    if (!["bullish", "bearish", "neutral"].includes(body.daily_bias)) {
      invalidFields.push("daily_bias");
    }
  }

  if (invalidFields.length > 0) {
    const uniqueInvalidFields = [...new Set(invalidFields)];

    try {
      await pool.query(
        `INSERT INTO signal_event_audit (
          event_id,
          setup_id,
          correlation_id,
          audit_type,
          reason,
          details
        )
        VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          typeof event_id === "string" ? event_id : null,
          typeof setup_id === "string" ? setup_id : null,
          correlationId,
          "validation_rejected",
          "Event validation failed",
          JSON.stringify({
            invalidFields: uniqueInvalidFields,
            eventType: event_type ?? null,
          }),
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
      invalidFields: uniqueInvalidFields,
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
