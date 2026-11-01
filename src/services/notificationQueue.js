
import { pool } from "../db.js";

const MAX_ERROR_LENGTH = 1000;

// Recover jobs abandoned by a crashed worker.
export async function recoverAbandonedNotifications() {
    const result = await pool.query(`
        UPDATE notification_outbox
        SET
            status = CASE
                WHEN attempts >= max_attempts THEN 'failed'
                ELSE 'pending'
            END,
            available_at = NOW(),
            locked_at = NULL,
            last_error = COALESCE(
                last_error,
                'Worker lease expired before completion'
            ),
            updated_at = NOW()
        WHERE
            status = 'processing'
            AND locked_at < NOW() - INTERVAL '2 minutes'
        RETURNING id, status
    `);

    return result.rows;
}

// Claim jobs safely. Multiple workers won't claim the same row.
export async function claimNotifications(limit = 5) {
    const result = await pool.query(
        `
        WITH candidates AS (
            SELECT id
            FROM notification_outbox
            WHERE
                status = 'pending'
                AND available_at <= NOW()
                AND attempts < max_attempts
            ORDER BY available_at ASC, id ASC
            FOR UPDATE SKIP LOCKED
            LIMIT $1
        )
        UPDATE notification_outbox AS notifications
        SET
            status = 'processing',
            locked_at = NOW(),
            attempts = notifications.attempts + 1,
            updated_at = NOW()
        FROM candidates
        WHERE notifications.id = candidates.id
        RETURNING notifications.*
        `,
        [limit]
    );

    return result.rows;
}

// Mark successful delivery.
export async function markNotificationSent(id) {
    const result = await pool.query(
        `
        UPDATE notification_outbox
        SET
            status = 'sent',
            sent_at = NOW(),
            locked_at = NULL,
            last_error = NULL,
            updated_at = NOW()
        WHERE id = $1 AND status = 'processing'
        RETURNING id
        `,
        [id]
    );

    return result.rowCount === 1;
}

// Record failure and schedule a retry.
export async function markNotificationFailed(
    id,
    attempts,
    maxAttempts,
    errorMessage
) {
    const error = String(errorMessage).slice(0, MAX_ERROR_LENGTH);
    const permanentlyFailed = attempts >= maxAttempts;

    // Exponential backoff: 5, 10, 20, 40 seconds...
    const retryDelaySeconds = Math.min(
        5 * 2 ** Math.max(attempts - 1, 0),
        900
    );

    const result = await pool.query(
        `
        UPDATE notification_outbox
        SET
            status = $2,
            available_at = CASE
                WHEN $2 = 'pending'
                    THEN NOW() + ($3 * INTERVAL '1 second')
                ELSE available_at
            END,
            locked_at = NULL,
            last_error = $4,
            updated_at = NOW()
        WHERE id = $1 AND status = 'processing'
        RETURNING id, status, available_at
        `,
        [
            id,
            permanentlyFailed ? "failed" : "pending",
            retryDelaySeconds,
            error,
        ]
    );

    return result.rows[0] ?? null;
}