#!/usr/bin/env python3
"""
Filter ALL still-missing persons WITH a photo from the existing desaparecidos DB
(DESAP / desaparecidos-vzla) and emit, per person, a link to the existing DB
(photo) + a prefilled case link. Writes JSON + pushes a "Desaparecidas (con foto)"
tab to the monitor sheet.

  python3 scripts/export-missing-with-photos.py
"""
import subprocess, json, os, sys, urllib.parse

DB = 'sismo911'  # single source of truth — the DB the live app reads/writes
BASE = 'https://sismo911.com'
SHEET = '1gHZ40ajgcZvK8aHKdmwP5p7ARBVtdMtP6M36bIHXOts'  # monitor sheet
TAB = 'Desaparecidas (con foto)'
OUT = os.path.join(os.path.dirname(__file__), '..', 'missing_with_photos.json')
PAGE = 2000

ENV = {**os.environ}
ENV.pop('CLOUDFLARE_API_TOKEN', None); ENV.pop('CLOUDFLARE_ACCOUNT_ID', None)  # use gmail OAuth

WHERE = "estado='sin-contacto' AND foto_r2 IS NOT NULL AND moderation='approved'"

def d1(sql):
    out = subprocess.run(['npx', 'wrangler', 'd1', 'execute', DB, '--remote', '--json', '--command', sql],
                         capture_output=True, text=True, env=ENV)
    if out.returncode != 0:
        sys.stderr.write(out.stderr[-800:]); raise SystemExit('wrangler d1 failed')
    return json.loads(out.stdout)[0]['results']

def case_link(nombre, lugar):
    qs = urllib.parse.urlencode({'reportar': '1', 'nombre': nombre or '', 'lugar': lugar or '', 'ref': BASE + '/personas'})
    return f'{BASE}/familia?{qs}'

# ---- page through all still-missing-with-photo (REUSE=1 to skip re-query) ----
if os.environ.get('REUSE') and os.path.exists(OUT):
    recs = json.load(open(OUT))
    print(f'reusing {len(recs)} records from {OUT}')
    rows = None
else:
    rows, off = [], 0
    while True:
        page = d1(f"SELECT id,nombre,edad,ubicacion FROM personas WHERE {WHERE} ORDER BY id LIMIT {PAGE} OFFSET {off}")
        rows += page
        print(f'  fetched {len(rows)} …')
        if len(page) < PAGE:
            break
        off += PAGE

if rows is not None:
    recs = [{
        'id': p['id'], 'nombre': p.get('nombre') or '', 'edad': p.get('edad'),
        'ubicacion': p.get('ubicacion') or '',
        'foto_db': f"{BASE}/api/familia/photo/{p['id']}",           # link to existing DB (photo)
        'caso': case_link(p.get('nombre'), p.get('ubicacion')),     # prefilled case link
    } for p in rows]
    json.dump(recs, open(OUT, 'w'), ensure_ascii=False, indent=1)
print(f'still-missing WITH photo: {len(recs)} → {OUT}')

# ---- push to monitor sheet ----
try:
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    creds = Credentials.from_authorized_user_file(os.path.expanduser('~/.gcp/token.json'))
    svc = build('sheets', 'v4', credentials=creds)
    meta = svc.spreadsheets().get(spreadsheetId=SHEET).execute()
    if TAB not in [s['properties']['title'] for s in meta['sheets']]:
        svc.spreadsheets().batchUpdate(spreadsheetId=SHEET, body={'requests': [{'addSheet': {'properties': {'title': TAB}}}]}).execute()
    # ensure the tab grid is tall enough (new tabs default to 1000 rows)
    sid = [s['properties']['sheetId'] for s in svc.spreadsheets().get(spreadsheetId=SHEET).execute()['sheets'] if s['properties']['title'] == TAB][0]
    svc.spreadsheets().batchUpdate(spreadsheetId=SHEET, body={'requests': [
        {'updateSheetProperties': {'properties': {'sheetId': sid, 'gridProperties': {'rowCount': len(recs) + 10, 'columnCount': 8, 'frozenRowCount': 1}}, 'fields': 'gridProperties(rowCount,columnCount,frozenRowCount)'}}]}).execute()
    header = [['ID', 'Nombre', 'Edad', 'Ubicación', 'Foto (DB)', 'Caso (vincular)']]
    svc.spreadsheets().values().clear(spreadsheetId=SHEET, range=f"'{TAB}'!A1:F{len(recs)+10}").execute()
    svc.spreadsheets().values().update(spreadsheetId=SHEET, range=f"'{TAB}'!A1", valueInputOption='RAW', body={'values': header}).execute()
    body = [[r['id'], r['nombre'], r['edad'], r['ubicacion'], r['foto_db'], r['caso']] for r in recs]
    for i in range(0, len(body), 5000):  # chunk
        svc.spreadsheets().values().update(spreadsheetId=SHEET, range=f"'{TAB}'!A{2+i}", valueInputOption='RAW', body={'values': body[i:i+5000]}).execute()
        print(f'  sheet rows {i+1}-{i+len(body[i:i+5000])}')
    print(f'pushed {len(body)} rows → sheet tab "{TAB}"')
except Exception as e:
    print('sheet push skipped:', e)
