# SISMO911 — Discovery Report

Generated: 2026-07-06T01:40:27.250Z

## Stack
- Framework: Cloudflare Workers + Hono ^4.6.14 (single Worker: static assets + /api/*)
- Database: Cloudflare D1 (SQLite) via env.DB — no ORM, prepared statements
- Storage: KV (SESSIONS/CACHE), R2 (fotos/evidence), Workers AI, Vectorize
- Tests: Vitest (141 files) · CI: verify + security + secret-scan + gitleaks

## API surface
- 694 concrete /api routes across 103 mounts (authoritative: Hono route table; classified by src/rbac/route-policy.ts, default-deny enforced by test/api-route-coverage.test.ts)
- Gates: open=406 · perm:acopio:manage=9 · perm:persons:moderate=72 · perm:admin:maintenance=18 · perm:flota:track=9 · perm:aid_orgs:manage=3 · perm:damage:moderate=7 · perm:contacts:manage=1 · perm:emergencia:manage=5 · perm:events:refresh=1 · perm:flota:read=13 · perm:flota:dispatch=19 · perm:ninez:manage=6 · login=1 · perm:refugios:manage=5 · perm:reports:moderate=3 · perm:resources:manage=1 · perm:sat:analyze=2 · perm:shelters:manage=1 · perm:sos:triage=2 · perm:suministros:read=46 · perm:suministros:manage=13 · perm:suministros:inventory=8 · perm:suministros:purchasing=22 · perm:suministros:dispatch=15 · perm:suministros:warehouse=6

## Cron / scheduled work
- 5 wrangler cron triggers → CRON_GROUPS in src/cron.ts · 50 named jobs
- Jobs: usgs, funvisis, kobo, quake-announce, sos-damage, case-score-sweep, hospital-registry-sync, sos-sheet, telemed-reminders, familia-ingest, personas-clean, personas-name-floods, search-index-backfill, personas-dedupe-exact, personas-dedupe-photo, personas-dedupe-extid, personas-purge-rejected, hospital-match, hospital-registry-match, civis-edificaciones, tv-building-cases, familia-photo-mirror, monitor-sheet, hospital-sheet, cases-sheet-sync, case-alerts, personas-dedupe-fuzzyphone, personas-phash-backfill-30, bulk-import-sweep, tv-buildings, civis-atendidos, civis-desaparecidos, social-monitor, blog, casualties, rav-photos, personas-phash-backfill, personas-dedupe-phash, personas-dedupe-dhash, botcommands-sync, history-bootstrap, rav-ingest, pacientes-rvz, rav-stats, rav-verified, rav-reports-safe, rav-reports-dedupe-extid, personas-phash-backfill-05, sismos-bot-broadcast, civis-extras

## Ingest scripts (src/ingest/)
- blog-cron.ts, blog-sources.ts, case-alerts.ts, casualty-cron.ts, casualty-gate.ts, civis-atendidos.ts, civis-desaparecidos.ts, civis-edificaciones.ts, civis-extras.ts, familia-cron.ts, funvisis-cron.ts, gate-config.ts, hospital-match.ts, hospital-registry-match.ts, hospital-registry-sync.ts, kobo-cron.ts, pacientes-rvz-cron.ts, quake-announce.ts, rav-cron.ts, rav-photos.ts, social-monitor.ts, sos-damage.ts, telemed-reminders.ts, tv-buildings-cron.ts, usgs-cron.ts, usgs-history.ts

## Migrations
- 133 files, 0001_init.sql … seed_suministros.sql

## D1 tables referenced by routes (static scan)
- a, acopio_custody, acopio_inventory, acopio_inventory_lots, acopio_needs, acopio_shipments, acopio_status, acopio_submissions, agent_activity, aggregate, aid_orgs, alianza_solicitudes, an, any, api_clients, applies, approval_requests, assembled, audit, being, both, building_cases, building_docs, building_eval_events, building_profile, built, bulk_import_jobs, campaigns, case, case_attachments, case_identity, case_intel, case_messages, case_meta, case_tasks, case_victims, casualty_reports, casualty_sources, cf, chat_messages, checkins, civis_stats_snapshots, comms_channels, contacts, conteo, crossmint, current, d1, damage_reports, desap_fotos, donaciones, donations, dup_cluster, email_verifications, emergency_photos, emergency_profiles, events, evidence_annotations, evidence_chain_of_custody, evidence_comments, evidence_share_links, familia_source_url, feature_flags, fetchcasereports, fields, flota_dispatches, flota_flota_unidades, flota_flotas, flota_locations, flota_mision_actividad, flota_mision_waypoints, flota_misiones, flota_personal, flota_posiciones, flota_unidades, flota_unit_tokens, flota_units, google, guardianes_mensajes, hospital_matches, hospital_patients, index, ingest_log, intake_submissions, invitations, json, kit, kv, lines, lockout, login_history, map_reports, metadata, multipart, mutable, notifications, official_stats, one, origen, our, paid, panorama_balance, passes, password_resets, payurlfor, person_events, personas, persons, platform, press, proposal, proposed, public, public_base_url, r2, rav_reports, rbac_roles, records, refugios_assignments, refugios_site_capabilities, refugios_site_needs, refugios_site_population, refugios_sites, refugios_zones, registers, report_comments, resources, reusing, row, sat_damage, sat_edificaciones, satellite, sectors, security_events, sessions, settings_json, shelter_status, sismo911, site, social_signals, sos_alerts, sos_damage, stock, stripe_accounts, stripe_payments, sum_categorias, sum_citizen_enrollments, sum_citizen_requests, sum_conteo_lineas, sum_conteos, sum_cuentas, sum_donacion_lineas, sum_donaciones, sum_envio_contenedores, sum_envio_lineas, sum_envios, sum_existencias, sum_factura_lineas, sum_facturas, sum_items, sum_kit_lineas, sum_kits, sum_metodos_envio, sum_orden_lineas, sum_ordenes, sum_picklist_lineas, sum_picklists, sum_producto_proveedor, sum_productos, sum_proveedores, sum_requisicion_lineas, sum_requisiciones, sum_transaccion_lineas, sum_transacciones, sum_ubicaciones, suministros, support_messages, support_tickets, telemed_doctors, telemed_requests, text, the, their, this, title, tv_buildings, two, user_roles, users, usgs, verified, volunteers, withdrawal_methods, withdrawal_requests, x402_payments, x402_resource_prices, x402_resources

## Duplicate-prone tables (identity-bearing; targets for the dedupe pipeline)
- personas
- hospital_patients
- casualties
- case_intel
- intake_submissions
- contacts
- edificios_personas

## Risk areas
- personas (~132k rows): bulk importers historically skipped name_norm (fixed PR #627) — dedupe blind spots recur when a new write path forgets computeSearchFields.
- External ingests (CIVIS/RAV/social) are UPSERT-keyed per-source but have no cross-source identity contract → cross-source duplicates accumulate between dedupe passes.
- Cron subrequest budget (~1000/invocation): any new job must join an existing CRON_GROUP with bounded fan-out.
- OCR intake: artifacts now flagged (ocr-normalize, PR #648) but historical rows before 2026-07-05 are untagged.

## Missing / weak (feeds the plan increments)
- No DB schema map artifact (Increment 2), no pre-ingest gate (4), no cross-source scoring dedupe (3), no data-quality endpoint (7).
- Live probe covers public GETs only; gated routes are exercised by the Vitest suite, not by this audit.

## Recommended execution order
- Map DB (2) → dedupe engine + tables (3) → clean existing duplicates all tables (5) → pre-ingest gate + adapters (4) → consolidated ingest cron + hourly dedupe (6/6b) → data-quality endpoint (7).
