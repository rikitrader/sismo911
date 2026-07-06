# SISMO911 — D1 Database Map

Generated: 2026-07-06T01:47:12.489Z · REMOTE · 182 tables · 432,367 rows

## Tables (by row count)

| table | rows | PK | PII cols | dup-key cols | source cols | ingest |
|---|---|---|---|---|---|---|
| personas | 133,601 | id | 13 | ext_id photo_phash photo_dhash name_norm | origen | **BLOCKED** |
| personas_merge_log | 86,634 | — | 0 | — | — | safe |
| case_meta | 78,965 | person_id | 0 | — | — | safe |
| rav_reports | 42,734 | id | 3 | ext_id | origen | **BLOCKED** |
| rate_buckets | 18,078 | key | 0 | — | — | safe |
| building_cases | 15,322 | building_id+case_id | 1 | — | source | safe |
| hospital_patients | 13,201 | id | 7 | dedupe_key norm_name cedula telefono | source | **BLOCKED** |
| events | 10,515 | id | 0 | — | source | safe |
| hospital_patients_dupes | 9,532 | id | 6 | dedupe_key norm_name cedula telefono | source | **BLOCKED** |
| person_events | 4,509 | id | 0 | — | source | safe |
| hospital_matches | 3,078 | person_id+report_id | 1 | — | — | safe |
| sos_damage | 2,098 | id | 0 | — | source_url | safe |
| civis_puntos | 1,807 | id | 2 | — | source | **BLOCKED** |
| rav_safe_reports | 1,401 | id | 2 | — | origen | **BLOCKED** |
| agent_activity | 1,301 | id | 0 | — | source | safe |
| dup_cluster | 1,233 | cluster_id+persona_id | 0 | — | — | safe |
| social_signals | 1,106 | id | 0 | — | — | safe |
| audit | 990 | id | 0 | — | — | safe |
| sat_edificaciones | 975 | id | 0 | — | source | safe |
| tv_buildings | 936 | id | 3 | — | — | **BLOCKED** |
| persons | 439 | id | 4 | name_norm | — | **BLOCKED** |
| map_reports | 433 | id | 0 | ext_id | source | safe |
| blog_posts | 365 | id | 0 | — | source_url | safe |
| verified_info | 351 | id | 0 | — | origen | safe |
| role_permissions | 336 | role_id+perm_key | 0 | — | — | safe |
| csp_reports | 278 | sig | 0 | — | — | safe |
| aid_orgs | 221 | id | 2 | phone email | — | **BLOCKED** |
| sessions | 164 | token | 0 | — | — | **BLOCKED** |
| sum_productos | 154 | id | 1 | — | — | safe |
| d1_migrations | 133 | id | 1 | — | — | safe |
| users | 122 | id | 8 | email phone | — | **BLOCKED** |
| rbac_permissions | 118 | key | 0 | — | — | safe |
| login_history | 111 | id | 1 | email | — | safe |
| telemed_availability | 101 | id | 0 | — | — | safe |
| ingest_dedupe | 96 | hash | 1 | — | — | safe |
| user_roles | 86 | user_id+role_id | 0 | — | — | safe |
| civis_stats_snapshots | 84 | id | 0 | — | — | safe |
| clean_ingestions | 79 | id | 1 | — | — | safe |
| casualty_reports | 50 | id | 0 | — | — | safe |
| feature_flags | 41 | org_id+module_key | 0 | — | — | safe |
| case_subscriptions | 34 | id | 1 | email | — | safe |
| sum_existencias | 30 | ubicacion_id+item_id | 0 | — | — | safe |
| email_verifications | 28 | id | 0 | — | — | safe |
| case_alert_state | 26 | case_id | 0 | — | — | safe |
| rbac_roles | 26 | id | 1 | — | — | safe |
| building_eval_events | 25 | id | 2 | — | — | **BLOCKED** |
| push_subs | 22 | id | 0 | — | — | safe |
| case_attachments | 21 | id | 1 | — | source | safe |
| refugios_site_capabilities | 20 | site_id+capability_key | 0 | — | source | safe |
| sum_categorias | 20 | id | 1 | — | — | safe |
| telemed_doctor_prefs | 20 | doctor_id | 0 | — | — | safe |
| telemed_doctors | 20 | id | 2 | email phone | — | **BLOCKED** |
| ingest_log | 19 | source | 0 | — | source | safe |
| refugios_sites | 18 | id | 1 | — | — | safe |
| volunteers | 17 | id | 3 | email | — | **BLOCKED** |
| sos_alerts | 16 | id | 2 | phone | — | **BLOCKED** |
| sum_items | 15 | id | 0 | — | — | safe |
| checkins | 14 | id | 1 | — | — | safe |
| acopio_inventory | 11 | center_id+commodity | 0 | — | — | safe |
| refugios_zones | 11 | id | 1 | — | — | safe |
| casualty_sources | 10 | source_key | 1 | — | — | safe |
| chat_messages | 10 | id | 1 | — | channel | safe |
| contacts | 10 | id | 3 | phone email | source | **BLOCKED** |
| case_intel | 9 | id | 0 | — | source | **BLOCKED** |
| api_request_log | 7 | id | 0 | — | — | safe |
| comms_channels | 7 | id | 1 | — | — | safe |
| departments | 7 | id | 1 | — | — | safe |
| intake_submissions | 7 | id | 1 | — | channel | **BLOCKED** |
| api_clients | 6 | id | 0 | — | — | safe |
| rejected_ingestions | 6 | id | 1 | — | — | safe |
| acopio_needs | 5 | id | 0 | — | — | safe |
| field_policies | 5 | id | 0 | — | — | safe |
| sum_ubicaciones | 5 | id | 3 | telefono | — | **BLOCKED** |
| flota_units | 4 | id | 1 | — | — | safe |
| notifications | 4 | id | 0 | — | — | safe |
| sum_cuentas | 4 | id | 1 | — | — | safe |
| sum_producto_proveedor | 4 | id | 0 | — | — | safe |
| telemed_appt_status | 4 | id | 0 | — | — | safe |
| password_resets | 3 | id | 0 | — | — | safe |
| resources | 3 | id | 0 | — | — | safe |
| sum_donacion_lineas | 3 | id | 0 | — | — | safe |
| sum_proveedores | 3 | id | 5 | telefono email | — | **BLOCKED** |
| x402_resources | 3 | id | 2 | — | — | **BLOCKED** |
| alianza_solicitudes | 2 | id | 3 | email telefono | — | **BLOCKED** |
| damage_reports | 2 | id | 1 | — | — | safe |
| patient_case_events | 2 | id | 0 | — | — | safe |
| patient_cases | 2 | id | 0 | — | — | safe |
| patients | 2 | id | 5 | cedula email phone | — | **BLOCKED** |
| sismos_bot_subs | 2 | chat_id | 0 | — | — | safe |
| sum_conteo_lineas | 2 | id | 0 | — | — | safe |
| sum_donaciones | 2 | id | 0 | — | — | safe |
| sum_envio_lineas | 2 | id | 0 | — | — | safe |
| sum_metodos_envio | 2 | id | 1 | — | — | safe |
| sum_orden_lineas | 2 | id | 0 | — | — | safe |
| sum_ordenes | 2 | id | 0 | — | — | safe |
| sum_picklist_lineas | 2 | id | 0 | — | — | safe |
| telemed_appointments | 2 | id | 5 | — | — | **BLOCKED** |
| bulk_import_jobs | 1 | id | 1 | — | source | safe |
| campaigns | 1 | id | 1 | — | — | safe |
| emergency_profiles | 1 | id | 2 | — | — | **BLOCKED** |
| guardianes_mensajes | 1 | id | 3 | email telefono | — | **BLOCKED** |
| hospital_match_state | 1 | id | 0 | — | — | safe |
| official_stats | 1 | id | 0 | — | source origen | safe |
| organizations | 1 | id | 1 | — | — | safe |
| sat_damage | 1 | id | 0 | — | — | safe |
| sum_conteos | 1 | id | 0 | — | — | safe |
| sum_envio_contenedores | 1 | id | 0 | — | — | safe |
| sum_envios | 1 | id | 0 | — | — | safe |
| sum_factura_lineas | 1 | id | 0 | — | — | safe |
| sum_facturas | 1 | id | 0 | — | — | safe |
| sum_picklists | 1 | id | 0 | — | — | safe |
| sum_transaccion_lineas | 1 | id | 0 | — | — | safe |
| sum_transacciones | 1 | id | 0 | — | — | safe |
| support_messages | 1 | id | 1 | — | — | safe |
| support_tickets | 1 | id | 2 | email | — | **BLOCKED** |
| x402_resource_prices | 1 | id | 0 | — | — | safe |
| acopio_custody | 0 | id | 0 | — | — | safe |
| acopio_inventory_lots | 0 | id | 0 | — | source | safe |
| acopio_shipment_items | 0 | shipment_id+commodity | 0 | — | — | safe |
| acopio_shipments | 0 | id | 0 | — | — | safe |
| acopio_status | 0 | id | 0 | — | — | safe |
| acopio_submissions | 0 | id | 1 | — | — | safe |
| approval_requests | 0 | id | 0 | — | — | safe |
| building_docs | 0 | id | 0 | — | source | safe |
| building_profile | 0 | building_id | 0 | — | — | safe |
| case_identity | 0 | id | 2 | cedula | source | **BLOCKED** |
| case_messages | 0 | id | 0 | — | — | safe |
| case_tasks | 0 | id | 0 | — | — | safe |
| case_victims | 0 | id | 1 | — | — | safe |
| donations | 0 | id | 1 | — | — | safe |
| emergency_photos | 0 | id | 0 | — | — | safe |
| evidence_annotations | 0 | id | 0 | — | — | safe |
| evidence_chain_of_custody | 0 | id | 0 | — | — | safe |
| evidence_comments | 0 | id | 0 | — | — | safe |
| evidence_share_links | 0 | id | 0 | — | — | safe |
| feature_flag_overrides | 0 | id | 0 | — | — | safe |
| flota_audit_log | 0 | id | 0 | — | — | safe |
| flota_dispatches | 0 | id | 0 | — | — | safe |
| flota_flota_unidades | 0 | flota_id+unidad_id | 0 | — | — | safe |
| flota_flotas | 0 | id | 1 | — | — | safe |
| flota_locations | 0 | id | 0 | — | source | safe |
| flota_mision_actividad | 0 | id | 0 | — | — | safe |
| flota_mision_waypoints | 0 | id | 1 | — | — | safe |
| flota_misiones | 0 | id | 0 | — | — | safe |
| flota_personal | 0 | id | 3 | telefono email | — | **BLOCKED** |
| flota_posiciones | 0 | id | 0 | — | — | safe |
| flota_unidades | 0 | id | 1 | — | — | safe |
| flota_unit_tokens | 0 | id | 0 | — | — | safe |
| impersonation_log | 0 | id | 0 | — | — | safe |
| invitations | 0 | id | 2 | email phone | channel | **BLOCKED** |
| mascota_attachments | 0 | id | 0 | — | — | safe |
| mascota_events | 0 | id | 1 | — | — | safe |
| panorama_balance | 0 | id | 0 | — | fuente | safe |
| refugios_assignments | 0 | id | 0 | — | — | safe |
| refugios_site_needs | 0 | id | 0 | — | source | safe |
| refugios_site_population | 0 | id | 0 | — | source | safe |
| report_comments | 0 | id | 1 | — | — | safe |
| reports | 0 | id | 0 | external_id | channel | safe |
| security_events | 0 | id | 0 | — | — | safe |
| shelter_status | 0 | id | 1 | — | — | safe |
| stripe_accounts | 0 | user_id | 0 | — | — | safe |
| stripe_payments | 0 | id | 1 | — | — | safe |
| sum_citizen_enrollments | 0 | id | 3 | cedula | — | **BLOCKED** |
| sum_citizen_requests | 0 | id | 0 | — | — | safe |
| sum_kit_lineas | 0 | id | 0 | — | — | safe |
| sum_kits | 0 | id | 1 | — | — | safe |
| sum_requisicion_lineas | 0 | id | 0 | — | — | safe |
| sum_requisiciones | 0 | id | 0 | — | — | safe |
| team_members | 0 | team_id+user_id | 0 | — | — | safe |
| teams | 0 | id | 1 | — | — | safe |
| telemed_appt_files | 0 | id | 1 | — | — | safe |
| telemed_blocks | 0 | id | 0 | — | — | safe |
| telemed_consult_notes | 0 | id | 0 | — | — | safe |
| telemed_consults | 0 | appointment_id | 0 | — | — | safe |
| telemed_prescriptions | 0 | id | 0 | — | — | safe |
| telemed_requests | 0 | id | 2 | — | — | **BLOCKED** |
| trusted_devices | 0 | id | 0 | — | — | safe |
| user_contacts | 0 | id | 6 | external_id dedupe_key | source | **BLOCKED** |
| user_permissions | 0 | user_id+perm_key | 0 | — | — | safe |
| withdrawal_methods | 0 | id | 0 | — | — | safe |
| withdrawal_requests | 0 | id | 0 | — | — | safe |
| x402_payments | 0 | id | 0 | — | — | safe |

## Duplicate-prone tables (have dedupe-key columns + rows) — Increment 5 targets

- **personas** (133,601): keys ext_id, photo_phash, photo_dhash, name_norm
- **rav_reports** (42,734): keys ext_id
- **hospital_patients** (13,201): keys dedupe_key, norm_name, cedula, telefono
- **hospital_patients_dupes** (9,532): keys dedupe_key, norm_name, cedula, telefono
- **persons** (439): keys name_norm
- **map_reports** (433): keys ext_id
- **aid_orgs** (221): keys phone, email
- **users** (122): keys email, phone
- **login_history** (111): keys email
- **case_subscriptions** (34): keys email
- **telemed_doctors** (20): keys email, phone
- **volunteers** (17): keys email
- **sos_alerts** (16): keys phone
- **contacts** (10): keys phone, email
- **sum_ubicaciones** (5): keys telefono
- **sum_proveedores** (3): keys telefono, email
- **alianza_solicitudes** (2): keys email, telefono
- **patients** (2): keys cedula, email, phone
- **guardianes_mensajes** (1): keys email, telefono
- **support_tickets** (1): keys email

## Ingest-blocked tables (adapter + pre-ingest gate ONLY)

- **personas** — person-identity table — adapter + pre-ingest gate only
- **rav_reports** — 3 PII columns — adapter + gate only
- **hospital_patients** — person-identity table — adapter + pre-ingest gate only
- **hospital_patients_dupes** — 6 PII columns — adapter + gate only
- **civis_puntos** — 2 PII columns — adapter + gate only
- **rav_safe_reports** — 2 PII columns — adapter + gate only
- **tv_buildings** — 3 PII columns — adapter + gate only
- **persons** — 4 PII columns — adapter + gate only
- **aid_orgs** — 2 PII columns — adapter + gate only
- **sessions** — person-identity table — adapter + pre-ingest gate only
- **users** — person-identity table — adapter + pre-ingest gate only
- **building_eval_events** — 2 PII columns — adapter + gate only
- **telemed_doctors** — 2 PII columns — adapter + gate only
- **volunteers** — 3 PII columns — adapter + gate only
- **sos_alerts** — 2 PII columns — adapter + gate only
- **contacts** — 3 PII columns — adapter + gate only
- **case_intel** — person-identity table — adapter + pre-ingest gate only
- **intake_submissions** — person-identity table — adapter + pre-ingest gate only
- **sum_ubicaciones** — 3 PII columns — adapter + gate only
- **sum_proveedores** — 5 PII columns — adapter + gate only
- **x402_resources** — 2 PII columns — adapter + gate only
- **alianza_solicitudes** — 3 PII columns — adapter + gate only
- **patients** — 5 PII columns — adapter + gate only
- **telemed_appointments** — 5 PII columns — adapter + gate only
- **emergency_profiles** — 2 PII columns — adapter + gate only
- **guardianes_mensajes** — 3 PII columns — adapter + gate only
- **support_tickets** — 2 PII columns — adapter + gate only
- **case_identity** — person-identity table — adapter + pre-ingest gate only
- **flota_personal** — 3 PII columns — adapter + gate only
- **invitations** — 2 PII columns — adapter + gate only
- **sum_citizen_enrollments** — 3 PII columns — adapter + gate only
- **telemed_requests** — 2 PII columns — adapter + gate only
- **user_contacts** — 6 PII columns — adapter + gate only

_Column-level detail (types, nullability, FKs, indexes) in db-map.json (local-only — PII-adjacent)._
