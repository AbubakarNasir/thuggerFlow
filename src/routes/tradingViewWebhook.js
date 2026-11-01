
import { Router } from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
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

const FUTURE_TOLERANCE_MS = 60_000;
const HEARTBEAT_STALE_MS = 20 * 60_000;
const DAILY_BIAS_MAX_AGE_MS = 24 * 60 * 60_000;

// Require a complete ISO-8601 timestamp with an explicit timezone.
// Fractional seconds are limited to PostgreSQL's microsecond precision.
function isValidIsoTimestamp(value) {
  if (typeof value !== "string") return false;

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/
  );

  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);

  if (year < 1 || month < 1 || month > 12) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;

  const leapYear =
    year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

  const daysInMonth = [
    31,
    leapYear ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  if (day < 1 || day > daysInMonth[month - 1]) return false;

  if (match[8] !== "Z") {
    const offsetHours = Number(match[10]);
    const offsetMinutes = Number(match[11]);

    if (offsetHours > 14 || offsetMinutes > 59) return false;
    if (offsetHours === 14 && offsetMinutes !== 0) return false;
  }

  return Number.isFinite(Date.parse(value));
}

function timestampMilliseconds(value) {
  if (!isValidIsoTimestamp(value)) return NaN;
  return Date.parse(value);
}

async function writeAudit(
  client,
  {
    eventId,
    setupId,
    correlationId,
    auditType,
    reason,
    details = {},
  }
) {
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

// Build subscriber notifications only for meaningful setup outcomes.
function buildNotificationText(body, processingOutcome) {
  const labels = {
    setup_created: "New potential setup",
    setup_potential: "Potential setup updated",
    setup_confirmed: "Setup confirmed",
    setup_cancelled: "Setup cancelled",
    setup_expired: "Setup expired",
  };

  const label = labels[processingOutcome];

  if (!label) return null;

  const lines = [
    `THUGGERFLOW | ${label}`,
    `Instrument: ${body.instrument}`,
    `Direction: ${body.direction.toUpperCase()}`,
    `Setup ID: ${body.setup_id}`,
  ];

  if (
    [
      "setup_created",
      "setup_potential",
      "setup_confirmed",
    ].includes(processingOutcome)
  ) {
    lines.push(
      `Timeframe: ${body.timeframe}`,
      `Entry reference: ${body.entry}`,
      `Stop loss: ${body.stop_loss}`,
      `Targets: ${body.targets.join(", ")}`,
      `Confidence evidence score: ${body.confidence_score}/100 (not a probability)`
    );
  }

  if (
    ["setup_cancelled", "setup_expired"].includes(
      processingOutcome
    )
  ) {
    lines.push(`Reason: ${body.reason.slice(0, 500)}`);
  }

  return lines.join("\n");
}

function validateTargets(body, invalidFields) {
  if (
    !Array.isArray(body.targets) ||
    body.targets.length === 0 ||
    body.targets.length > 3 ||
    !body.targets.every(
      (target) =>
        typeof target === "number" &&
        Number.isFinite(target) &&
        target > 0
    )
  ) {
    invalidFields.push("targets");
    return;
  }

  if (!["long", "short"].includes(body.direction)) return;

  // Targets must be ordered from nearest to furthest.
  for (let index = 0; index < body.targets.length; index += 1) {
    const target = body.targets[index];

    if (body.direction === "long" && target <= body.entry) {
      invalidFields.push("targets");
      return;
    }

    if (body.direction === "short" && target >= body.entry) {
      invalidFields.push("targets");
      return;
    }

    if (index > 0) {
      const previousTarget = body.targets[index - 1];

      if (
        body.direction === "long" &&
        target <= previousTarget
      ) {
        invalidFields.push("targets");
        return;
      }

      if (
        body.direction === "short" &&
        target >= previousTarget
      ) {
        invalidFields.push("targets");
        return;
      }
    }
  }

  const risk = Math.abs(body.entry - body.stop_loss);
  const reward = Math.abs(body.targets[0] - body.entry);

  if (risk <= 0 || reward / risk < 2) {
    invalidFields.push("targets");
  }
}

router.post("/tradingview", async (req, res) => {
  const correlationId = randomUUID();
  const body = req.body;

  // --------------------------------------------------
  // 1. WEBHOOK AUTHENTICATION
  // --------------------------------------------------

  const expectedSecret = process.env.TRADINGVIEW_WEBHOOK_SECRET;

  if (!expectedSecret) {
    console.error("TradingView webhook secret is not configured.");

    return res.status(503).json({
      error: "Webhook authentication is unavailable",
      correlationId,
    });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({
      error: "Invalid JSON event",
      correlationId,
    });
  }

  const suppliedSecret = body.webhook_secret;

  const expectedBuffer = Buffer.from(expectedSecret, "utf8");

  const suppliedBuffer =
    typeof suppliedSecret === "string"
      ? Buffer.from(suppliedSecret, "utf8")
      : Buffer.alloc(0);

  const authenticated =
    expectedBuffer.length === suppliedBuffer.length &&
    timingSafeEqual(expectedBuffer, suppliedBuffer);

  if (!authenticated) {
    return res.status(401).json({
      error: "Unauthorized webhook request",
      correlationId,
    });
  }

  // Remove the secret before storing the event payload.
  const eventPayload = { ...body };
  delete eventPayload.webhook_secret;

  // --------------------------------------------------
  // 2. EVENT VALIDATION
  // --------------------------------------------------

  const { event_id, event_type, setup_id } = body;
  const isLifecycleEvent = lifecycleEventTypes.has(event_type);
  const invalidFields = [];
  const now = Date.now();

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

    const lifecycleTimestamp = timestampMilliseconds(
      body.bar_timestamp
    );

    if (
      !Number.isFinite(lifecycleTimestamp) ||
      lifecycleTimestamp > now + FUTURE_TOLERANCE_MS
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
        validateTargets(body, invalidFields);
      } else if (
        !Array.isArray(body.targets) ||
        body.targets.length === 0 ||
        body.targets.length > 3 ||
        !body.targets.every(
          (target) =>
            typeof target === "number" &&
            Number.isFinite(target) &&
            target > 0
        )
      ) {
        invalidFields.push("targets");
      }
    }

    if (["cancelled", "expired"].includes(event_type)) {
      if (
        typeof body.reason !== "string" ||
        !body.reason.trim()
      ) {
        invalidFields.push("reason");
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

    const heartbeatTimestamp = timestampMilliseconds(
      body.bar_timestamp
    );

    if (
      !Number.isFinite(heartbeatTimestamp) ||
      heartbeatTimestamp > now + FUTURE_TOLERANCE_MS ||
      heartbeatTimestamp < now - HEARTBEAT_STALE_MS
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

    const dailyBiasTimestamp = timestampMilliseconds(
      body.bar_timestamp
    );

    if (
      !Number.isFinite(dailyBiasTimestamp) ||
      dailyBiasTimestamp > now + FUTURE_TOLERANCE_MS ||
      dailyBiasTimestamp < now - DAILY_BIAS_MAX_AGE_MS
    ) {
      invalidFields.push("bar_timestamp");
    }

    if (
      !["bullish", "bearish", "neutral"].includes(
        body.daily_bias
      )
    ) {
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

  // --------------------------------------------------
  // 3. DATABASE TRANSACTION
  // --------------------------------------------------

  let client;
  let transactionStarted = false;

  try {
    client = await pool.connect();

    await client.query("BEGIN");
    transactionStarted = true;

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
        eventPayload,
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

    // --------------------------------------------------
    // 4. SETUP LIFECYCLE PROCESSING
    // --------------------------------------------------

    if (isLifecycleEvent) {
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
        const timestampResult = await client.query(
          `SELECT CASE
             WHEN $1::timestamptz < $2::timestamptz THEN -1
             WHEN $1::timestamptz = $2::timestamptz THEN 0
             ELSE 1
           END AS comparison`,
          [body.bar_timestamp, existingSetup.last_source_timestamp]
        );

        const timestampComparison = Number(
          timestampResult.rows[0].comparison
        );

        if (timestampComparison < 0) {
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
        } else if (timestampComparison === 0) {
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
          ["cancelled", "expired"].includes(
            existingSetup.setup_state
          )
        ) {
          await writeAudit(client, {
            eventId: event_id,
            setupId: setup_id,
            correlationId,
            auditType: "terminal_state_immutable",
            reason:
              "Terminal setup state cannot be reversed automatically",
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
          await writeAudit(client, {
            eventId: event_id,
            setupId: setup_id,
            correlationId,
            auditType: "confirmed_state_protected",
            reason:
              "Potential event cannot downgrade a confirmed setup",
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
              ? body.reason.trim()
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

      await client.query(
        `UPDATE signal_events
         SET processing_status = 'processed',
             processed_at = NOW()
         WHERE event_id = $1`,
        [event_id]
      );

      // Queue notifications in the same transaction as the setup change.
      let notificationsQueued = 0;

      const notificationText = buildNotificationText(
        body,
        processingOutcome
      );

      if (notificationText) {
        const notificationResult = await client.query(
          `INSERT INTO notification_outbox (
             event_id,
             telegram_chat_id,
             payload
           )
           SELECT
             $1,
             users.chat_id,
             jsonb_build_object('text', $2::text)
           FROM subscriptions AS subs
           INNER JOIN telegram_users AS users
             ON users.telegram_user_id = subs.telegram_user_id
           WHERE subs.status = 'active'
           ON CONFLICT (event_id, telegram_chat_id)
           DO NOTHING
           RETURNING id`,
          [event_id, notificationText]
        );

        notificationsQueued = notificationResult.rowCount;
      }

      await client.query("COMMIT");
      transactionStarted = false;

      return res.status(202).json({
        status: "event_processed",
        event_id,
        processingOutcome,
        notificationsQueued,
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