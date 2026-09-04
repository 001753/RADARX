CREATE TABLE IF NOT EXISTS tokens (
  token_address TEXT PRIMARY KEY,
  name TEXT,
  symbol TEXT,
  creator_address TEXT,
  metadata_hash TEXT,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  lifecycle TEXT NOT NULL DEFAULT 'NEW',
  last_source TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pairs (
  pair_address TEXT PRIMARY KEY,
  token_address TEXT NOT NULL REFERENCES tokens(token_address) ON DELETE CASCADE,
  dex_id TEXT,
  pool_type TEXT,
  quote_symbol TEXT,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS raw_source_observations (
  id BIGSERIAL PRIMARY KEY,
  token_address TEXT NOT NULL REFERENCES tokens(token_address) ON DELETE CASCADE,
  source TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL,
  payload JSONB,
  payload_hash TEXT,
  error_message TEXT,
  schema_version TEXT NOT NULL DEFAULT '1'
);

CREATE TABLE IF NOT EXISTS market_snapshots (
  id BIGSERIAL PRIMARY KEY,
  token_address TEXT NOT NULL REFERENCES tokens(token_address) ON DELETE CASCADE,
  pair_address TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  price_usd NUMERIC,
  liquidity_usd NUMERIC,
  volume_5m NUMERIC,
  volume_1h NUMERIC,
  volume_6h NUMERIC,
  volume_24h NUMERIC,
  buy_tx_1h INTEGER,
  sell_tx_1h INTEGER,
  price_return_30m NUMERIC,
  liquidity_return_30m NUMERIC,
  data_quality JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS holder_snapshots (
  id BIGSERIAL PRIMARY KEY,
  token_address TEXT NOT NULL REFERENCES tokens(token_address) ON DELETE CASCADE,
  observed_at TIMESTAMPTZ NOT NULL,
  holder_count INTEGER,
  distribution JSONB,
  gini NUMERIC,
  retention NUMERIC,
  data_quality JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS gate_decisions (
  id BIGSERIAL PRIMARY KEY,
  token_address TEXT NOT NULL REFERENCES tokens(token_address) ON DELETE CASCADE,
  pair_address TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  gate_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'reject', 'unknown')),
  reason_code TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  threshold_version TEXT NOT NULL DEFAULT 'gate-v1.2',
  model_version TEXT NOT NULL DEFAULT 'radar-v1.2.0'
);

CREATE TABLE IF NOT EXISTS score_snapshots (
  id BIGSERIAL PRIMARY KEY,
  token_address TEXT NOT NULL REFERENCES tokens(token_address) ON DELETE CASCADE,
  pair_address TEXT,
  observed_at TIMESTAMPTZ NOT NULL,
  lifecycle TEXT NOT NULL,
  market_regime TEXT NOT NULL,
  momentum_score NUMERIC,
  holder_health_score NUMERIC,
  flow_quality_score NUMERIC,
  liquidity_quality_score NUMERIC,
  raw_score NUMERIC,
  signal_score NUMERIC,
  evidence_confidence NUMERIC,
  priority_score NUMERIC,
  label TEXT NOT NULL,
  score_status TEXT NOT NULL,
  active_weights JSONB NOT NULL DEFAULT '{}'::jsonb,
  penalties JSONB NOT NULL DEFAULT '{}'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  cohort_size INTEGER NOT NULL DEFAULT 0,
  model_version TEXT NOT NULL DEFAULT 'radar-v1.2.0'
);

CREATE TABLE IF NOT EXISTS alert_events (
  id BIGSERIAL PRIMARY KEY,
  token_address TEXT NOT NULL REFERENCES tokens(token_address) ON DELETE CASCADE,
  pair_address TEXT,
  alert_type TEXT NOT NULL,
  alert_at TIMESTAMPTZ NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'paper',
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS watchlist (
  token_address TEXT PRIMARY KEY REFERENCES tokens(token_address) ON DELETE CASCADE,
  pair_address TEXT,
  first_alert_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_refresh_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  last_final_score NUMERIC,
  last_label TEXT,
  last_evidence JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS outcome_labels (
  id BIGSERIAL PRIMARY KEY,
  alert_event_id BIGINT REFERENCES alert_events(id) ON DELETE CASCADE,
  horizon TEXT NOT NULL,
  label TEXT,
  return_path JSONB,
  mfe NUMERIC,
  mae NUMERIC,
  liquidity_path JSONB,
  labeled_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS scan_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  mode TEXT NOT NULL,
  candidates_seen INTEGER NOT NULL DEFAULT 0,
  observations_saved INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  rejected INTEGER NOT NULL DEFAULT 0,
  unknown INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  summary JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS provider_health (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  checked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL,
  latency_ms INTEGER,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_market_token_time ON market_snapshots(token_address, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_gates_token_time ON gate_decisions(token_address, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_scores_priority ON score_snapshots(priority_score DESC, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_scores_label ON score_snapshots(label, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_raw_token_time ON raw_source_observations(token_address, observed_at DESC);