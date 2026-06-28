# D1 migrations — numbering rules

`wrangler d1 migrations apply sismo911` runs every `NNNN_*.sql` file in **filename
order**. Two rules keep this safe:

1. **Monotonic, unique numbers.** Each new migration gets the **next free 4-digit
   prefix** — never reuse a number that already exists on any branch.
2. **Idempotent SQL.** `CREATE TABLE/INDEX … IF NOT EXISTS`; for `ALTER … ADD
   COLUMN`, gate it or accept that a re-run errors. The remote `d1_migrations`
   tracker was reconciled 2026-06-27 and is honest — keep it that way (if you ever
   apply schema by hand on remote, also `INSERT OR IGNORE INTO d1_migrations(name)`).

## ➡️ The next migration number = (current highest **+ 1**) — compute it, don't guess.

Concurrent divisions keep adding migrations, so any number written here goes stale.
**Always** compute the next free number right before you add a file:

```bash
# highest 4-digit prefix in use → add 1, zero-padded to 4
ls migrations | grep -oE '^[0-9]{4}' | sort -n | tail -1
```

As of this README's last update the highest was **0047** (`0047_rbac_seed.sql`), so
the next migration is **0048**. Recompute with the command above — do **not** reuse
or hardcode a number.

## Numbering sprawl (historical — do not repeat)

Multiple divisions (FLOTA, SUMINISTROS, RBAC) plus a volunteers change were built in
parallel and **collided on many numbers**. Duplicate prefixes are a long-standing,
repo-wide pattern — e.g. `0009`, `0012`, `0013`, `0014`, `0020`, `0021`, `0022`,
`0028`, and recently `0038`, `0039`, `0045`. All files were applied and recorded; the
collisions are harmless (every table is additive / `IF NOT EXISTS`) but make the
sequence non-obvious. Recent stretch:

| # | Files (collisions in **bold**) |
|---|---|
| 0037 | `0037_flota.sql` |
| 0038 | **`0038_flota_unit_tokens.sql`** · **`0038_suministros.sql`** |
| 0039 | **`0039_sum_proveedores.sql`** · **`0039_volunteers_social.sql`** |
| 0040–0044 | `0040_sum_donaciones` · `0041_sum_ordenes` · `0042_sum_facturas` · `0043_sum_picklists` · `0044_sum_envios` |
| 0045 | **`0045_fleet_live_gps.sql`** · **`0045_sum_conteos.sql`** |
| 0046–0047 | `0046_rbac_workforce` · `0047_rbac_seed` |

Note: `0045_fleet_live_gps.sql` carries the live-GPS schema the spec labelled
"0039" — `0039`–`0044` were already taken, so it shipped as `0045`. The empty legacy
`flota_unit_tokens` (`0038_flota_unit_tokens.sql`) was replaced by the richer table
in `0045_fleet_live_gps.sql`.

**Rule of thumb:** one migration number = one file. Before committing, recompute the
next free number (command above) and pick strictly greater than the current highest.
