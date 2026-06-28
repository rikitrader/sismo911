-- Social login (OAuth). Links a federated identity to a user and records whether
-- the provider asserted a verified email (Google does). Additive; password users
-- are unaffected (oauth_provider stays NULL).
ALTER TABLE users ADD COLUMN oauth_provider TEXT;                          -- google | (future: facebook/apple)
ALTER TABLE users ADD COLUMN oauth_sub TEXT;                              -- provider's stable subject id
ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;   -- 1 when a provider verified the email
