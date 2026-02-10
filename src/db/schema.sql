-- Multi-tenant schema (Postgres)

CREATE TABLE IF NOT EXISTS tenants (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    subdomain TEXT UNIQUE,
    api_key TEXT UNIQUE,
    api_key_last_used_at TIMESTAMPTZ,
    api_key_last_used_ip TEXT,
    allowed_origins TEXT[] DEFAULT ARRAY[]::TEXT[],
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_settings (
    tenant_id BIGINT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
    dify_url TEXT NOT NULL,
    dify_api_key TEXT NOT NULL,
    dify_agent_id TEXT,
    dify_instructions TEXT,
    dify_inputs JSONB,
    model_config JSONB,
    shopware_url TEXT NOT NULL,
    shopware_access_key TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tenant_shops (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    shop_id TEXT NOT NULL,
    name TEXT,
    shopware_url TEXT NOT NULL,
    shopware_access_key TEXT NOT NULL,
    dify_url TEXT,
    dify_api_key TEXT,
    dify_agent_id TEXT,
    dify_instructions TEXT,
    dify_inputs JSONB,
    model_config JSONB,
    allowed_origins TEXT[] DEFAULT ARRAY[]::TEXT[],
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, shop_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_shops_tenant
    ON tenant_shops (tenant_id);

CREATE INDEX IF NOT EXISTS idx_tenant_shops_origins
    ON tenant_shops USING GIN (allowed_origins);

CREATE TABLE IF NOT EXISTS analytics_events (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    api_key TEXT,
    session_id TEXT,
    timestamp BIGINT,
    server_timestamp BIGINT NOT NULL,
    question TEXT,
    length INTEGER,
    response_time INTEGER,
    time_to_first_chunk INTEGER,
    action TEXT,
    data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_analytics_events_tenant_ts
    ON analytics_events (tenant_id, server_timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_analytics_events_type
    ON analytics_events (event_type);

CREATE INDEX IF NOT EXISTS idx_analytics_events_session
    ON analytics_events (session_id);

CREATE TABLE IF NOT EXISTS api_key_usage (
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    api_key TEXT NOT NULL,
    tokens_used BIGINT NOT NULL DEFAULT 0,
    request_count BIGINT NOT NULL DEFAULT 0,
    last_used_at TIMESTAMPTZ,
    last_used_ip TEXT,
    PRIMARY KEY (tenant_id, api_key)
);

CREATE TABLE IF NOT EXISTS leads (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    session_id TEXT,
    name TEXT,
    email TEXT,
    phone TEXT,
    message TEXT,
    product_id TEXT,
    product_name TEXT,
    source TEXT,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_leads_tenant_created
    ON leads (tenant_id, created_at DESC);
