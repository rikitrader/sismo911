#!/usr/bin/env python3
"""
Dedupe the SISMO911 missing-persons registry (`personas`) by PHOTO and merge every
duplicate report of the same person into ONE consolidated record.

Two-stage matching (the "both" strategy):
  Stage A — perceptual hash (imagehash):     collapse reposts of the SAME image.
  Stage B — face recognition (InsightFace):  cluster DIFFERENT photos of the SAME face.
A union-find combines both signals, so two reports tie together if EITHER their
image is a repost OR their faces match.

Stage B is a pluggable ArcFace-grade engine (--engine), a big accuracy jump over
dlib on low-light / partial / non-frontal disaster photos. Both emit a face
embedding compared by COSINE distance, so clustering/merge is identical:

  deepface   (default)  serengil/deepface — DeepFace.represent(model_name='ArcFace',
                        detector_backend='retinaface'). Pure pip, library is MIT.
  insightface           deepinsight/insightface — RetinaFace + ArcFace (buffalo_l)
                        via ONNX Runtime.

LICENSE NOTE: the DeepFace *library* is MIT; the pretrained ArcFace / InsightFace
buffalo_* weights are licensed for non-commercial research use — which COVERS this
humanitarian, non-commercial deployment. ArcFace is kept as the default for its
accuracy. Only revisit (e.g. switch to --face-model Facenet512) if SISMO911 is ever
commercialized.

Output: a single JSON file (default ../merged_personas.json) — one object per real
person, carrying the union of all names / ages / locations / notes / contacts seen
across its source reports, the best photo, and full provenance (`fuentes`).

Polling: reads `personas` straight from D1 via wrangler (same as
export-missing-with-photos.py) so it sees every field incl. unmasked `contacto`.
Photos are pulled from the public endpoint /api/familia/photo/<id> (R2, with a
302 fallback to the external `foto` URL — requests follows it).

Setup (one-time):
  pip install requests Pillow imagehash numpy scikit-learn
  # default engine (DeepFace):
  pip install deepface tf-keras
  # OR the insightface engine instead:
  pip install insightface onnxruntime
  # First face run auto-downloads the model weights (~/.deepface or ~/.insightface).

Run:
  python3 scripts/dedupe-personas-faces.py                       # full, DeepFace
  python3 scripts/dedupe-personas-faces.py --max 500             # quick test slice
  python3 scripts/dedupe-personas-faces.py --only-missing        # still-missing only
  python3 scripts/dedupe-personas-faces.py --engine insightface  # use InsightFace

Caching: photos -> .cache/photos/, face encodings -> .cache/encodings.pkl
(keyed by image content hash). Re-runs are cheap; delete .cache to force a redo.
"""
import argparse, json, os, pickle, subprocess, sys, hashlib
from collections import defaultdict

BASE = 'https://sismo911.com'
DEFAULT_DB = 'sismo911'  # single source of truth — the DB the live app reads/writes (binding DB)
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, '.cache')
PHOTO_DIR = os.path.join(CACHE, 'photos')
ENC_CACHE = os.path.join(CACHE, 'encodings.pkl')
DEFAULT_OUT = os.path.join(HERE, '..', 'merged_personas.json')

# wrangler must use the gmail OAuth session, not the icloud env token.
ENV = {**os.environ}
ENV.pop('CLOUDFLARE_API_TOKEN', None)
ENV.pop('CLOUDFLARE_ACCOUNT_ID', None)


# ---------------------------------------------------------------- 1. POLL ----
def d1(db, sql):
    out = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', db, '--remote', '--json', '--command', sql],
        capture_output=True, text=True, env=ENV)
    if out.returncode != 0:
        sys.stderr.write(out.stderr[-1000:])
        raise SystemExit('wrangler d1 execute failed')
    return json.loads(out.stdout)[0]['results']


def poll(db, only_missing, page=2000, cap=None):
    """Page through personas. Returns list of dicts with the fields we merge on."""
    where = "foto_r2 IS NOT NULL OR foto != ''"           # only rows that HAVE a photo
    if only_missing:
        where = f"estado='sin-contacto' AND ({where})"
    rows, off = [], 0
    while True:
        sql = (f"SELECT id,nombre,edad,ubicacion,descripcion,contacto,estado,updated_at "
               f"FROM personas WHERE {where} ORDER BY id LIMIT {page} OFFSET {off}")
        chunk = d1(db, sql)
        rows += chunk
        print(f'  polled {len(rows)} rows …')
        if cap and len(rows) >= cap:
            return rows[:cap]
        if len(chunk) < page:
            return rows
        off += page


# ------------------------------------------------------------ 2. DOWNLOAD ----
def download_photos(rows):
    """Fetch each person's photo into PHOTO_DIR/<id>.bin. Returns id -> local path
    (only for rows whose photo actually downloaded)."""
    import requests
    os.makedirs(PHOTO_DIR, exist_ok=True)
    sess = requests.Session()
    paths, fail = {}, 0
    for i, r in enumerate(rows):
        pid = r['id']
        dest = os.path.join(PHOTO_DIR, f'{pid}.bin')
        if not os.path.exists(dest) or os.path.getsize(dest) == 0:
            try:
                resp = sess.get(f'{BASE}/api/familia/photo/{pid}', timeout=30)
                if resp.status_code != 200 or not resp.content:
                    fail += 1
                    continue
                with open(dest, 'wb') as fh:
                    fh.write(resp.content)
            except Exception as e:
                fail += 1
                continue
        paths[pid] = dest
        if (i + 1) % 200 == 0:
            print(f'  downloaded {i + 1}/{len(rows)} (failed {fail})')
    print(f'  photos ready: {len(paths)}  (no/failed photo: {fail})')
    return paths


# -------------------------------------------------------------- UNION-FIND ----
class UF:
    def __init__(self, items):
        self.p = {x: x for x in items}

    def find(self, x):
        while self.p[x] != x:
            self.p[x] = self.p[self.p[x]]
            x = self.p[x]
        return x

    def union(self, a, b):
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.p[ra] = rb

    def groups(self):
        g = defaultdict(list)
        for x in self.p:
            g[self.find(x)].append(x)
        return list(g.values())


# ---------------------------------------------------- STAGE A: PERCEPTUAL ----
def phash_stage(paths, threshold):
    """Return (id->hashstr, list of (a,b) edges to union for near-dup images).
    threshold=0 -> only exact-equal hashes are linked (fast, catches true reposts).
    threshold>0 -> also link images within `threshold` Hamming bits (BK-tree)."""
    from PIL import Image
    import imagehash
    hashes = {}
    for pid, path in paths.items():
        try:
            with Image.open(path) as im:
                hashes[pid] = imagehash.phash(im.convert('RGB'))
        except Exception:
            pass  # unreadable image -> no phash, stays a face-only singleton
    edges = []
    buckets = defaultdict(list)
    for pid, h in hashes.items():
        buckets[str(h)].append(pid)
    for ids in buckets.values():                      # exact reposts
        for j in range(1, len(ids)):
            edges.append((ids[0], ids[j]))
    if threshold > 0:                                  # near-dup via pairwise within bucket reps
        reps = [(ids[0], hashes[ids[0]]) for ids in buckets.values()]
        for i in range(len(reps)):
            for j in range(i + 1, len(reps)):
                if reps[i][1] - reps[j][1] <= threshold:
                    edges.append((reps[i][0], reps[j][0]))
    print(f'  phash: {len(hashes)} hashed, {len(buckets)} distinct images, {len(edges)} dup-edges')
    return {pid: str(h) for pid, h in hashes.items()}, edges


# --------------------------------------------------------- STAGE B: FACES ----
def _content_key(path):
    with open(path, 'rb') as fh:
        return hashlib.sha1(fh.read()).hexdigest()


def _load_bgr(path):
    """Decode the cached photo (any format/extension) to an RGB->BGR numpy array."""
    import numpy as np
    from PIL import Image
    with Image.open(path) as im:
        return np.asarray(im.convert('RGB'))[:, :, ::-1].copy()


def _deepface_encoder(model, detector, min_score):
    """Closure: BGR image -> embedding (np float32) or None. ArcFace via DeepFace."""
    import numpy as np
    from deepface import DeepFace

    def encode(img):
        try:
            reps = DeepFace.represent(img, model_name=model, detector_backend=detector,
                                      enforce_detection=True, align=True)
        except Exception:
            return None  # no face detected (DeepFace raises) or decode error
        reps = [r for r in reps if r.get('face_confidence', 1.0) >= min_score]
        if not reps:
            return None
        # largest detected face = the subject
        best = max(reps, key=lambda r: (r.get('facial_area', {}).get('w', 0)
                                        * r.get('facial_area', {}).get('h', 0)))
        return np.asarray(best['embedding'], dtype='float32')

    return encode


def _insightface_encoder(model, det_size, min_score):
    """Closure: BGR image -> 512-d normed embedding or None. ArcFace via InsightFace."""
    import numpy as np
    from insightface.app import FaceAnalysis
    app = FaceAnalysis(name=model, providers=['CPUExecutionProvider'])
    app.prepare(ctx_id=-1, det_size=(det_size, det_size))  # ctx_id=-1 -> CPU

    def encode(img):
        faces = [f for f in app.get(img) if f.det_score >= min_score]
        if not faces:
            return None
        best = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        return np.asarray(best.normed_embedding, dtype='float32')

    return encode


def face_stage(paths, tolerance, engine, model, detector, det_size, min_score):
    """One ArcFace embedding per image (cached by content hash), then cosine DBSCAN.
    `engine` selects deepface | insightface. Returns (id->cluster_label, ids-with-face)."""
    import numpy as np
    cache = {}
    if os.path.exists(ENC_CACHE):
        cache = pickle.load(open(ENC_CACHE, 'rb'))

    encoder = None  # built lazily — only if there's an uncached image to encode

    def get_encoder():
        nonlocal encoder
        if encoder is None:
            if engine == 'deepface':
                encoder = _deepface_encoder(model, detector, min_score)
            elif engine == 'insightface':
                encoder = _insightface_encoder(model, det_size, min_score)
            else:
                raise SystemExit(f'unknown --engine {engine!r}')
        return encoder

    encodings, ids, no_face = [], [], set()
    for n, (pid, path) in enumerate(paths.items()):
        key = (engine, model, _content_key(path))       # engine+model in key => no stale reuse
        if key not in cache:
            try:
                cache[key] = get_encoder()(_load_bgr(path))
            except Exception:
                cache[key] = None
        enc = cache[key]
        if enc is None:
            no_face.add(pid)
        else:
            encodings.append(enc)
            ids.append(pid)
        if (n + 1) % 200 == 0:
            print(f'  encoded {n + 1}/{len(paths)} (no face so far: {len(no_face)})')
            pickle.dump(cache, open(ENC_CACHE, 'wb'))    # periodic checkpoint
    pickle.dump(cache, open(ENC_CACHE, 'wb'))

    labels = {}
    if encodings:
        from sklearn.cluster import DBSCAN
        X = np.array(encodings)
        # ArcFace embeddings compare by COSINE distance; eps=tolerance, min_samples=1
        # so every face lands in a cluster (a lone face = its own cluster, not noise).
        db = DBSCAN(eps=tolerance, min_samples=1, metric='cosine', n_jobs=-1).fit(X)
        for pid, lab in zip(ids, db.labels_):
            labels[pid] = int(lab)
        nclust = len(set(db.labels_))
        print(f'  faces[{engine}]: {len(ids)} encoded into {nclust} face-clusters; '
              f'{len(no_face)} had no detectable face')
    return labels, no_face


# ------------------------------------------------------------------ MERGE ----
def _best_name(names):
    names = [n for n in names if n and n.strip()]
    if not names:
        return ''
    # most frequent; tie-break on longest (more complete)
    freq = defaultdict(int)
    for n in names:
        freq[n.strip()] += 1
    return sorted(freq, key=lambda n: (freq[n], len(n)), reverse=True)[0]


def _median_age(ages):
    vals = sorted(a for a in ages if isinstance(a, int))
    return vals[len(vals) // 2] if vals else None


# estado priority: surface the most actionable status for the merged person
ESTADO_RANK = {'sin-contacto': 3, 'fallecido': 2, 'localizado': 1, 'con-contacto': 0}


def merge_cluster(members, by_id, phash, faceset):
    src = [by_id[m] for m in members]
    methods = set()
    if len(members) > 1:
        methods.add('face' if any(m in faceset for m in members) else 'phash')
    method = ('+'.join(sorted(methods)) if methods
              else ('no-face' if members[0] not in faceset else 'singleton'))
    estados = [s.get('estado') or 'con-contacto' for s in src]
    estado = max(estados, key=lambda e: ESTADO_RANK.get(e, 0))
    return {
        'match_method': method,
        'member_count': len(members),
        'nombre': _best_name([s.get('nombre') for s in src]),
        'nombres_vistos': sorted({(s.get('nombre') or '').strip() for s in src if (s.get('nombre') or '').strip()}),
        'edad': _median_age([s.get('edad') for s in src]),
        'ubicaciones': sorted({(s.get('ubicacion') or '').strip() for s in src if (s.get('ubicacion') or '').strip()}),
        'descripciones': sorted({(s.get('descripcion') or '').strip() for s in src if (s.get('descripcion') or '').strip()}),
        'contactos': sorted({(s.get('contacto') or '').strip() for s in src if (s.get('contacto') or '').strip()}),
        'estado': estado,
        'foto_representativa': f"{BASE}/api/familia/photo/{members[0]}",
        'primera_actualizacion_ms': min((s.get('updated_at') or 0) for s in src),
        'ultima_actualizacion_ms': max((s.get('updated_at') or 0) for s in src),
        'fuentes': [{
            'id': s['id'], 'nombre': s.get('nombre'), 'edad': s.get('edad'),
            'ubicacion': s.get('ubicacion'), 'contacto': s.get('contacto'),
            'estado': s.get('estado'), 'updated_at': s.get('updated_at'),
            'photo_url': f"{BASE}/api/familia/photo/{s['id']}",
            'image_phash': phash.get(s['id']), 'face_found': s['id'] in faceset,
        } for s in src],
    }


# ------------------------------------------------------------------- MAIN ----
def main():
    ap = argparse.ArgumentParser(description='Dedupe & merge personas by face + image.')
    ap.add_argument('--db', default=DEFAULT_DB, help=f'D1 database name (default {DEFAULT_DB})')
    ap.add_argument('--out', default=DEFAULT_OUT, help='output JSON file')
    ap.add_argument('--max', type=int, default=None, help='cap rows polled (testing)')
    ap.add_argument('--only-missing', action='store_true', help="estado='sin-contacto' only")
    ap.add_argument('--engine', default='deepface', choices=['deepface', 'insightface'],
                    help='face engine (default deepface)')
    ap.add_argument('--face-model', default=None,
                    help='model name; default ArcFace (deepface) / buffalo_l (insightface)')
    ap.add_argument('--detector', default='retinaface',
                    help='deepface detector_backend (retinaface, mtcnn, opencv, yolov8…)')
    ap.add_argument('--det-size', type=int, default=640, help='insightface detection size')
    ap.add_argument('--min-score', type=float, default=0.6,
                    help='drop face detections below this confidence (default 0.6)')
    ap.add_argument('--face-tolerance', type=float, default=0.5,
                    help='DBSCAN eps on COSINE face distance; lower=stricter (default 0.5)')
    ap.add_argument('--phash-threshold', type=int, default=0,
                    help='Hamming bits for near-dup images; 0=exact reposts only (default 0)')
    args = ap.parse_args()
    model = args.face_model or ('ArcFace' if args.engine == 'deepface' else 'buffalo_l')

    print('1/5 polling personas …')
    rows = poll(args.db, args.only_missing, cap=args.max)
    by_id = {r['id']: r for r in rows}
    print(f'  {len(rows)} candidate rows (with a photo)')

    print('2/5 downloading photos …')
    paths = download_photos(rows)
    if not paths:
        raise SystemExit('no photos downloaded — nothing to dedupe')

    print('3/5 stage A — perceptual hash …')
    phash, edges = phash_stage(paths, args.phash_threshold)

    print(f'4/5 stage B — face recognition ({args.engine}/{model}) …')
    labels, no_face = face_stage(paths, args.face_tolerance, args.engine, model,
                                 args.detector, args.det_size, args.min_score)
    faceset = set(labels)

    print('5/5 combining + merging …')
    uf = UF(list(paths.keys()))
    for a, b in edges:                       # link reposts (stage A)
        uf.union(a, b)
    by_label = defaultdict(list)             # link same-face (stage B)
    for pid, lab in labels.items():
        by_label[lab].append(pid)
    for ids in by_label.values():
        for j in range(1, len(ids)):
            uf.union(ids[0], ids[j])

    clusters = uf.groups()
    merged = [merge_cluster(m, by_id, phash, faceset) for m in clusters]
    merged.sort(key=lambda r: r['member_count'], reverse=True)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    json.dump(merged, open(args.out, 'w'), ensure_ascii=False, indent=1)

    dups = sum(1 for m in merged if m['member_count'] > 1)
    collapsed = len(paths) - len(merged)
    print(f'\nDONE  {len(paths)} reports -> {len(merged)} people '
          f'({dups} merged clusters, {collapsed} duplicates collapsed, '
          f'{len(no_face)} no-face singletons)')
    print(f'  -> {os.path.abspath(args.out)}')


if __name__ == '__main__':
    main()
