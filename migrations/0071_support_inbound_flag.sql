-- 0071_support_inbound_flag.sql — persisted toggle for inbound support email.
-- The Worker email() handler threads inbound replies onto tickets ONLY when this
-- flag is ON. It is seeded OFF (fail-closed): inbound stays inert until an
-- operator both flips this toggle (Soporte console) AND the Cloudflare Email
-- Routing rule (soporte@ → Worker) is in place. Reuses the existing feature_flags
-- base table (module_key='support_inbound_email') so it also surfaces in the
-- global Feature Flags console. Idempotent: INSERT OR IGNORE never clobbers an
-- operator's later choice on re-run.
INSERT OR IGNORE INTO feature_flags (org_id, module_key, enabled, updated_by, updated_ms)
VALUES ('org_sismo911', 'support_inbound_email', 0, NULL, NULL);
