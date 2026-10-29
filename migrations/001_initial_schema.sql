BEGIN;

CREATE TABLE signal_events (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    setup_id TEXT,
    instrument TEXT,
    timeframe TEXT,
    bar_timestamp TIMESTAMPTZ,
    received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processing_status TEXT NOT NULL DEFAULT 'received'
        CHECK (processing_status IN (
            'received',
            'processed',
            'duplicate',
            'rejected',
            'failed'
        )),
    rejection_category TEXT,
    correlation_id UUID NOT NULL,
    schema_version TEXT,
    payload JSONB,
    processed_at TIMESTAMPTZ
);

CREATE INDEX idx_signal_events_received_at
    ON signal_events (received_at);

CREATE INDEX idx_signal_events_setup_id
    ON signal_events (setup_id);

CREATE TABLE setups (
    setup_id TEXT PRIMARY KEY,
    instrument TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    direction TEXT NOT NULL
        CHECK (direction IN ('long', 'short')),
    setup_state TEXT NOT NULL
        CHECK (setup_state IN (
            'potential',
            'confirmed',
            'cancelled',
            'expired'
        )),
    confidence_score INTEGER
        CHECK (confidence_score BETWEEN 0 AND 100),
    entry_price NUMERIC,
    stop_loss NUMERIC,
    targets JSONB NOT NULL DEFAULT '[]'::JSONB,
    last_event_id TEXT REFERENCES signal_events(event_id),
    last_source_timestamp TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    cancellation_reason TEXT
);

CREATE TABLE system_status (
    component TEXT PRIMARY KEY,
    status TEXT NOT NULL
        CHECK (status IN (
            'healthy',
            'stale',
            'unavailable',
            'degraded'
        )),
    last_heartbeat_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    details JSONB NOT NULL DEFAULT '{}'::JSONB,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;