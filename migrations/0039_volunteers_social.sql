-- Social profiles for volunteers (Instagram, Facebook, X, TikTok, Telegram,
-- WhatsApp, web). Stored as a JSON object {platform: canonical_url}. Submitted via
-- the intake form; RAV-sourced volunteers get theirs extracted from free text at
-- read time. Public by nature (meant to be shared), so not masked like phone/email.
ALTER TABLE volunteers ADD COLUMN social TEXT;
