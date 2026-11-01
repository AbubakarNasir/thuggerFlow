CREATE TABLE telegram_users (
    telegram_user_id BIGINT PRIMARY KEY,
    chat_id BIGINT NOT NULL UNIQUE,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE subscriptions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

    telegram_user_id BIGINT NOT NULL
        REFERENCES telegram_users(telegram_user_id)
        ON DELETE CASCADE,

    status TEXT NOT NULL DEFAULT 'inactive'
        CHECK (status IN ('active', 'inactive')),

    subscribed_at TIMESTAMPTZ,
    unsubscribed_at TIMESTAMPTZ,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT subscriptions_one_per_user
        UNIQUE (telegram_user_id)
);

CREATE INDEX idx_subscriptions_active
ON subscriptions (telegram_user_id)
WHERE status = 'active';