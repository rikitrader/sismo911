# SISMO911 — Duplicate cleanup FINAL report

Run: dedupe-existing-1783304975078 · 2026-07-06T02:42:20.867Z · mode: execute

## personas

- groups scanned: 38677 · rows pulled: 97936
- candidate pairs: 49266 → **auto-safe: 22679** · review: 26587 · with CRITICAL status conflicts: 36

  - AUTO 100pts [name_fuzzy+age+municipality+state+last_seen] keep p7c68e499f4a6 ← rav_d8ab3115-3126-44de-a5f5-5a693378e5d7 (“Abel Cardenas” / “Abel cardenas”)
  - AUTO 100pts [name_fuzzy+age+municipality+state+last_seen] keep p9e57aebf1b3f ← civis_413b1f09-7f3b-4f85-98ca-ec75955d7192 (“Ada Lugo” / “Ada lugo”)
  - AUTO 100pts [name_fuzzy+age+municipality+state+last_seen] keep p9e57aebf1b3f ← rav_699924f2-96bc-4421-8425-387765896edc (“Ada Lugo” / “Ada lugo”)
  - AUTO 100pts [name_fuzzy+age+municipality+state+last_seen] keep civis_413b1f09-7f3b-4f85-98ca-ec75955d7192 ← rav_699924f2-96bc-4421-8425-387765896edc (“Ada lugo” / “Ada lugo”)
  - AUTO 100pts [name_fuzzy+age+municipality+state+last_seen] keep p7e9a647cb89a ← pe46d38e11175 (“Adriana Ángulo” / “Adriana Angulo”)
  - AUTO 100pts [name_fuzzy+age+municipality+state+last_seen] keep p7e9a647cb89a ← civis_c3e98182-e8f4-4efe-9445-e11f61336ebf (“Adriana Angulo” / “Adriana angulo”)
  - AUTO 100pts [name_fuzzy+age+municipality+state+last_seen] keep p451ff3bed2e5 ← civis_2de2b5ae-5961-4fd3-b062-d152cef62e7f (“Adriana Valladares” / “Adriana Valladares”)
  - AUTO 100pts [name_fuzzy+age+municipality+state+last_seen] keep pc995063fae8e ← rav_9730951f-58a6-4ccd-8f73-73724255939f (“Albelis Arias” / “Albelis arias”)
  - AUTO 100pts [name_fuzzy+age+municipality+state+last_seen] keep p99e38ffcb895 ← civis_0228a2e0-89c1-462c-81d9-47d05c366c9f (“Albelis Arias” / “Albelis arias”)
  - AUTO 100pts [name_fuzzy+age+municipality+state+last_seen] keep p654e1ab12bee ← civis_ef963ee9-9ea1-4197-bbc7-7b43f57621c2 (“Alberto Barrios” / “alberto barrios”)
  - AUTO 100pts [name_fuzzy+age+municipality+state+last_seen] keep p654e1ab12bee ← rav_a6bca5b3-515d-41ce-9945-6f7d85e7a32e (“Alberto Barrios” / “alberto barrios”)
  - AUTO 100pts [name_fuzzy+age+municipality+state+last_seen] keep p622111d3806b ← civis_a0e12ce0-f90a-48d4-b5eb-2bddaa090698 (“Alberto Barrios” / “Alberto barrios”)
  - AUTO 100pts [name_fuzzy+age+municipality+state+last_seen] keep civis_ef963ee9-9ea1-4197-bbc7-7b43f57621c2 ← rav_a6bca5b3-515d-41ce-9945-6f7d85e7a32e (“alberto barrios” / “alberto barrios”)
  - AUTO 100pts [name_fuzzy+age+municipality+state+last_seen] keep p8f7701f73de3 ← civis_9a1bf9a2-8787-433b-9ece-04042e5fa18a (“Alexander Sanoja” / “Alexander sanoja”)
  - AUTO 100pts [name_fuzzy+age+municipality+state+last_seen] keep p177636ac921e ← civis_cbe36b7d-a8f8-4eac-a23b-047da246830d (“Alonso Guevara” / “Alonso Guevara”)
  - … 22664 more auto-safe pairs (full list in JSON)

## hospital_patients

- groups scanned: 46 · rows pulled: 121
- candidate pairs: 87 → **auto-safe: 87** · review: 0 · with CRITICAL status conflicts: 0

  - AUTO 90pts [phone] keep hp_59067b1a ← hp_be80e82d (“Edis Lopez” / “Rebello Branedys”)
  - AUTO 90pts [phone] keep hp_acac695c ← hp_7fb80f16 (“Gonzalez Edgar” / “Savedra Edid”)
  - AUTO 90pts [phone] keep hp_9650d617 ← hp_5c006cf1 (“Henrique Maria” / “Rodrigues Glendys”)
  - AUTO 90pts [phone] keep hp_04a0447d ← hp_c6c8cdca (“Ibarra Wilmer” / “Regardis Jose”)
  - AUTO 90pts [phone] keep hp_04a0447d ← hp_eb0d8735 (“Ibarra Wilmer” / “Romero Yuleidys”)
  - AUTO 90pts [phone] keep hp_eb0d8735 ← hp_c6c8cdca (“Regardis Jose” / “Romero Yuleidys”)
  - AUTO 90pts [phone] keep hp_63e0c07f ← hp_fe642590 (“Liz Closier” / “Dayana Carolina Orama Rodriguez”)
  - AUTO 90pts [phone] keep hp_f632dcb4 ← hp_83b256cc (“Montilla Nancy” / “Rendon Cruza”)
  - AUTO 90pts [phone] keep hp_5113f5af ← hp_cb1b9d04 (“Moyano Jaime” / “Fran Rondon”)
  - AUTO 90pts [phone] keep hp_cb1b9d04 ← hp_d92181cb (“Moyano Jaime” / “Rerria Herlina”)
  - AUTO 90pts [phone] keep hp_5113f5af ← hp_d92181cb (“Fran Rondon” / “Rerria Herlina”)
  - AUTO 90pts [phone] keep hp_5df2118f ← hp_bf307f2d (“Sobeida Oropeza” / “Rlzzias Ibseni”)
  - AUTO 90pts [phone] keep hp_8daf571d ← hp_7c7c64de (“Barbara Dunez Ramirez de Reyes” / “Rodriguez Lucena Freddy Alixo”)
  - AUTO 90pts [phone] keep hp_8daf571d ← hp_bd7ca2d2 (“Barbara Dunez Ramirez de Reyes” / “Gonzalez Yurmis”)
  - AUTO 90pts [phone] keep hp_7c7c64de ← hp_bd7ca2d2 (“Rodriguez Lucena Freddy Alixo” / “Gonzalez Yurmis”)
  - … 72 more auto-safe pairs (full list in JSON)

## aid_orgs

- groups scanned: 4 · rows pulled: 10
- candidate pairs: 9 → **auto-safe: 9** · review: 0 · with CRITICAL status conflicts: 0

  - AUTO 90pts [email] keep aid_0082 ← aid_0083 (“Cabinet Office – Resilience Directorate” / “Office of Emergency Planning”)
  - AUTO 90pts [email] keep aid_0102 ← aid_0103 (“Fire Rescue Service (HZS ČR)” / “Min. Interior – Crisis Mgmt Section”)
  - AUTO 90pts [email] keep aid_0118 ← aid_0123 (“MChS (Min. for Emergency Situations)” / “EMERCOM (MChS)”)
  - AUTO 90pts [email] keep aid_0030 ← aid_0033 (“UNDRR (UN Office for Disaster Risk Reduction)” / “EU ERCC / DG ECHO (Emergency Response Coordination Centre)”)
  - AUTO 90pts [email] keep aid_0030 ← aid_0034 (“UNDRR (UN Office for Disaster Risk Reduction)” / “World Bank GFDRR (Global Facility for Disaster Reduction & Recovery)”)
  - AUTO 90pts [email] keep aid_0030 ← aid_0046 (“UNDRR (UN Office for Disaster Risk Reduction)” / “JICA – Japan Disaster Relief (JDR)”)
  - AUTO 90pts [email] keep aid_0033 ← aid_0034 (“EU ERCC / DG ECHO (Emergency Response Coordination Centre)” / “World Bank GFDRR (Global Facility for Disaster Reduction & Recovery)”)
  - AUTO 90pts [email] keep aid_0033 ← aid_0046 (“EU ERCC / DG ECHO (Emergency Response Coordination Centre)” / “JICA – Japan Disaster Relief (JDR)”)
  - AUTO 90pts [email] keep aid_0034 ← aid_0046 (“World Bank GFDRR (Global Facility for Disaster Reduction & Recovery)” / “JICA – Japan Disaster Relief (JDR)”)

## Executed

- auto-merged: 22679 (run_id dedupe-existing-1783304975078, restore: `bun scripts/merge-duplicates.ts --restore=dedupe-existing-1783304975078 --apply`)
- queued for human review: 26683 (dedupe_candidates)

