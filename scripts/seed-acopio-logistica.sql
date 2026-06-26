-- Starter inventory + needs for the acopio logistics command center so the
-- dashboard, matching engine and network map show live data on first load.
-- Idempotent: inventory uses ON CONFLICT; needs are guarded by fixed ids.
-- center_id values are REAL catalog ids from public/acopio-data.json.
-- Apply: wrangler d1 execute sismo911 --remote --file=./scripts/seed-acopio-logistica.sql
--   (run from a checkout WITHOUT .env so the OAuth session is used)

-- ── Inventory (surplus hubs) ────────────────────────────────────────────────
INSERT INTO acopio_inventory (center_id, commodity, qty, unit, updated_ms) VALUES
  ('universidad-central-de-venezuela-ucv-distrito-capital','agua',12000,'l',1751000000000),
  ('universidad-central-de-venezuela-ucv-distrito-capital','alimentos',800,'caja',1751000000000),
  ('universidad-central-de-venezuela-ucv-distrito-capital','medicinas',300,'caja',1751000000000),
  ('universidad-central-de-venezuela-ucv-distrito-capital','higiene',500,'kit',1751000000000),
  ('universidad-de-carabobo-uc-carabobo','agua',6000,'l',1751000000000),
  ('universidad-de-carabobo-uc-carabobo','abrigo',400,'u',1751000000000),
  ('universidad-de-carabobo-uc-carabobo','infantil',200,'kit',1751000000000),
  ('universidad-centroccidental-lisandro-alv-lara','alimentos',500,'caja',1751000000000),
  ('universidad-centroccidental-lisandro-alv-lara','energia',150,'u',1751000000000),
  ('estadio-cte-cachamay-bolivar','agua',4000,'l',1751000000000),
  ('estadio-cte-cachamay-bolivar','logistica',60,'u',1751000000000)
ON CONFLICT(center_id, commodity) DO UPDATE SET qty=excluded.qty, unit=excluded.unit, updated_ms=excluded.updated_ms;

-- ── Open needs (demand at other hubs) ───────────────────────────────────────
INSERT OR REPLACE INTO acopio_needs (id, center_id, commodity, qty, priority, status, note, created_ms, updated_ms) VALUES
  ('nee_seed_luz_agua','universidad-del-zulia-luz-zulia','agua',3000,1,'open','Zona afectada — agua potable urgente',1751000000000,1751000000000),
  ('nee_seed_luz_med','universidad-del-zulia-luz-zulia','medicinas',120,1,'open','Insumos médicos básicos',1751000000000,1751000000000),
  ('nee_seed_ula_abrigo','universidad-de-los-andes-ula-merida','abrigo',250,2,'open','Refugio temporal montaña',1751000000000,1751000000000),
  ('nee_seed_unet_alim','universidad-nacional-experimental-del-ta-tachira','alimentos',300,2,'open','Comedor de emergencia',1751000000000,1751000000000),
  ('nee_seed_udo_higiene','universidad-de-oriente-udo-nucleo-anzoat-anzoategui','higiene',180,3,'open','Kits de higiene',1751000000000,1751000000000);
