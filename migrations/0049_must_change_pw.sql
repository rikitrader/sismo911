-- Forced password rotation. `must_change_pw=1` blocks the user from performing
-- any gated write (operator/admin actions) until they set a new password via
-- POST /api/auth/change-password. Reads stay allowed. New column, default 0 so
-- existing accounts are unaffected; the 4 provisioned SUMINISTROS operators are
-- flagged so they must rotate their temporary password on first login.
ALTER TABLE users ADD COLUMN must_change_pw INTEGER NOT NULL DEFAULT 0;

UPDATE users SET must_change_pw = 1
 WHERE email IN (
   'almacen@sismo911.com',
   'inventario@sismo911.com',
   'despacho@sismo911.com',
   'compras@sismo911.com'
 );
