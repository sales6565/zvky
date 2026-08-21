-- Run this only if you already ran the original schema.sql and have live data.
-- Fresh installs should just use schema.sql directly — this file is redundant then.

BEGIN;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('super_admin','admin','team_lead','coordinator','artist','creative_director'));

ALTER TABLE assets ADD COLUMN IF NOT EXISTS man_hours NUMERIC(6,1);

ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_status_check;
-- Map old statuses onto the new pipeline before adding the stricter check.
UPDATE assets SET status = 'pending_tl_review' WHERE status = 'in_review';
UPDATE assets SET status = 'approved_for_client' WHERE status = 'approved';
UPDATE assets SET status = 'delivered' WHERE status = 'final';
ALTER TABLE assets ADD CONSTRAINT assets_status_check
  CHECK (status IN (
    'not_started','in_progress','pending_tl_review','tl_changes_requested',
    'pending_cd_review','cd_changes_requested','approved_for_client','delivered'
  ));

CREATE TABLE IF NOT EXISTS asset_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  version_number INT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('tl','cd')),
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INT,
  uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  version_id UUID REFERENCES asset_versions(id) ON DELETE SET NULL,
  stage TEXT NOT NULL CHECK (stage IN ('tl','cd')),
  decision TEXT NOT NULL CHECK (decision IN ('approved','changes_requested')),
  given_by UUID REFERENCES users(id) ON DELETE SET NULL,
  text TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);
CREATE INDEX IF NOT EXISTS idx_versions_asset ON asset_versions(asset_id);
CREATE INDEX IF NOT EXISTS idx_feedback_asset ON feedback(asset_id);

COMMIT;
