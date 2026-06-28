-- Mandatory MFA enrollment. `mfa_required=1` forces a user to enable TOTP MFA
-- (the engine + endpoints already exist) before they can perform any gated write
-- — reads stay allowed. Targeted per-user (default 0) so it applies only to the
-- accounts we flag, not every privileged user. The 4 provisioned SUMINISTROS
-- operators are required to enroll.
ALTER TABLE users ADD COLUMN mfa_required INTEGER NOT NULL DEFAULT 0;

UPDATE users SET mfa_required = 1
 WHERE email IN (
   'almacen@sismo911.com',
   'inventario@sismo911.com',
   'despacho@sismo911.com',
   'compras@sismo911.com'
 );
