# SISMO911 — API Debug Audit

Generated: 2026-07-06T01:40:27.244Z · Base: https://sismo911.com · Routes: 765 (694 under /api)

## Live probe (public, GET, param-less only — read-only)

Probed 186 endpoints · **0 failing** (status ≥500 / timeout / network)

All probed endpoints healthy (<500).

## Route inventory (method · path · gate · owning file · D1 tables)

| method | path | gate | file | tables |
|---|---|---|---|---|
| GET | /api/acopio/centers | open | src/routes/acopio.ts | acopio_status acopio_submissions the |
| GET | /api/acopio/dashboard | open | src/routes/acopio.ts | acopio_status acopio_submissions the |
| GET | /api/acopio/gaps | open | src/routes/acopio.ts | acopio_status acopio_submissions the |
| GET | /api/acopio/inventory | open | src/routes/acopio.ts | acopio_status acopio_submissions the |
| POST | /api/acopio/inventory | perm:acopio:manage | src/routes/acopio.ts | acopio_status acopio_submissions the |
| POST | /api/acopio/inventory/bulk | perm:acopio:manage | src/routes/acopio.ts | acopio_status acopio_submissions the |
| GET | /api/acopio/match | open | src/routes/acopio.ts | acopio_status acopio_submissions the |
| GET | /api/acopio/needs | open | src/routes/acopio.ts | acopio_status acopio_submissions the |
| POST | /api/acopio/needs | perm:acopio:manage | src/routes/acopio.ts | acopio_status acopio_submissions the |
| PATCH | /api/acopio/needs/:id | perm:acopio:manage | src/routes/acopio.ts | acopio_status acopio_submissions the |
| POST | /api/acopio/report | open | src/routes/acopio.ts | acopio_status acopio_submissions the |
| GET | /api/acopio/shipments | open | src/routes/acopio.ts | acopio_status acopio_submissions the |
| POST | /api/acopio/shipments | perm:acopio:manage | src/routes/acopio.ts | acopio_status acopio_submissions the |
| PATCH | /api/acopio/shipments/:id | perm:acopio:manage | src/routes/acopio.ts | acopio_status acopio_submissions the |
| GET | /api/acopio/status | open | src/routes/acopio.ts | acopio_status acopio_submissions the |
| PATCH | /api/acopio/status/:id | perm:acopio:manage | src/routes/acopio.ts | acopio_status acopio_submissions the |
| GET | /api/acopio/submissions | perm:acopio:manage | src/routes/acopio.ts | acopio_status acopio_submissions the |
| PATCH | /api/acopio/submissions/:id | perm:acopio:manage | src/routes/acopio.ts | acopio_status acopio_submissions the |
| GET | /api/admin/api-clients | open | src/routes/admin.ts | api_clients audit dup_cluster familia_source_url personas public the usgs |
| POST | /api/admin/api-clients/:id/approve | perm:persons:moderate | src/routes/admin.ts | api_clients audit dup_cluster familia_source_url personas public the usgs |
| POST | /api/admin/api-clients/:id/revoke | perm:admin:maintenance | src/routes/admin.ts | api_clients audit dup_cluster familia_source_url personas public the usgs |
| POST | /api/admin/backfill-history | perm:admin:maintenance | src/routes/admin.ts | api_clients audit dup_cluster familia_source_url personas public the usgs |
| POST | /api/admin/clean-markup | perm:admin:maintenance | src/routes/admin.ts | api_clients audit dup_cluster familia_source_url personas public the usgs |
| POST | /api/admin/clean-name-floods | perm:admin:maintenance | src/routes/admin.ts | api_clients audit dup_cluster familia_source_url personas public the usgs |
| POST | /api/admin/clean-personas | perm:admin:maintenance | src/routes/admin.ts | api_clients audit dup_cluster familia_source_url personas public the usgs |
| POST | /api/admin/dedupe-personas | perm:admin:maintenance | src/routes/admin.ts | api_clients audit dup_cluster familia_source_url personas public the usgs |
| GET | /api/admin/dup/clusters | open | src/routes/admin.ts | api_clients audit dup_cluster familia_source_url personas public the usgs |
| POST | /api/admin/dup/dismiss | perm:admin:maintenance | src/routes/admin.ts | api_clients audit dup_cluster familia_source_url personas public the usgs |
| POST | /api/admin/dup/merge | perm:admin:maintenance | src/routes/admin.ts | api_clients audit dup_cluster familia_source_url personas public the usgs |
| GET | /api/admin/flota/dispatches | perm:flota:track | src/routes/flota-admin.ts | flota_dispatches flota_locations flota_unit_tokens flota_units |
| PATCH | /api/admin/flota/dispatches/:id | perm:flota:track | src/routes/flota-admin.ts | flota_dispatches flota_locations flota_unit_tokens flota_units |
| GET | /api/admin/flota/live | perm:flota:track | src/routes/flota-admin.ts | flota_dispatches flota_locations flota_unit_tokens flota_units |
| GET | /api/admin/flota/units | perm:flota:track | src/routes/flota-admin.ts | flota_dispatches flota_locations flota_unit_tokens flota_units |
| POST | /api/admin/flota/units | perm:flota:track | src/routes/flota-admin.ts | flota_dispatches flota_locations flota_unit_tokens flota_units |
| POST | /api/admin/flota/units/:id/dispatch | perm:flota:track | src/routes/flota-admin.ts | flota_dispatches flota_locations flota_unit_tokens flota_units |
| POST | /api/admin/flota/units/:id/revoke-token | perm:flota:track | src/routes/flota-admin.ts | flota_dispatches flota_locations flota_unit_tokens flota_units |
| POST | /api/admin/flota/units/:id/token | perm:flota:track | src/routes/flota-admin.ts | flota_dispatches flota_locations flota_unit_tokens flota_units |
| GET | /api/admin/flota/units/:id/tokens | perm:flota:track | src/routes/flota-admin.ts | flota_dispatches flota_locations flota_unit_tokens flota_units |
| GET | /api/admin/intake | open | src/routes/admin-intake.ts | bulk_import_jobs case_intel intake_submissions personas |
| GET | /api/admin/intake/:id | open | src/routes/admin-intake.ts | bulk_import_jobs case_intel intake_submissions personas |
| POST | /api/admin/intake/:id/approve | perm:persons:moderate | src/routes/admin-intake.ts | bulk_import_jobs case_intel intake_submissions personas |
| GET | /api/admin/intake/:id/evidence | open | src/routes/admin-intake.ts | bulk_import_jobs case_intel intake_submissions personas |
| POST | /api/admin/intake/:id/link | perm:admin:maintenance | src/routes/admin-intake.ts | bulk_import_jobs case_intel intake_submissions personas |
| POST | /api/admin/intake/:id/reject | perm:persons:moderate | src/routes/admin-intake.ts | bulk_import_jobs case_intel intake_submissions personas |
| GET | /api/admin/intake/bulk | open | src/routes/admin-intake.ts | bulk_import_jobs case_intel intake_submissions personas |
| POST | /api/admin/intake/bulk | perm:admin:maintenance | src/routes/admin-intake.ts | bulk_import_jobs case_intel intake_submissions personas |
| GET | /api/admin/intake/bulk/:id | open | src/routes/admin-intake.ts | bulk_import_jobs case_intel intake_submissions personas |
| POST | /api/admin/pull-familia | perm:admin:maintenance | src/routes/admin.ts | api_clients audit dup_cluster familia_source_url personas public the usgs |
| POST | /api/admin/rescore-cases | perm:admin:maintenance | src/routes/admin.ts | api_clients audit dup_cluster familia_source_url personas public the usgs |
| POST | /api/admin/sheet-sync | perm:admin:maintenance | src/routes/admin-sheet-sync.ts | d1 the |
| POST | /api/admin/sheet-sync/dedup | perm:admin:maintenance | src/routes/admin-sheet-sync.ts | d1 the |
| POST | /api/admin/sheet-sync/full | perm:admin:maintenance | src/routes/admin-sheet-sync.ts | d1 the |
| POST | /api/admin/sheet-sync/reset | perm:admin:maintenance | src/routes/admin-sheet-sync.ts | d1 the |
| GET | /api/admin/sheet-sync/status | open | src/routes/admin-sheet-sync.ts | d1 the |
| GET | /api/admin/spam-stats | open | src/routes/admin.ts | api_clients audit dup_cluster familia_source_url personas public the usgs |
| GET | /api/admin/withdrawals | open | src/routes/admin-withdrawals.ts | withdrawal_requests |
| PATCH | /api/admin/withdrawals/:id/approve | perm:persons:moderate | src/routes/admin-withdrawals.ts | withdrawal_requests |
| PATCH | /api/admin/withdrawals/:id/mark-completed | perm:admin:maintenance | src/routes/admin-withdrawals.ts | withdrawal_requests |
| PATCH | /api/admin/withdrawals/:id/reject | perm:persons:moderate | src/routes/admin-withdrawals.ts | withdrawal_requests |
| GET | /api/agencias | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/aid-orgs | open | src/routes/aid_orgs.ts | aid_orgs |
| POST | /api/aid-orgs | perm:aid_orgs:manage | src/routes/aid_orgs.ts | aid_orgs |
| DELETE | /api/aid-orgs/:id | perm:aid_orgs:manage | src/routes/aid_orgs.ts | aid_orgs |
| PATCH | /api/aid-orgs/:id | perm:aid_orgs:manage | src/routes/aid_orgs.ts | aid_orgs |
| GET | /api/alerts | open | src/routes/alerts.ts | events our |
| POST | /api/alianza | open | src/routes/alianza.ts | alianza_solicitudes being |
| POST | /api/alianza/admin/:id/estado | open | src/routes/alianza.ts | alianza_solicitudes being |
| GET | /api/alianza/admin/list | open | src/routes/alianza.ts | alianza_solicitudes being |
| POST | /api/auth/change-password | open | src/routes/auth.ts | email_verifications lockout login_history password_resets public_base_url registers sessions this users |
| POST | /api/auth/forgot-password | open | src/routes/auth.ts | email_verifications lockout login_history password_resets public_base_url registers sessions this users |
| POST | /api/auth/login | open | src/routes/auth.ts | email_verifications lockout login_history password_resets public_base_url registers sessions this users |
| POST | /api/auth/logout | open | src/routes/auth.ts | email_verifications lockout login_history password_resets public_base_url registers sessions this users |
| GET | /api/auth/me | open | src/routes/auth.ts | email_verifications lockout login_history password_resets public_base_url registers sessions this users |
| GET | /api/auth/oauth/:provider/callback | open | src/routes/oauth.ts | users |
| GET | /api/auth/oauth/:provider/start | open | src/routes/oauth.ts | users |
| GET | /api/auth/oauth/providers | open | src/routes/oauth.ts | users |
| POST | /api/auth/register | open | src/routes/auth.ts | email_verifications lockout login_history password_resets public_base_url registers sessions this users |
| POST | /api/auth/reset-password | open | src/routes/auth.ts | email_verifications lockout login_history password_resets public_base_url registers sessions this users |
| GET | /api/auth/users | open | src/routes/auth.ts | email_verifications lockout login_history password_resets public_base_url registers sessions this users |
| PATCH | /api/auth/users/:id | open | src/routes/auth.ts | email_verifications lockout login_history password_resets public_base_url registers sessions this users |
| GET | /api/auth/verify | open | src/routes/auth.ts | email_verifications lockout login_history password_resets public_base_url registers sessions this users |
| POST | /api/auth/wallet | open | src/routes/auth.ts | email_verifications lockout login_history password_resets public_base_url registers sessions this users |
| GET | /api/blog | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/blog/delete | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/blog/ingest | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/blog/run | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/blog/sources | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/botiquin | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/buildings | open | src/routes/buildings.ts | both building_cases building_docs building_eval_events building_profile built fetchcasereports personas persons sat_edificaciones satellite sectors sos_damage the tv_buildings two |
| GET | /api/buildings/collapsed | open | src/routes/buildings.ts | both building_cases building_docs building_eval_events building_profile built fetchcasereports personas persons sat_edificaciones satellite sectors sos_damage the tv_buildings two |
| GET | /api/buildings/reported | open | src/routes/buildings.ts | both building_cases building_docs building_eval_events building_profile built fetchcasereports personas persons sat_edificaciones satellite sectors sos_damage the tv_buildings two |
| GET | /api/buildings/reported/:id | open | src/routes/buildings.ts | both building_cases building_docs building_eval_events building_profile built fetchcasereports personas persons sat_edificaciones satellite sectors sos_damage the tv_buildings two |
| GET | /api/buildings/reported/:id/case-suggestions | open | src/routes/buildings.ts | both building_cases building_docs building_eval_events building_profile built fetchcasereports personas persons sat_edificaciones satellite sectors sos_damage the tv_buildings two |
| POST | /api/buildings/reported/:id/cases | perm:damage:moderate | src/routes/buildings.ts | both building_cases building_docs building_eval_events building_profile built fetchcasereports personas persons sat_edificaciones satellite sectors sos_damage the tv_buildings two |
| DELETE | /api/buildings/reported/:id/cases/:caseId | perm:damage:moderate | src/routes/buildings.ts | both building_cases building_docs building_eval_events building_profile built fetchcasereports personas persons sat_edificaciones satellite sectors sos_damage the tv_buildings two |
| GET | /api/buildings/reported/:id/eval | open | src/routes/buildings.ts | both building_cases building_docs building_eval_events building_profile built fetchcasereports personas persons sat_edificaciones satellite sectors sos_damage the tv_buildings two |
| POST | /api/buildings/reported/:id/eval/events | perm:damage:moderate | src/routes/buildings.ts | both building_cases building_docs building_eval_events building_profile built fetchcasereports personas persons sat_edificaciones satellite sectors sos_damage the tv_buildings two |
| GET | /api/buildings/reported/:id/eval/verify | open | src/routes/buildings.ts | both building_cases building_docs building_eval_events building_profile built fetchcasereports personas persons sat_edificaciones satellite sectors sos_damage the tv_buildings two |
| GET | /api/buildings/sar | open | src/routes/buildings.ts | both building_cases building_docs building_eval_events building_profile built fetchcasereports personas persons sat_edificaciones satellite sectors sos_damage the tv_buildings two |
| GET | /api/buildings/sar/summary | open | src/routes/buildings.ts | both building_cases building_docs building_eval_events building_profile built fetchcasereports personas persons sat_edificaciones satellite sectors sos_damage the tv_buildings two |
| GET | /api/buildings/sectors | open | src/routes/buildings.ts | both building_cases building_docs building_eval_events building_profile built fetchcasereports personas persons sat_edificaciones satellite sectors sos_damage the tv_buildings two |
| GET | /api/buildings/summary | open | src/routes/buildings.ts | both building_cases building_docs building_eval_events building_profile built fetchcasereports personas persons sat_edificaciones satellite sectors sos_damage the tv_buildings two |
| GET | /api/campaigns | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/campaigns | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/campaigns-mine | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/campaigns/:slug | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| PATCH | /api/campaigns/:slug | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/campaigns/:slug/donate | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/casualties | open | src/routes/casualties.ts | casualty_reports casualty_sources |
| GET | /api/casualties/:event | open | src/routes/casualties.ts | casualty_reports casualty_sources |
| GET | /api/casualties/:event/sources | open | src/routes/casualties.ts | casualty_reports casualty_sources |
| GET | /api/casualties/:event/timeline | open | src/routes/casualties.ts | casualty_reports casualty_sources |
| POST | /api/casualties/manual | perm:admin:maintenance | src/routes/casualties.ts | casualty_reports casualty_sources |
| GET | /api/chat | open | src/routes/chat.ts | chat_messages kv multipart verified |
| POST | /api/chat | open | src/routes/chat.ts | chat_messages kv multipart verified |
| PATCH | /api/chat/:id | open | src/routes/chat.ts | chat_messages kv multipart verified |
| GET | /api/chat/captcha | open | src/routes/chat.ts | chat_messages kv multipart verified |
| GET | /api/chat/photo/:id | open | src/routes/chat.ts | chat_messages kv multipart verified |
| GET | /api/checkins | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/checkins | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/comms | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/contacts | open | src/routes/contacts.ts | contacts |
| POST | /api/contacts | perm:contacts:manage | src/routes/contacts.ts | contacts |
| POST | /api/csp-report | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/damage | perm:damage:moderate | src/routes/damage.ts | damage_reports |
| POST | /api/damage | open | src/routes/damage.ts | damage_reports |
| GET | /api/damage/photo/:id | perm:damage:moderate | src/routes/damage.ts | damage_reports |
| GET | /api/danos-estructurales | open | src/routes/damage-map.ts | sos_damage |
| POST | /api/danos-estructurales/sync | perm:damage:moderate | src/routes/damage-map.ts | sos_damage |
| GET | /api/dashboard/geoseismic | open | src/routes/dashboard.ts | events official_stats one personas persons sos_damage the |
| GET | /api/donations/:id/status | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/donations/config | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/donations/webhook | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/donations/zone | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/donations/zone | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/e/:token | open | src/routes/evidence.ts | case_attachments evidence_annotations evidence_chain_of_custody evidence_comments evidence_share_links metadata the |
| GET | /api/e/:token/file | open | src/routes/evidence.ts | case_attachments evidence_annotations evidence_chain_of_custody evidence_comments evidence_share_links metadata the |
| GET | /api/emergencia | open | src/routes/emergencia.ts | a emergency_photos emergency_profiles r2 |
| POST | /api/emergencia | perm:emergencia:manage | src/routes/emergencia.ts | a emergency_photos emergency_profiles r2 |
| DELETE | /api/emergencia/:id | perm:emergencia:manage | src/routes/emergencia.ts | a emergency_photos emergency_profiles r2 |
| PATCH | /api/emergencia/:id | perm:emergencia:manage | src/routes/emergencia.ts | a emergency_photos emergency_profiles r2 |
| POST | /api/emergencia/:id/photo | perm:emergencia:manage | src/routes/emergencia.ts | a emergency_photos emergency_profiles r2 |
| DELETE | /api/emergencia/:id/photo/:pid | perm:emergencia:manage | src/routes/emergencia.ts | a emergency_photos emergency_profiles r2 |
| GET | /api/emergencia/:key | open | src/routes/emergencia.ts | a emergency_photos emergency_profiles r2 |
| POST | /api/emergencia/:key/share | open | src/routes/emergencia.ts | a emergency_photos emergency_profiles r2 |
| GET | /api/emergencia/admin | open | src/routes/emergencia.ts | a emergency_photos emergency_profiles r2 |
| GET | /api/emergencia/photo/:id | open | src/routes/emergencia.ts | a emergency_photos emergency_profiles r2 |
| GET | /api/events | open | src/routes/events.ts | cf d1 events the usgs |
| GET | /api/events/:id | open | src/routes/events.ts | cf d1 events the usgs |
| POST | /api/events/backfill-run | open | src/routes/events.ts | cf d1 events the usgs |
| GET | /api/events/history | open | src/routes/events.ts | cf d1 events the usgs |
| POST | /api/events/refresh | perm:events:refresh | src/routes/events.ts | cf d1 events the usgs |
| GET | /api/facilities | open | src/routes/facilities.ts |  |
| POST | /api/familia/:id/approve | perm:persons:moderate | src/routes/familia.ts | a d1 desap_fotos person_events personas persons reusing the |
| POST | /api/familia/:id/localizar | perm:persons:moderate | src/routes/familia.ts | a d1 desap_fotos person_events personas persons reusing the |
| POST | /api/familia/:id/report | open | src/routes/familia.ts | a d1 desap_fotos person_events personas persons reusing the |
| POST | /api/familia/delete-ids | open | src/routes/familia.ts | a d1 desap_fotos person_events personas persons reusing the |
| GET | /api/familia/gallery | open | src/routes/familia.ts | a d1 desap_fotos person_events personas persons reusing the |
| POST | /api/familia/maintenance | open | src/routes/familia.ts | a d1 desap_fotos person_events personas persons reusing the |
| GET | /api/familia/person/:id | open | src/routes/familia.ts | a d1 desap_fotos person_events personas persons reusing the |
| GET | /api/familia/persons | open | src/routes/familia.ts | a d1 desap_fotos person_events personas persons reusing the |
| POST | /api/familia/persons | open | src/routes/familia.ts | a d1 desap_fotos person_events personas persons reusing the |
| GET | /api/familia/photo/:id | open | src/routes/familia.ts | a d1 desap_fotos person_events personas persons reusing the |
| GET | /api/familia/queue | open | src/routes/familia.ts | a d1 desap_fotos person_events personas persons reusing the |
| GET | /api/flota/flotas | perm:flota:read | src/routes/flota-flotas.ts | a flota_flota_unidades flota_flotas flota_unidades the |
| POST | /api/flota/flotas | perm:flota:dispatch | src/routes/flota-flotas.ts | a flota_flota_unidades flota_flotas flota_unidades the |
| DELETE | /api/flota/flotas/:id | perm:flota:dispatch | src/routes/flota-flotas.ts | a flota_flota_unidades flota_flotas flota_unidades the |
| GET | /api/flota/flotas/:id | perm:flota:read | src/routes/flota-flotas.ts | a flota_flota_unidades flota_flotas flota_unidades the |
| PATCH | /api/flota/flotas/:id | perm:flota:dispatch | src/routes/flota-flotas.ts | a flota_flota_unidades flota_flotas flota_unidades the |
| POST | /api/flota/flotas/:id/unidades | perm:flota:dispatch | src/routes/flota-flotas.ts | a flota_flota_unidades flota_flotas flota_unidades the |
| DELETE | /api/flota/flotas/:id/unidades/:unidadId | perm:flota:dispatch | src/routes/flota-flotas.ts | a flota_flota_unidades flota_flotas flota_unidades the |
| GET | /api/flota/misiones | perm:flota:read | src/routes/flota-misiones.ts | any flota_mision_actividad flota_mision_waypoints flota_misiones flota_unidades |
| POST | /api/flota/misiones | perm:flota:dispatch | src/routes/flota-misiones.ts | any flota_mision_actividad flota_mision_waypoints flota_misiones flota_unidades |
| DELETE | /api/flota/misiones/:id | perm:flota:dispatch | src/routes/flota-misiones.ts | any flota_mision_actividad flota_mision_waypoints flota_misiones flota_unidades |
| GET | /api/flota/misiones/:id | perm:flota:read | src/routes/flota-misiones.ts | any flota_mision_actividad flota_mision_waypoints flota_misiones flota_unidades |
| PATCH | /api/flota/misiones/:id | perm:flota:dispatch | src/routes/flota-misiones.ts | any flota_mision_actividad flota_mision_waypoints flota_misiones flota_unidades |
| POST | /api/flota/misiones/:id/despachar | perm:flota:dispatch | src/routes/flota-misiones.ts | any flota_mision_actividad flota_mision_waypoints flota_misiones flota_unidades |
| POST | /api/flota/misiones/:id/estado | perm:flota:dispatch | src/routes/flota-misiones.ts | any flota_mision_actividad flota_mision_waypoints flota_misiones flota_unidades |
| POST | /api/flota/misiones/:id/waypoints | perm:flota:dispatch | src/routes/flota-misiones.ts | any flota_mision_actividad flota_mision_waypoints flota_misiones flota_unidades |
| PATCH | /api/flota/misiones/:id/waypoints/:wpId | perm:flota:dispatch | src/routes/flota-misiones.ts | any flota_mision_actividad flota_mision_waypoints flota_misiones flota_unidades |
| GET | /api/flota/personal | perm:flota:read | src/routes/flota-personal.ts | a an flota_personal |
| POST | /api/flota/personal | perm:flota:dispatch | src/routes/flota-personal.ts | a an flota_personal |
| DELETE | /api/flota/personal/:id | perm:flota:dispatch | src/routes/flota-personal.ts | a an flota_personal |
| GET | /api/flota/personal/:id | perm:flota:read | src/routes/flota-personal.ts | a an flota_personal |
| PATCH | /api/flota/personal/:id | perm:flota:dispatch | src/routes/flota-personal.ts | a an flota_personal |
| POST | /api/flota/rastreo/posicion | perm:flota:dispatch | src/routes/flota-rastreo.ts | flota_posiciones flota_unidades |
| GET | /api/flota/rastreo/unidad/:id/track | perm:flota:read | src/routes/flota-rastreo.ts | flota_posiciones flota_unidades |
| GET | /api/flota/rastreo/unidades | perm:flota:read | src/routes/flota-rastreo.ts | flota_posiciones flota_unidades |
| GET | /api/flota/rastreo/ws | perm:flota:read | src/routes/flota-rastreo.ts | flota_posiciones flota_unidades |
| GET | /api/flota/tablero/mapa | perm:flota:read | src/routes/flota-tablero.ts | a flota_misiones flota_personal flota_unidades |
| GET | /api/flota/tablero/resumen | perm:flota:read | src/routes/flota-tablero.ts | a flota_misiones flota_personal flota_unidades |
| GET | /api/flota/unidades | perm:flota:read | src/routes/flota-unidades.ts | flota_flota_unidades flota_misiones flota_personal flota_unidades mutable |
| POST | /api/flota/unidades | perm:flota:dispatch | src/routes/flota-unidades.ts | flota_flota_unidades flota_misiones flota_personal flota_unidades mutable |
| DELETE | /api/flota/unidades/:id | perm:flota:dispatch | src/routes/flota-unidades.ts | flota_flota_unidades flota_misiones flota_personal flota_unidades mutable |
| GET | /api/flota/unidades/:id | perm:flota:read | src/routes/flota-unidades.ts | flota_flota_unidades flota_misiones flota_personal flota_unidades mutable |
| PATCH | /api/flota/unidades/:id | perm:flota:dispatch | src/routes/flota-unidades.ts | flota_flota_unidades flota_misiones flota_personal flota_unidades mutable |
| GET | /api/funding | open | src/routes/funding.ts | donations the |
| GET | /api/geo | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/guardianes/admin/mensajes | open | src/routes/guardianes.ts | guardianes_mensajes |
| POST | /api/guardianes/asistente | open | src/routes/guardianes.ts | guardianes_mensajes |
| POST | /api/guardianes/mensaje | open | src/routes/guardianes.ts | guardianes_mensajes |
| GET | /api/health | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/heatmap | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/humanitarian/dashboard | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/impact/personas-ayudadas | open | src/routes/impact.ts | an person_events platform records telemed_requests |
| GET | /api/layers/catalog | open | src/routes/layers.ts | acopio_needs acopio_shipments acopio_status acopio_submissions checkins comms_channels d1 events map_reports one resources sat_damage shelter_status sos_alerts |
| GET | /api/layers/geoseismic | open | src/routes/layers.ts | acopio_needs acopio_shipments acopio_status acopio_submissions checkins comms_channels d1 events map_reports one resources sat_damage shelter_status sos_alerts |
| GET | /api/layers/humanitarian | open | src/routes/layers.ts | acopio_needs acopio_shipments acopio_status acopio_submissions checkins comms_channels d1 events map_reports one resources sat_damage shelter_status sos_alerts |
| GET | /api/layers/lifelines | open | src/routes/layers.ts | acopio_needs acopio_shipments acopio_status acopio_submissions checkins comms_channels d1 events map_reports one resources sat_damage shelter_status sos_alerts |
| GET | /api/layers/operational | open | src/routes/layers.ts | acopio_needs acopio_shipments acopio_status acopio_submissions checkins comms_channels d1 events map_reports one resources sat_damage shelter_status sos_alerts |
| GET | /api/layers/state-posture | open | src/routes/layers.ts | acopio_needs acopio_shipments acopio_status acopio_submissions checkins comms_channels d1 events map_reports one resources sat_damage shelter_status sos_alerts |
| GET | /api/mascotas/:id | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/mascotas/:id/approve | perm:persons:moderate | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/mascotas/:id/attachments | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/mascotas/:id/attachments | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/mascotas/:id/attachments/:aid/file | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/mascotas/:id/update | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/mascotas/attachments/:aid/approve | perm:persons:moderate | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/mascotas/attachments/:aid/reject | perm:persons:moderate | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/mascotas/events/:eid/approve | perm:persons:moderate | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/mascotas/events/:eid/reject | perm:persons:moderate | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/mascotas/list | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/mascotas/photo/:id | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/mascotas/queue | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/mascotas/report | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/monitor/apify | open | src/routes/monitor.ts | ingest_log social_signals the |
| POST | /api/monitor/refresh | open | src/routes/monitor.ts | ingest_log social_signals the |
| GET | /api/monitor/signals | open | src/routes/monitor.ts | ingest_log social_signals the |
| GET | /api/monitor/stats | open | src/routes/monitor.ts | ingest_log social_signals the |
| GET | /api/ninez/admin/refugios | perm:ninez:manage | src/routes/ninez.ts | a assembled refugios_site_capabilities refugios_site_needs refugios_site_population refugios_sites |
| GET | /api/ninez/admin/summary | perm:ninez:manage | src/routes/ninez.ts | a assembled refugios_site_capabilities refugios_site_needs refugios_site_population refugios_sites |
| GET | /api/ninez/alertas | open | src/routes/ninez.ts | a assembled refugios_site_capabilities refugios_site_needs refugios_site_population refugios_sites |
| GET | /api/ninez/catalog | open | src/routes/ninez.ts | a assembled refugios_site_capabilities refugios_site_needs refugios_site_population refugios_sites |
| GET | /api/ninez/refugios | open | src/routes/ninez.ts | a assembled refugios_site_capabilities refugios_site_needs refugios_site_population refugios_sites |
| POST | /api/ninez/refugios/:id/capability | perm:ninez:manage | src/routes/ninez.ts | a assembled refugios_site_capabilities refugios_site_needs refugios_site_population refugios_sites |
| DELETE | /api/ninez/refugios/:id/capability/:key | perm:ninez:manage | src/routes/ninez.ts | a assembled refugios_site_capabilities refugios_site_needs refugios_site_population refugios_sites |
| POST | /api/ninez/refugios/:id/need | perm:ninez:manage | src/routes/ninez.ts | a assembled refugios_site_capabilities refugios_site_needs refugios_site_population refugios_sites |
| POST | /api/ninez/refugios/:id/population | perm:ninez:manage | src/routes/ninez.ts | a assembled refugios_site_capabilities refugios_site_needs refugios_site_population refugios_sites |
| GET | /api/ninez/summary | open | src/routes/ninez.ts | a assembled refugios_site_capabilities refugios_site_needs refugios_site_population refugios_sites |
| GET | /api/notify/preview | open | src/routes/notify.ts |  |
| GET | /api/notify/preview/:id | open | src/routes/notify.ts |  |
| POST | /api/notify/test | open | src/routes/notify.ts |  |
| POST | /api/panorama/balance | perm:damage:moderate | src/routes/panorama.ts | civis_stats_snapshots panorama_balance press sat_edificaciones the |
| GET | /api/panorama/edificaciones | open | src/routes/panorama.ts | civis_stats_snapshots panorama_balance press sat_edificaciones the |
| GET | /api/panorama/series | open | src/routes/panorama.ts | civis_stats_snapshots panorama_balance press sat_edificaciones the |
| GET | /api/panorama/stats | open | src/routes/panorama.ts | civis_stats_snapshots panorama_balance press sat_edificaciones the |
| GET | /api/persons | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| PATCH | /api/persons/:id | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/aportes | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/aportes | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/aportes/:aid/file | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/approve | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/attachments | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/attachments | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| DELETE | /api/persons/:id/attachments/:aid | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| PATCH | /api/persons/:id/attachments/:aid | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/attachments/:aid/file | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/audit | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| PATCH | /api/persons/:id/case | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/docket | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/docket | login | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/evidence | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| DELETE | /api/persons/:id/evidence/:aid | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/evidence/:aid | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| PATCH | /api/persons/:id/evidence/:aid | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/evidence/:aid/annotations | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/evidence/:aid/annotations | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| DELETE | /api/persons/:id/evidence/:aid/annotations/:annId | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| PATCH | /api/persons/:id/evidence/:aid/annotations/:annId | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/evidence/:aid/comments | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/evidence/:aid/comments | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| DELETE | /api/persons/:id/evidence/:aid/comments/:cid | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/evidence/:aid/custody | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/evidence/:aid/restore | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/evidence/:aid/share | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/evidence/print | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/evidence/shares | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| DELETE | /api/persons/:id/evidence/shares/:sid | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/identity | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/identity/verify | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/intel | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/intel | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| DELETE | /api/persons/:id/intel/:lid | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| PATCH | /api/persons/:id/intel/:lid | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/medical | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/medical/link | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/medical/unlink | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/messages | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/messages | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/protect | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/reject | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/subscribe | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/tasks | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/tasks | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| PATCH | /api/persons/:id/tasks/:tid | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/tip | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/update | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/:id/victims | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/:id/victims | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| DELETE | /api/persons/:id/victims/:vid | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/agent-activity | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/aportes/:aid/approve | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/aportes/:aid/reject | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/cases | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/docket/:eid/approve | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/docket/:eid/reject | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/docket/queue | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/hospital/collapse | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/hospital/ingest | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/hospital/match | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/hospital/reset | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/hospital/search | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/hospital/source-audit | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/hospital/stats | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/hospital/sync | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/identity/sources | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/medical-cases | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/medical-cases/:caseId | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/medical-cases/:caseId/status | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/medical-cases/backfill | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/photo-review/candidates | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/queue | perm:persons:moderate | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| POST | /api/persons/reindex-search | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/search | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/persons/stats | open | src/routes/persons.ts | a agent_activity an applies audit case case_attachments case_identity case_intel case_messages case_meta case_tasks case_victims events hospital_matches hospital_patients passes person_events personas persons proposal proposed rav_reports the |
| GET | /api/profile/accounting/ledger | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| PATCH | /api/profile/accounting/ledger/:id | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| DELETE | /api/profile/avatar | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| POST | /api/profile/avatar | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| POST | /api/profile/confirm | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| GET | /api/profile/contacts | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| POST | /api/profile/contacts | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| DELETE | /api/profile/contacts/:id | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| GET | /api/profile/contacts/:id | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| PATCH | /api/profile/contacts/:id | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| POST | /api/profile/contacts/import | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| GET | /api/profile/contacts/import/google/callback | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| GET | /api/profile/contacts/import/google/start | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| GET | /api/profile/me | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| PATCH | /api/profile/me | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| GET | /api/profile/notifications | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| GET | /api/profile/notifications/count | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| POST | /api/profile/notifications/read | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| GET | /api/profile/payment-links | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| POST | /api/profile/payment-links | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| DELETE | /api/profile/payment-links/:id | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| PATCH | /api/profile/payment-links/:id | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| PATCH | /api/profile/payment-settings | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| GET | /api/profile/payments/export.csv | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| GET | /api/profile/payments/summary | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| POST | /api/profile/plan-interest | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| POST | /api/profile/withdrawal-methods | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| DELETE | /api/profile/withdrawal-methods/:id | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| GET | /api/profile/withdrawals | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| POST | /api/profile/withdrawals | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| PATCH | /api/profile/withdrawals/:id/cancel | open | src/routes/profile.ts | a notifications payurlfor settings_json stripe_accounts stripe_payments the title users withdrawal_methods withdrawal_requests x402_payments x402_resources |
| POST | /api/push/subscribe | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/push/vapid | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/rav/reports | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/rav/reports/kinds | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/rav/run | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/rav/safe | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/rbac/approvals | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/audit | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/csp-violations | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/dashboard | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/departments | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/departments | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| DELETE | /api/rbac/departments/:id | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| PATCH | /api/rbac/departments/:id | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/evaluaciones | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/feature-flags | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| PUT | /api/rbac/feature-flags | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| DELETE | /api/rbac/feature-flags/:moduleKey/:scopeType/:scopeId | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/feature-flags/effective | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/impersonate/:userId | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/impersonate/stop | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/impersonation/active | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/impersonation/log | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/invitations | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/invitations | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/invitations/:id/resend | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/invitations/:id/revoke | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/invitations/accept | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/invitations/accept | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/login-history | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/mfa/disable | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/mfa/enroll | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/mfa/verify | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/orgs | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/orgs | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| PATCH | /api/rbac/orgs/:id | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/permissions | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/roles | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/roles | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| DELETE | /api/rbac/roles/:id | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| PATCH | /api/rbac/roles/:id | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/roles/:id/diff | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/roles/export | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/roles/import | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/security-events | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/sessions | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| DELETE | /api/rbac/sessions/:token | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/teams | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/teams | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| DELETE | /api/rbac/teams/:id | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| PATCH | /api/rbac/teams/:id | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/teams/:id/members | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/teams/:id/members | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| DELETE | /api/rbac/teams/:id/members/:userId | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/users | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/users | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/users.csv | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/users/:id | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| PATCH | /api/rbac/users/:id | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/users/:id/activate | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/users/:id/approve | perm:persons:moderate | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/users/:id/audit | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/users/:id/effective-permissions | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/users/:id/lock | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/users/:id/permissions | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| DELETE | /api/rbac/users/:id/permissions/:permKey | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/users/:id/reject | perm:persons:moderate | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/users/:id/reset-password | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/users/:id/roles | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| DELETE | /api/rbac/users/:id/roles/:roleId | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/users/:id/sessions | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| DELETE | /api/rbac/users/:id/sessions/:token | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/users/:id/sessions/revoke-all | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/users/:id/suspend | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/rbac/users/:id/temp-roles | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/users/:id/temp-roles | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| DELETE | /api/rbac/users/:id/temp-roles/:roleId | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| POST | /api/rbac/users/:id/unlock | open | src/routes/admin-lifecycle.ts | a approval_requests invitations rbac_roles security_events sessions sismo911 the user_roles users |
| GET | /api/ready | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/refugios | open | src/routes/refugios.ts | current refugios_assignments refugios_sites refugios_zones site |
| POST | /api/refugios | perm:refugios:manage | src/routes/refugios.ts | current refugios_assignments refugios_sites refugios_zones site |
| DELETE | /api/refugios/:id | perm:refugios:manage | src/routes/refugios.ts | current refugios_assignments refugios_sites refugios_zones site |
| PATCH | /api/refugios/:id | perm:refugios:manage | src/routes/refugios.ts | current refugios_assignments refugios_sites refugios_zones site |
| GET | /api/refugios/assign | open | src/routes/refugios.ts | current refugios_assignments refugios_sites refugios_zones site |
| POST | /api/refugios/assign/save | perm:refugios:manage | src/routes/refugios.ts | current refugios_assignments refugios_sites refugios_zones site |
| GET | /api/refugios/logistics | open | src/routes/refugios.ts | current refugios_assignments refugios_sites refugios_zones site |
| GET | /api/refugios/org | open | src/routes/refugios.ts | current refugios_assignments refugios_sites refugios_zones site |
| GET | /api/refugios/params | open | src/routes/refugios.ts | current refugios_assignments refugios_sites refugios_zones site |
| POST | /api/refugios/score | perm:refugios:manage | src/routes/refugios.ts | current refugios_assignments refugios_sites refugios_zones site |
| GET | /api/refugios/summary | open | src/routes/refugios.ts | current refugios_assignments refugios_sites refugios_zones site |
| GET | /api/refugios/zones | open | src/routes/refugios.ts | current refugios_assignments refugios_sites refugios_zones site |
| GET | /api/reports | open | src/routes/reports.ts | json kv map_reports report_comments |
| POST | /api/reports | open | src/routes/reports.ts | json kv map_reports report_comments |
| DELETE | /api/reports/:id | perm:reports:moderate | src/routes/reports.ts | json kv map_reports report_comments |
| GET | /api/reports/:id | open | src/routes/reports.ts | json kv map_reports report_comments |
| PATCH | /api/reports/:id | perm:reports:moderate | src/routes/reports.ts | json kv map_reports report_comments |
| GET | /api/reports/:id/comments | open | src/routes/reports.ts | json kv map_reports report_comments |
| POST | /api/reports/:id/comments | open | src/routes/reports.ts | json kv map_reports report_comments |
| POST | /api/reports/:id/react | open | src/routes/reports.ts | json kv map_reports report_comments |
| GET | /api/reports/photo/:id | open | src/routes/reports.ts | json kv map_reports report_comments |
| GET | /api/reports/queue | perm:reports:moderate | src/routes/reports.ts | json kv map_reports report_comments |
| GET | /api/reports/stats | open | src/routes/reports.ts | json kv map_reports report_comments |
| GET | /api/resources | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/resources | perm:resources:manage | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/sat/analyze | perm:sat:analyze | src/routes/satellite.ts | google sat_damage |
| GET | /api/sat/config | open | src/routes/satellite.ts | google sat_damage |
| GET | /api/sat/damage | open | src/routes/satellite.ts | google sat_damage |
| PATCH | /api/sat/damage/:id | perm:sat:analyze | src/routes/satellite.ts | google sat_damage |
| GET | /api/sat/google/:z/:x/:y | open | src/routes/satellite.ts | google sat_damage |
| GET | /api/sat/maxar | open | src/routes/satellite.ts | google sat_damage |
| POST | /api/sat/pytorch-results | open | src/routes/satellite.ts | google sat_damage |
| POST | /api/send-as | open | src/routes/sendas.ts | a |
| POST | /api/send-as/draft | open | src/routes/sendas.ts | a |
| GET | /api/shelters | open | src/routes/shelters.ts | shelter_status |
| POST | /api/shelters/:id/approve | perm:persons:moderate | src/routes/shelters.ts | shelter_status |
| GET | /api/shelters/queue | perm:shelters:manage | src/routes/shelters.ts | shelter_status |
| POST | /api/shelters/status | open | src/routes/shelters.ts | shelter_status |
| GET | /api/sismos-bot/health | open |  |  |
| POST | /api/sismos-bot/webhook | open |  |  |
| GET | /api/sitrep | open | src/routes/sitrep.ts | acopio_custody acopio_inventory acopio_inventory_lots acopio_needs acopio_shipments aggregate checkins events ingest_log map_reports resources sat_damage shelter_status sismo911 sos_alerts the |
| GET | /api/sitrep/:id | open | src/routes/sitrep.ts | acopio_custody acopio_inventory acopio_inventory_lots acopio_needs acopio_shipments aggregate checkins events ingest_log map_reports resources sat_damage shelter_status sismo911 sos_alerts the |
| GET | /api/sitrep/cap | open | src/routes/sitrep.ts | acopio_custody acopio_inventory acopio_inventory_lots acopio_needs acopio_shipments aggregate checkins events ingest_log map_reports resources sat_damage shelter_status sismo911 sos_alerts the |
| GET | /api/sitrep/esf | open | src/routes/sitrep.ts | acopio_custody acopio_inventory acopio_inventory_lots acopio_needs acopio_shipments aggregate checkins events ingest_log map_reports resources sat_damage shelter_status sismo911 sos_alerts the |
| GET | /api/sitrep/ics-209 | open | src/routes/sitrep.ts | acopio_custody acopio_inventory acopio_inventory_lots acopio_needs acopio_shipments aggregate checkins events ingest_log map_reports resources sat_damage shelter_status sismo911 sos_alerts the |
| GET | /api/sitrep/timeline | open | src/routes/sitrep.ts | acopio_custody acopio_inventory acopio_inventory_lots acopio_needs acopio_shipments aggregate checkins events ingest_log map_reports resources sat_damage shelter_status sismo911 sos_alerts the |
| GET | /api/sos | perm:sos:triage | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/sos | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| PATCH | /api/sos/:id | perm:sos:triage | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/stats/official | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/status | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| POST | /api/stripe/checkout/:user/:slug | open | src/routes/stripe.ts | stripe_accounts stripe_payments the users x402_resources |
| POST | /api/stripe/connect/onboard | open | src/routes/stripe.ts | stripe_accounts stripe_payments the users x402_resources |
| GET | /api/stripe/connect/status | open | src/routes/stripe.ts | stripe_accounts stripe_payments the users x402_resources |
| GET | /api/stripe/status | open | src/routes/stripe.ts | stripe_accounts stripe_payments the users x402_resources |
| POST | /api/stripe/webhook | open | src/routes/stripe.ts | stripe_accounts stripe_payments the users x402_resources |
| GET | /api/suministros-ciudadano/admin/pedidos | open | src/routes/suministros-ciudadano.ts | sum_citizen_enrollments sum_citizen_requests the |
| POST | /api/suministros-ciudadano/admin/pedidos/:id/estado | open | src/routes/suministros-ciudadano.ts | sum_citizen_enrollments sum_citizen_requests the |
| GET | /api/suministros-ciudadano/admin/solicitudes | open | src/routes/suministros-ciudadano.ts | sum_citizen_enrollments sum_citizen_requests the |
| POST | /api/suministros-ciudadano/admin/solicitudes/:id/aprobar | open | src/routes/suministros-ciudadano.ts | sum_citizen_enrollments sum_citizen_requests the |
| POST | /api/suministros-ciudadano/admin/solicitudes/:id/rechazar | open | src/routes/suministros-ciudadano.ts | sum_citizen_enrollments sum_citizen_requests the |
| GET | /api/suministros-ciudadano/estado | open | src/routes/suministros-ciudadano.ts | sum_citizen_enrollments sum_citizen_requests the |
| POST | /api/suministros-ciudadano/pedido | open | src/routes/suministros-ciudadano.ts | sum_citizen_enrollments sum_citizen_requests the |
| POST | /api/suministros-ciudadano/solicitud | open | src/routes/suministros-ciudadano.ts | sum_citizen_enrollments sum_citizen_requests the |
| GET | /api/suministros/categorias | perm:suministros:read | src/routes/suministros-categorias.ts | sum_categorias sum_productos |
| POST | /api/suministros/categorias | perm:suministros:manage | src/routes/suministros-categorias.ts | sum_categorias sum_productos |
| DELETE | /api/suministros/categorias/:id | perm:suministros:manage | src/routes/suministros-categorias.ts | sum_categorias sum_productos |
| PATCH | /api/suministros/categorias/:id | perm:suministros:manage | src/routes/suministros-categorias.ts | sum_categorias sum_productos |
| GET | /api/suministros/conteos | perm:suministros:read | src/routes/suministros-conteos.ts | conteo sum_conteo_lineas sum_conteos sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/conteos | perm:suministros:inventory | src/routes/suministros-conteos.ts | conteo sum_conteo_lineas sum_conteos sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| DELETE | /api/suministros/conteos/:id | perm:suministros:inventory | src/routes/suministros-conteos.ts | conteo sum_conteo_lineas sum_conteos sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/conteos/:id | perm:suministros:read | src/routes/suministros-conteos.ts | conteo sum_conteo_lineas sum_conteos sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| PATCH | /api/suministros/conteos/:id | perm:suministros:inventory | src/routes/suministros-conteos.ts | conteo sum_conteo_lineas sum_conteos sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/conteos/:id/conciliar | perm:suministros:inventory | src/routes/suministros-conteos.ts | conteo sum_conteo_lineas sum_conteos sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/conteos/:id/contar | perm:suministros:inventory | src/routes/suministros-conteos.ts | conteo sum_conteo_lineas sum_conteos sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/conteos/generar | perm:suministros:inventory | src/routes/suministros-conteos.ts | conteo sum_conteo_lineas sum_conteos sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/cuentas | perm:suministros:read | src/routes/suministros-cuentas.ts | mutable sum_cuentas sum_facturas |
| POST | /api/suministros/cuentas | perm:suministros:purchasing | src/routes/suministros-cuentas.ts | mutable sum_cuentas sum_facturas |
| DELETE | /api/suministros/cuentas/:id | perm:suministros:purchasing | src/routes/suministros-cuentas.ts | mutable sum_cuentas sum_facturas |
| PATCH | /api/suministros/cuentas/:id | perm:suministros:purchasing | src/routes/suministros-cuentas.ts | mutable sum_cuentas sum_facturas |
| GET | /api/suministros/donaciones | perm:suministros:read | src/routes/suministros-donaciones.ts | mutable stock sum_donacion_lineas sum_donaciones sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones suministros |
| POST | /api/suministros/donaciones | perm:suministros:purchasing | src/routes/suministros-donaciones.ts | mutable stock sum_donacion_lineas sum_donaciones sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones suministros |
| DELETE | /api/suministros/donaciones/:id | perm:suministros:purchasing | src/routes/suministros-donaciones.ts | mutable stock sum_donacion_lineas sum_donaciones sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones suministros |
| GET | /api/suministros/donaciones/:id | perm:suministros:read | src/routes/suministros-donaciones.ts | mutable stock sum_donacion_lineas sum_donaciones sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones suministros |
| PATCH | /api/suministros/donaciones/:id | perm:suministros:purchasing | src/routes/suministros-donaciones.ts | mutable stock sum_donacion_lineas sum_donaciones sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones suministros |
| POST | /api/suministros/donaciones/:id/recibir | perm:suministros:purchasing | src/routes/suministros-donaciones.ts | mutable stock sum_donacion_lineas sum_donaciones sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones suministros |
| GET | /api/suministros/envios | perm:suministros:read | src/routes/suministros-envios.ts | origen sum_envio_contenedores sum_envio_lineas sum_envios sum_existencias sum_items sum_metodos_envio sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/envios | perm:suministros:dispatch | src/routes/suministros-envios.ts | origen sum_envio_contenedores sum_envio_lineas sum_envios sum_existencias sum_items sum_metodos_envio sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| DELETE | /api/suministros/envios/:id | perm:suministros:dispatch | src/routes/suministros-envios.ts | origen sum_envio_contenedores sum_envio_lineas sum_envios sum_existencias sum_items sum_metodos_envio sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/envios/:id | perm:suministros:read | src/routes/suministros-envios.ts | origen sum_envio_contenedores sum_envio_lineas sum_envios sum_existencias sum_items sum_metodos_envio sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| PATCH | /api/suministros/envios/:id | perm:suministros:dispatch | src/routes/suministros-envios.ts | origen sum_envio_contenedores sum_envio_lineas sum_envios sum_existencias sum_items sum_metodos_envio sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/envios/:id/contenedores | perm:suministros:dispatch | src/routes/suministros-envios.ts | origen sum_envio_contenedores sum_envio_lineas sum_envios sum_existencias sum_items sum_metodos_envio sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/envios/:id/despachar | perm:suministros:dispatch | src/routes/suministros-envios.ts | origen sum_envio_contenedores sum_envio_lineas sum_envios sum_existencias sum_items sum_metodos_envio sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/envios/:id/recibir | perm:suministros:dispatch | src/routes/suministros-envios.ts | origen sum_envio_contenedores sum_envio_lineas sum_envios sum_existencias sum_items sum_metodos_envio sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/etiquetas | perm:suministros:read | src/routes/suministros-etiquetas.ts | sum_categorias sum_existencias sum_items sum_productos |
| GET | /api/suministros/etiquetas/catalogo | perm:suministros:read | src/routes/suministros-etiquetas.ts | sum_categorias sum_existencias sum_items sum_productos |
| GET | /api/suministros/etiquetas/lote/:itemId | perm:suministros:read | src/routes/suministros-etiquetas.ts | sum_categorias sum_existencias sum_items sum_productos |
| GET | /api/suministros/etiquetas/producto/:productoId | perm:suministros:read | src/routes/suministros-etiquetas.ts | sum_categorias sum_existencias sum_items sum_productos |
| GET | /api/suministros/facturas | perm:suministros:read | src/routes/suministros-facturas.ts | lines sum_cuentas sum_factura_lineas sum_facturas sum_productos sum_proveedores users x402_resources |
| POST | /api/suministros/facturas | perm:suministros:purchasing | src/routes/suministros-facturas.ts | lines sum_cuentas sum_factura_lineas sum_facturas sum_productos sum_proveedores users x402_resources |
| DELETE | /api/suministros/facturas/:id | perm:suministros:purchasing | src/routes/suministros-facturas.ts | lines sum_cuentas sum_factura_lineas sum_facturas sum_productos sum_proveedores users x402_resources |
| GET | /api/suministros/facturas/:id | perm:suministros:read | src/routes/suministros-facturas.ts | lines sum_cuentas sum_factura_lineas sum_facturas sum_productos sum_proveedores users x402_resources |
| PATCH | /api/suministros/facturas/:id | perm:suministros:purchasing | src/routes/suministros-facturas.ts | lines sum_cuentas sum_factura_lineas sum_facturas sum_productos sum_proveedores users x402_resources |
| POST | /api/suministros/facturas/:id/generar-enlace-pago | perm:suministros:purchasing | src/routes/suministros-facturas.ts | lines sum_cuentas sum_factura_lineas sum_facturas sum_productos sum_proveedores users x402_resources |
| POST | /api/suministros/facturas/:id/pagar | perm:suministros:purchasing | src/routes/suministros-facturas.ts | lines sum_cuentas sum_factura_lineas sum_facturas sum_productos sum_proveedores users x402_resources |
| GET | /api/suministros/inventario | perm:suministros:read | src/routes/suministros-inventario.ts | sum_categorias sum_existencias sum_items sum_productos sum_ubicaciones |
| GET | /api/suministros/inventario/items | perm:suministros:read | src/routes/suministros-inventario.ts | sum_categorias sum_existencias sum_items sum_productos sum_ubicaciones |
| GET | /api/suministros/inventario/producto/:id | perm:suministros:read | src/routes/suministros-inventario.ts | sum_categorias sum_existencias sum_items sum_productos sum_ubicaciones |
| GET | /api/suministros/kits | perm:suministros:read | src/routes/suministros-kits.ts | kit sum_categorias sum_existencias sum_items sum_kit_lineas sum_kits sum_producto_proveedor sum_productos sum_transaccion_lineas sum_transacciones this |
| POST | /api/suministros/kits | perm:suministros:manage | src/routes/suministros-kits.ts | kit sum_categorias sum_existencias sum_items sum_kit_lineas sum_kits sum_producto_proveedor sum_productos sum_transaccion_lineas sum_transacciones this |
| DELETE | /api/suministros/kits/:id | perm:suministros:manage | src/routes/suministros-kits.ts | kit sum_categorias sum_existencias sum_items sum_kit_lineas sum_kits sum_producto_proveedor sum_productos sum_transaccion_lineas sum_transacciones this |
| GET | /api/suministros/kits/:id | perm:suministros:read | src/routes/suministros-kits.ts | kit sum_categorias sum_existencias sum_items sum_kit_lineas sum_kits sum_producto_proveedor sum_productos sum_transaccion_lineas sum_transacciones this |
| PATCH | /api/suministros/kits/:id | perm:suministros:manage | src/routes/suministros-kits.ts | kit sum_categorias sum_existencias sum_items sum_kit_lineas sum_kits sum_producto_proveedor sum_productos sum_transaccion_lineas sum_transacciones this |
| POST | /api/suministros/kits/:id/ensamblar | perm:suministros:manage | src/routes/suministros-kits.ts | kit sum_categorias sum_existencias sum_items sum_kit_lineas sum_kits sum_producto_proveedor sum_productos sum_transaccion_lineas sum_transacciones this |
| GET | /api/suministros/metodos-envio | perm:suministros:read | src/routes/suministros-metodos-envio.ts | fields sum_metodos_envio |
| POST | /api/suministros/metodos-envio | perm:suministros:dispatch | src/routes/suministros-metodos-envio.ts | fields sum_metodos_envio |
| DELETE | /api/suministros/metodos-envio/:id | perm:suministros:dispatch | src/routes/suministros-metodos-envio.ts | fields sum_metodos_envio |
| PATCH | /api/suministros/metodos-envio/:id | perm:suministros:dispatch | src/routes/suministros-metodos-envio.ts | fields sum_metodos_envio |
| GET | /api/suministros/movimientos | perm:suministros:read | src/routes/suministros-movimientos.ts | a sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/movimientos/:id | perm:suministros:read | src/routes/suministros-movimientos.ts | a sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/movimientos/ajuste | perm:suministros:inventory | src/routes/suministros-movimientos.ts | a sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/movimientos/conteo | perm:suministros:inventory | src/routes/suministros-movimientos.ts | a sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/movimientos/despacho | perm:suministros:dispatch | src/routes/suministros-movimientos.ts | a sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/movimientos/recepcion | perm:suministros:warehouse | src/routes/suministros-movimientos.ts | a sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/movimientos/traslado | perm:suministros:warehouse | src/routes/suministros-movimientos.ts | a sum_existencias sum_items sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/ordenes | perm:suministros:read | src/routes/suministros-ordenes.ts | donaciones stock sum_existencias sum_items sum_orden_lineas sum_ordenes sum_productos sum_proveedores sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/ordenes | perm:suministros:purchasing | src/routes/suministros-ordenes.ts | donaciones stock sum_existencias sum_items sum_orden_lineas sum_ordenes sum_productos sum_proveedores sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| DELETE | /api/suministros/ordenes/:id | perm:suministros:purchasing | src/routes/suministros-ordenes.ts | donaciones stock sum_existencias sum_items sum_orden_lineas sum_ordenes sum_productos sum_proveedores sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/ordenes/:id | perm:suministros:read | src/routes/suministros-ordenes.ts | donaciones stock sum_existencias sum_items sum_orden_lineas sum_ordenes sum_productos sum_proveedores sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| PATCH | /api/suministros/ordenes/:id | perm:suministros:purchasing | src/routes/suministros-ordenes.ts | donaciones stock sum_existencias sum_items sum_orden_lineas sum_ordenes sum_productos sum_proveedores sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/ordenes/:id/recibir | perm:suministros:purchasing | src/routes/suministros-ordenes.ts | donaciones stock sum_existencias sum_items sum_orden_lineas sum_ordenes sum_productos sum_proveedores sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/pagos | perm:suministros:read | src/routes/suministros-pagos.ts | sum_facturas sum_proveedores users x402_payments |
| GET | /api/suministros/picklists | perm:suministros:read | src/routes/suministros-picklists.ts | sum_existencias sum_items sum_picklist_lineas sum_picklists sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/picklists | perm:suministros:dispatch | src/routes/suministros-picklists.ts | sum_existencias sum_items sum_picklist_lineas sum_picklists sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| DELETE | /api/suministros/picklists/:id | perm:suministros:dispatch | src/routes/suministros-picklists.ts | sum_existencias sum_items sum_picklist_lineas sum_picklists sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/picklists/:id | perm:suministros:read | src/routes/suministros-picklists.ts | sum_existencias sum_items sum_picklist_lineas sum_picklists sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| PATCH | /api/suministros/picklists/:id | perm:suministros:dispatch | src/routes/suministros-picklists.ts | sum_existencias sum_items sum_picklist_lineas sum_picklists sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/picklists/:id/completar | perm:suministros:dispatch | src/routes/suministros-picklists.ts | sum_existencias sum_items sum_picklist_lineas sum_picklists sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| POST | /api/suministros/picklists/:id/pick | perm:suministros:dispatch | src/routes/suministros-picklists.ts | sum_existencias sum_items sum_picklist_lineas sum_picklists sum_productos sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/productos | perm:suministros:read | src/routes/suministros-productos.ts | sum_categorias sum_existencias sum_items sum_producto_proveedor sum_productos sum_proveedores |
| POST | /api/suministros/productos | perm:suministros:manage | src/routes/suministros-productos.ts | sum_categorias sum_existencias sum_items sum_producto_proveedor sum_productos sum_proveedores |
| DELETE | /api/suministros/productos/:id | perm:suministros:manage | src/routes/suministros-productos.ts | sum_categorias sum_existencias sum_items sum_producto_proveedor sum_productos sum_proveedores |
| GET | /api/suministros/productos/:id | perm:suministros:read | src/routes/suministros-productos.ts | sum_categorias sum_existencias sum_items sum_producto_proveedor sum_productos sum_proveedores |
| PATCH | /api/suministros/productos/:id | perm:suministros:manage | src/routes/suministros-productos.ts | sum_categorias sum_existencias sum_items sum_producto_proveedor sum_productos sum_proveedores |
| GET | /api/suministros/proveedores | perm:suministros:read | src/routes/suministros-proveedores.ts | a mutable sum_producto_proveedor sum_productos sum_proveedores users |
| POST | /api/suministros/proveedores | perm:suministros:purchasing | src/routes/suministros-proveedores.ts | a mutable sum_producto_proveedor sum_productos sum_proveedores users |
| DELETE | /api/suministros/proveedores/:id | perm:suministros:purchasing | src/routes/suministros-proveedores.ts | a mutable sum_producto_proveedor sum_productos sum_proveedores users |
| GET | /api/suministros/proveedores/:id | perm:suministros:read | src/routes/suministros-proveedores.ts | a mutable sum_producto_proveedor sum_productos sum_proveedores users |
| PATCH | /api/suministros/proveedores/:id | perm:suministros:purchasing | src/routes/suministros-proveedores.ts | a mutable sum_producto_proveedor sum_productos sum_proveedores users |
| GET | /api/suministros/proveedores/:id/precios | perm:suministros:read | src/routes/suministros-proveedores.ts | a mutable sum_producto_proveedor sum_productos sum_proveedores users |
| POST | /api/suministros/proveedores/:id/precios | perm:suministros:purchasing | src/routes/suministros-proveedores.ts | a mutable sum_producto_proveedor sum_productos sum_proveedores users |
| DELETE | /api/suministros/proveedores/precios/:linkId | perm:suministros:purchasing | src/routes/suministros-proveedores.ts | a mutable sum_producto_proveedor sum_productos sum_proveedores users |
| PATCH | /api/suministros/proveedores/precios/:linkId | perm:suministros:purchasing | src/routes/suministros-proveedores.ts | a mutable sum_producto_proveedor sum_productos sum_proveedores users |
| GET | /api/suministros/proveedores/producto/:productoId | perm:suministros:read | src/routes/suministros-proveedores.ts | a mutable sum_producto_proveedor sum_productos sum_proveedores users |
| GET | /api/suministros/reportes/caducidad | perm:suministros:read | src/routes/suministros-reportes.ts | sum_categorias sum_existencias sum_items sum_producto_proveedor sum_productos sum_requisicion_lineas sum_requisiciones sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/reportes/fill-rate | perm:suministros:read | src/routes/suministros-reportes.ts | sum_categorias sum_existencias sum_items sum_producto_proveedor sum_productos sum_requisicion_lineas sum_requisiciones sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/reportes/ledger | perm:suministros:read | src/routes/suministros-reportes.ts | sum_categorias sum_existencias sum_items sum_producto_proveedor sum_productos sum_requisicion_lineas sum_requisiciones sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/reportes/rotacion | perm:suministros:read | src/routes/suministros-reportes.ts | sum_categorias sum_existencias sum_items sum_producto_proveedor sum_productos sum_requisicion_lineas sum_requisiciones sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/reportes/valuacion | perm:suministros:read | src/routes/suministros-reportes.ts | sum_categorias sum_existencias sum_items sum_producto_proveedor sum_productos sum_requisicion_lineas sum_requisiciones sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/requisiciones | perm:suministros:read | src/routes/suministros-requisiciones.ts | origen sum_existencias sum_items sum_productos sum_requisicion_lineas sum_requisiciones sum_transaccion_lineas sum_transacciones sum_ubicaciones the |
| POST | /api/suministros/requisiciones | perm:suministros:warehouse | src/routes/suministros-requisiciones.ts | origen sum_existencias sum_items sum_productos sum_requisicion_lineas sum_requisiciones sum_transaccion_lineas sum_transacciones sum_ubicaciones the |
| DELETE | /api/suministros/requisiciones/:id | perm:suministros:warehouse | src/routes/suministros-requisiciones.ts | origen sum_existencias sum_items sum_productos sum_requisicion_lineas sum_requisiciones sum_transaccion_lineas sum_transacciones sum_ubicaciones the |
| GET | /api/suministros/requisiciones/:id | perm:suministros:read | src/routes/suministros-requisiciones.ts | origen sum_existencias sum_items sum_productos sum_requisicion_lineas sum_requisiciones sum_transaccion_lineas sum_transacciones sum_ubicaciones the |
| PATCH | /api/suministros/requisiciones/:id | perm:suministros:warehouse | src/routes/suministros-requisiciones.ts | origen sum_existencias sum_items sum_productos sum_requisicion_lineas sum_requisiciones sum_transaccion_lineas sum_transacciones sum_ubicaciones the |
| POST | /api/suministros/requisiciones/:id/surtir | perm:suministros:warehouse | src/routes/suministros-requisiciones.ts | origen sum_existencias sum_items sum_productos sum_requisicion_lineas sum_requisiciones sum_transaccion_lineas sum_transacciones sum_ubicaciones the |
| GET | /api/suministros/tablero/alertas | perm:suministros:read | src/routes/suministros-tablero.ts | sum_categorias sum_existencias sum_items sum_productos sum_requisiciones sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/tablero/mapa | perm:suministros:read | src/routes/suministros-tablero.ts | sum_categorias sum_existencias sum_items sum_productos sum_requisiciones sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/tablero/movimientos-recientes | perm:suministros:read | src/routes/suministros-tablero.ts | sum_categorias sum_existencias sum_items sum_productos sum_requisiciones sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/tablero/resumen | perm:suministros:read | src/routes/suministros-tablero.ts | sum_categorias sum_existencias sum_items sum_productos sum_requisiciones sum_transaccion_lineas sum_transacciones sum_ubicaciones |
| GET | /api/suministros/ubicaciones | perm:suministros:read | src/routes/suministros-ubicaciones.ts | mutable sum_existencias sum_ubicaciones |
| POST | /api/suministros/ubicaciones | perm:suministros:manage | src/routes/suministros-ubicaciones.ts | mutable sum_existencias sum_ubicaciones |
| DELETE | /api/suministros/ubicaciones/:id | perm:suministros:manage | src/routes/suministros-ubicaciones.ts | mutable sum_existencias sum_ubicaciones |
| GET | /api/suministros/ubicaciones/:id | perm:suministros:read | src/routes/suministros-ubicaciones.ts | mutable sum_existencias sum_ubicaciones |
| PATCH | /api/suministros/ubicaciones/:id | perm:suministros:manage | src/routes/suministros-ubicaciones.ts | mutable sum_existencias sum_ubicaciones |
| GET | /api/support/admin/settings | open | src/routes/support.ts | feature_flags support_messages support_tickets the this |
| PUT | /api/support/admin/settings | open | src/routes/support.ts | feature_flags support_messages support_tickets the this |
| GET | /api/support/admin/stats | open | src/routes/support.ts | feature_flags support_messages support_tickets the this |
| GET | /api/support/admin/tickets | open | src/routes/support.ts | feature_flags support_messages support_tickets the this |
| GET | /api/support/admin/tickets/:id | open | src/routes/support.ts | feature_flags support_messages support_tickets the this |
| PATCH | /api/support/admin/tickets/:id | open | src/routes/support.ts | feature_flags support_messages support_tickets the this |
| POST | /api/support/admin/tickets/:id/reply | open | src/routes/support.ts | feature_flags support_messages support_tickets the this |
| GET | /api/support/tickets | open | src/routes/support.ts | feature_flags support_messages support_tickets the this |
| POST | /api/support/tickets | open | src/routes/support.ts | feature_flags support_messages support_tickets the this |
| GET | /api/support/tickets/:id | open | src/routes/support.ts | feature_flags support_messages support_tickets the this |
| POST | /api/support/tickets/:id/close | open | src/routes/support.ts | feature_flags support_messages support_tickets the this |
| POST | /api/support/tickets/:id/reply | open | src/routes/support.ts | feature_flags support_messages support_tickets the this |
| GET | /api/telegram/health | open |  |  |
| POST | /api/telegram/webhook | open |  |  |
| GET | /api/telemedicina/appointment/:id/ics | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/appt/:id/file/:fid | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/appt/:id/ics | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/book/appointment/:token | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/telemedicina/book/appointment/:token/cancel | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/telemedicina/book/appointment/:token/checkin | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/telemedicina/book/appointment/:token/files | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/telemedicina/book/appointment/:token/waiting | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/telemedicina/book/appointments | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/book/doctors | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/book/doctors/:id | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/book/doctors/:id/slots | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/calendar | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/catalog | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/doctors | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/telemedicina/doctors/:id/approve | perm:persons:moderate | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/telemedicina/doctors/:id/reject | perm:persons:moderate | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/doctors/me | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/doctors/pending | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/telemedicina/doctors/register | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/panel/appointment/:id | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| PUT | /api/telemedicina/panel/appointment/:id/consult | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/telemedicina/panel/appointment/:id/files | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/telemedicina/panel/appointment/:id/note | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/telemedicina/panel/appointment/:id/prescription | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/panel/appointments | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/telemedicina/panel/appointments/:id/status | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/panel/availability | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| PUT | /api/telemedicina/panel/availability | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/telemedicina/panel/blocks | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| DELETE | /api/telemedicina/panel/blocks/:id | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/panel/patients | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/panel/patients/:key/history | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/request/:token | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| GET | /api/telemedicina/requests | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/telemedicina/requests | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/telemedicina/requests/:id/claim | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/telemedicina/requests/:id/complete | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/telemedicina/requests/:id/schedule | open | src/routes/telemedicina.ts | telemed_doctors telemed_requests |
| POST | /api/triage | open | src/routes/triage.ts | map_reports one personas rav_reports |
| GET | /api/u/:id | open | src/routes/public-profile.ts | kv the users x402_payments x402_resources |
| GET | /api/u/:id/avatar | open | src/routes/public-profile.ts | kv the users x402_payments x402_resources |
| GET | /api/u/:id/campana/:slug | open | src/routes/public-profile.ts | kv the users x402_payments x402_resources |
| GET | /api/u/:id/cobro/:slug | open | src/routes/public-profile.ts | kv the users x402_payments x402_resources |
| GET | /api/v1 | open | src/routes/data-api.ts | api_clients |
| GET | /api/v1/data/blog | open | src/routes/data-api.ts | api_clients |
| GET | /api/v1/data/earthquakes | open | src/routes/data-api.ts | api_clients |
| GET | /api/v1/data/missing-persons | open | src/routes/data-api.ts | api_clients |
| GET | /api/v1/data/shelters | open | src/routes/data-api.ts | api_clients |
| GET | /api/v1/data/stats | open | src/routes/data-api.ts | api_clients |
| GET | /api/v1/earthquakes | open | src/routes/data-api.ts | api_clients |
| GET | /api/v1/earthquakes/:id | open | src/routes/data-api.ts | api_clients |
| GET | /api/v1/latest | open | src/routes/data-api.ts | api_clients |
| GET | /api/v1/me | open | src/routes/data-api.ts | api_clients |
| POST | /api/v1/register | open | src/routes/data-api.ts | api_clients |
| GET | /api/v1/stats | open | src/routes/data-api.ts | api_clients |
| GET | /api/verified-info | open | src/routes/donations.ts | campaigns crossmint donations paid the |
| GET | /api/voluntarios | open | src/routes/voluntarios.ts | both rav_reports text the their volunteers |
| GET | /api/voluntarios/contact/:id | open | src/routes/voluntarios.ts | both rav_reports text the their volunteers |
| GET | /api/voluntarios/directory | open | src/routes/voluntarios.ts | both rav_reports text the their volunteers |
| GET | /api/voluntarios/profile/:id | open | src/routes/voluntarios.ts | both rav_reports text the their volunteers |
| POST | /api/voluntarios/register | open | src/routes/voluntarios.ts | both rav_reports text the their volunteers |
| GET | /api/voluntarios/stats | open | src/routes/voluntarios.ts | both rav_reports text the their volunteers |
| GET | /api/x402/admin/reconcile | open | src/routes/x402.ts | a index one row the users x402_payments x402_resource_prices x402_resources |
| GET | /api/x402/health | open | src/routes/x402.ts | a index one row the users x402_payments x402_resource_prices x402_resources |
| GET | /api/x402/me | open | src/routes/x402.ts | a index one row the users x402_payments x402_resource_prices x402_resources |
| GET | /api/x402/pay/:userId/:slug | open | src/routes/x402.ts | a index one row the users x402_payments x402_resource_prices x402_resources |
| GET | /api/x402/payments | open | src/routes/x402.ts | a index one row the users x402_payments x402_resource_prices x402_resources |
| GET | /api/x402/resources | open | src/routes/x402.ts | a index one row the users x402_payments x402_resource_prices x402_resources |
| POST | /api/x402/resources | open | src/routes/x402.ts | a index one row the users x402_payments x402_resource_prices x402_resources |
