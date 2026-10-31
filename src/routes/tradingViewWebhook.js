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

const lifecycleEventTypes = new Set([
  "potential",
  "confirmed",
  "cancelled",
  "expired",
]);

async function writeAudit(client, {
  eventId,
  setupId,
  correlationId,
  auditType,
  reason,
  details = {},
}) {
  await client.query(
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
      eventId,
      setupId,
      correlationId,
      auditType,
      reason,
      JSON.stringify(details),
    ]
  );
}

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
          if (
            typeof target !== "number" ||
            !Number.isFinite(target)
          ) {
            return false;
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
        } else if (reward / risk < 2) {
          invalidFields.push("targets");
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

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

    // Insert the event first so setups.last_event_id can reference it.
    const result = await client.query(
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
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
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
      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(200).json({
        status: "duplicate_ignored",
        correlationId,
      });
    }

    // Lifecycle events are processed atomically with their setup changes.
    if (isLifecycleEvent) {
      // Serialize events for the same setup, including first-time creation.
      await client.query(
        `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
        [setup_id]
      );

      const setupResult = await client.query(
        `SELECT *
         FROM setups
         WHERE setup_id = $1
         FOR UPDATE`,
        [setup_id]
      );

      const existingSetup = setupResult.rows[0] ?? null;

      let processingOutcome = "ignored";

      // A potential event creates a setup if it does not exist.
      if (!existingSetup && event_type === "potential") {
        await client.query(
          `INSERT INTO setups (
            setup_id,
            instrument,
            timeframe,
            direction,
            setup_state,
            confidence_score,
            entry_price,
            stop_loss,
            targets,
            last_event_id,
            last_source_timestamp
          )
          VALUES ($1, $2, $3, $4, 'potential', $5, $6, $7, $8::jsonb, $9, $10)`,
          [
            setup_id,
            body.instrument,
            body.timeframe,
            body.direction,
            body.confidence_score,
            body.entry,
            body.stop_loss,
            JSON.stringify(body.targets),
            event_id,
            body.bar_timestamp,
          ]
        );

        processingOutcome = "setup_created";
      } else if (!existingSetup) {
        // Confirmed, cancelled, or expired events cannot create a setup.
        await writeAudit(client, {
          eventId: event_id,
          setupId: setup_id,
          correlationId,
          auditType: "unknown_setup_ignored",
          reason: "Lifecycle event received for an unknown setup",
          details: { eventType: event_type },
        });

        processingOutcome = "unknown_setup_ignored";
      } else {
        const incomingTimestamp = Date.parse(body.bar_timestamp);
        const existingTimestamp = existingSetup.last_source_timestamp
          ? new Date(existingSetup.last_source_timestamp).getTime()
          : null;

        // Older events must never overwrite newer setup data.
        if (
          existingTimestamp !== null &&
          incomingTimestamp < existingTimestamp
        ) {
          await writeAudit(client, {
            eventId: event_id,
            setupId: setup_id,
            correlationId,
            auditType: "stale_event_ignored",
            reason: "Older event cannot overwrite newer setup data",
            details: {
              incomingTimestamp: body.bar_timestamp,
              existingTimestamp: existingSetup.last_source_timestamp,
              existingState: existingSetup.setup_state,
            },
          });

          processingOutcome = "stale_event_ignored";
        } else if (
          existingTimestamp !== null &&
          incomingTimestamp === existingTimestamp
        ) {
          // Different event IDs at the same source timestamp are quarantined.
          await writeAudit(client, {
            eventId: event_id,
            setupId: setup_id,
            correlationId,
            auditType: "event_timestamp_conflict",
            reason: "Different events share the same source timestamp",
            details: {
              incomingTimestamp: body.bar_timestamp,
              existingEventId: existingSetup.last_event_id,
            },
          });

          processingOutcome = "event_timestamp_conflict";
        } else if (
          ["cancelled", "expired"].includes(existingSetup.setup_state)
        ) {
          // Terminal states cannot be reversed automatically.
          await writeAudit(client, {
            eventId: event_id,
            setupId: setup_id,
            correlationId,
            auditType: "terminal_state_immutable",
            reason: "Terminal setup state cannot be reversed automatically",
            details: {
              existingState: existingSetup.setup_state,
              incomingEventType: event_type,
            },
          });

          processingOutcome = "terminal_state_immutable";
        } else if (
          existingSetup.setup_state === "confirmed" &&
          event_type === "potential"
        ) {
          // A potential event cannot downgrade a confirmed setup.
          await writeAudit(client, {
            eventId: event_id,
            setupId: setup_id,
            correlationId,
            auditType: "confirmed_state_protected",
            reason: "Potential event cannot downgrade a confirmed setup",
            details: {
              incomingTimestamp: body.bar_timestamp,
            },
          });

          processingOutcome = "confirmed_state_protected";
        } else {
          let nextState = existingSetup.setup_state;

          if (event_type === "confirmed") {
            nextState = "confirmed";
          } else if (event_type === "cancelled") {
            nextState = "cancelled";
          } else if (event_type === "expired") {
            nextState = "expired";
          }

          const nextEntry =
            body.entry === undefined ? null : body.entry;

          const nextStopLoss =
            body.stop_loss === undefined ? null : body.stop_loss;

          const nextTargets =
            body.targets === undefined
              ? null
              : JSON.stringify(body.targets);

          const cancellationReason =
            ["cancelled", "expired"].includes(nextState)
              ? (typeof body.reason === "string" ? body.reason : null)
              : null;

          await client.query(
            `UPDATE setups
             SET
               direction = $1,
               setup_state = $2,
               confidence_score = $3,
               entry_price = COALESCE($4, entry_price),
               stop_loss = COALESCE($5, stop_loss),
               targets = COALESCE($6::jsonb, targets),
               last_event_id = $7,
               last_source_timestamp = $8,
               cancellation_reason = $9,
               updated_at = NOW()
             WHERE setup_id = $10`,
            [
              body.direction,
              nextState,
              body.confidence_score,
              nextEntry,
              nextStopLoss,
              nextTargets,
              event_id,
              body.bar_timestamp,
              cancellationReason,
              setup_id,
            ]
          );

          processingOutcome = `setup_${nextState}`;
        }
      }

      // Every examined lifecycle event is marked processed.
      await client.query(
        `UPDATE signal_events
         SET processing_status = 'processed',
             processed_at = NOW()
         WHERE event_id = $1`,
        [event_id]
      );

      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(202).json({
        status: "event_processed",
        event_id,
        processingOutcome,
        correlationId,
      });
    }

    // Heartbeat and daily-bias events are stored for separate processing.
    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(202).json({
      status: "event_received",
      event_id,
      correlationId,
    });
  } catch (error) {
    if (client && transactionStarted) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        console.error(
          "Transaction rollback failed:",
          rollbackError.message
        );
      }
    }

    console.error("Webhook processing failed:", error.message);

    return res.status(500).json({
      error: "Could not accept event",
      correlationId,
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

export default router;