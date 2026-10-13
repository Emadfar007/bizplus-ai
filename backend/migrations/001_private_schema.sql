CREATE SCHEMA IF NOT EXISTS bizplus;
REVOKE ALL ON SCHEMA bizplus FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA bizplus REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA bizplus REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA bizplus REVOKE ALL ON FUNCTIONS FROM PUBLIC;

CREATE TABLE IF NOT EXISTS bizplus.runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_session ON bizplus.runs(session_id,created_at DESC);
CREATE TABLE IF NOT EXISTS bizplus.incidents (
  id TEXT PRIMARY KEY, run_id TEXT UNIQUE NOT NULL REFERENCES bizplus.runs(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL, fingerprint TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS incidents_session ON bizplus.incidents(session_id,created_at DESC);
CREATE INDEX IF NOT EXISTS incidents_fingerprint ON bizplus.incidents(session_id,fingerprint);
CREATE TABLE IF NOT EXISTS bizplus.payments (
  transaction_id TEXT PRIMARY KEY, order_id TEXT UNIQUE NOT NULL,
  run_id TEXT UNIQUE NOT NULL REFERENCES bizplus.runs(id) ON DELETE CASCADE,
  idempotency_key TEXT UNIQUE NOT NULL, amount_minor INTEGER NOT NULL CHECK(amount_minor>0)
);
CREATE TABLE IF NOT EXISTS bizplus.orders (
  id TEXT PRIMARY KEY, run_id TEXT UNIQUE NOT NULL REFERENCES bizplus.runs(id) ON DELETE CASCADE,
  transaction_id TEXT UNIQUE NOT NULL REFERENCES bizplus.payments(transaction_id) ON DELETE CASCADE,
  amount_minor INTEGER NOT NULL, confirmed INTEGER NOT NULL DEFAULT 0 CHECK(confirmed IN (0,1))
);
CREATE TABLE IF NOT EXISTS bizplus.receipt_jobs (
  order_id TEXT PRIMARY KEY REFERENCES bizplus.orders(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('paused','complete'))
);
CREATE TABLE IF NOT EXISTS bizplus.confirmations (
  order_id TEXT PRIMARY KEY REFERENCES bizplus.orders(id) ON DELETE CASCADE, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bizplus.logs (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES bizplus.runs(id) ON DELETE CASCADE,
  timestamp TEXT NOT NULL, message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_run ON bizplus.logs(run_id,timestamp);
CREATE TABLE IF NOT EXISTS bizplus.commerce_orders (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, checkout_key TEXT NOT NULL, status TEXT NOT NULL,
  razorpay_order_id TEXT UNIQUE, razorpay_payment_id TEXT UNIQUE,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, data JSONB NOT NULL,
  UNIQUE(session_id,checkout_key)
);
CREATE INDEX IF NOT EXISTS commerce_orders_session ON bizplus.commerce_orders(session_id,created_at DESC);
CREATE TABLE IF NOT EXISTS bizplus.live_runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL,
  created_at TEXT NOT NULL, data JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS live_runs_session ON bizplus.live_runs(session_id,created_at DESC);

ALTER TABLE bizplus.runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bizplus.incidents ENABLE ROW LEVEL SECURITY;
ALTER TABLE bizplus.payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE bizplus.orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE bizplus.receipt_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bizplus.confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE bizplus.logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE bizplus.commerce_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE bizplus.live_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON ALL TABLES IN SCHEMA bizplus FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA bizplus FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA bizplus FROM PUBLIC;
DO $privacy$
DECLARE restricted_role TEXT;
BEGIN
  FOREACH restricted_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=restricted_role) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA bizplus FROM %I',restricted_role);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA bizplus FROM %I',restricted_role);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA bizplus FROM %I',restricted_role);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA bizplus FROM %I',restricted_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA bizplus REVOKE ALL ON TABLES FROM %I',restricted_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA bizplus REVOKE ALL ON SEQUENCES FROM %I',restricted_role);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA bizplus REVOKE ALL ON FUNCTIONS FROM %I',restricted_role);
    END IF;
  END LOOP;
END $privacy$;
