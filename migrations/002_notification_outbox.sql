CREATE TABLE notification_outbox (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    event_id TEXT NOT NULL
        REFERENCES signal_events(event_id)
        ON DELETE RESTRICT,

    telegram_chat_id BIGINT NOT NULL,

    payload JSONB NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (
            status IN (
                'pending',
                'processing',
                'sent',
                'failed'
            )
        ),

    attempts INTEGER NOT NULL DEFAULT 0
        CHECK (attempts >= 0),

    max_attempts INTEGER NOT NULL DEFAULT 5
        CHECK (max_attempts > 0),

    available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    locked_at TIMESTAMPTZ,

    sent_at TIMESTAMPTZ,

    last_error TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT notification_outbox_unique_recipient
        UNIQUE (event_id, telegram_chat_id)
);


-- Efficiently find notifications ready for delivery
CREATE INDEX idx_outbox_pending
ON notification_outbox (available_at, id)
WHERE status = 'pending';


-- Find abandoned processing jobs
CREATE INDEX idx_outbox_processing
ON notification_outbox (locked_at)
WHERE status = 'processing';


-- Inspect a recipient's notification history
CREATE INDEX idx_outbox_chat_history
ON notification_outbox (telegram_chat_id, created_at DESC);