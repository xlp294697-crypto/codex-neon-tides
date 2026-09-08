-- Business timestamps are UTC ISO 8601 strings; session timestamps are epoch milliseconds.
CREATE TABLE inquiries (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  status TEXT NOT NULL DEFAULT 'New' CHECK (status IN ('New', 'Contacted', 'Qualified', 'Won', 'Closed')),
  source TEXT NOT NULL DEFAULT '',
  parent_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  grade TEXT NOT NULL,
  course TEXT NOT NULL,
  concern TEXT NOT NULL DEFAULT '',
  preferred_time TEXT NOT NULL DEFAULT '',
  source_page TEXT NOT NULL DEFAULT '',
  source_section TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  analytics_attributed INTEGER NOT NULL DEFAULT 0 CHECK (analytics_attributed IN (0, 1)),
  privacy_notice_version TEXT NOT NULL,
  privacy_consent_at TEXT NOT NULL
) STRICT;

CREATE INDEX inquiries_created_at_idx ON inquiries (created_at);
CREATE INDEX inquiries_status_created_at_idx ON inquiries (status, created_at);

CREATE TABLE analytics_events (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('page_view', 'section_view', 'image_open', 'assessment_click', 'booking_success')),
  page TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  section TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  target_label TEXT NOT NULL DEFAULT '',
  referrer TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  medium TEXT NOT NULL DEFAULT '',
  campaign TEXT NOT NULL DEFAULT '',
  device TEXT NOT NULL DEFAULT '',
  analytics_consent_at TEXT NOT NULL,
  analytics_notice_version TEXT NOT NULL
) STRICT;

CREATE INDEX analytics_events_created_at_idx ON analytics_events (created_at);
CREATE INDEX analytics_events_type_created_at_idx ON analytics_events (event_type, created_at);

-- Only lowercase SHA-256 hex digests belong here, never cookie or CSRF bearer tokens.
CREATE TABLE admin_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  csrf_token_hash TEXT NOT NULL CHECK (length(csrf_token_hash) = 64 AND csrf_token_hash NOT GLOB '*[^0-9a-f]*'),
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role = 'admin'),
  created_at INTEGER NOT NULL CHECK (created_at >= 0),
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at)
) STRICT;

CREATE INDEX admin_sessions_expires_at_idx ON admin_sessions (expires_at);

-- inquiry_id deliberately has no foreign key: the audit entry survives deletion.
-- The payload allowlist holds only status enums; arbitrary personal fields are rejected.
CREATE TABLE audit_logs (
  id TEXT PRIMARY KEY NOT NULL,
  created_at TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('inquiry_status_changed', 'inquiry_deleted')),
  inquiry_id TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}' CHECK (
    CASE WHEN json_valid(payload) THEN
      json_type(payload) = 'object'
      AND json_remove(payload, '$.fromStatus', '$.toStatus') = '{}'
      AND (json_type(payload, '$.fromStatus') IS NULL OR
        (json_type(payload, '$.fromStatus') = 'text' AND json_extract(payload, '$.fromStatus') IN ('New', 'Contacted', 'Qualified', 'Won', 'Closed')))
      AND (json_type(payload, '$.toStatus') IS NULL OR
        (json_type(payload, '$.toStatus') = 'text' AND json_extract(payload, '$.toStatus') IN ('New', 'Contacted', 'Qualified', 'Won', 'Closed')))
    ELSE 0 END
  )
) STRICT;

CREATE INDEX audit_logs_created_at_idx ON audit_logs (created_at);
CREATE INDEX audit_logs_inquiry_created_at_idx ON audit_logs (inquiry_id, created_at);
