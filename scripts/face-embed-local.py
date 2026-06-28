#!/usr/bin/env -S uv run --python 3.12 --script
# /// script
# requires-python = ">=3.12,<3.13"
# dependencies = ["insightface>=0.7.3", "onnxruntime>=1.17", "opencv-python-headless>=4.9", "numpy>=1.26"]
# ///
"""
SISMO911 — local face-embedding backfill for the desaparecidos (personas) registry.

The string/byte dedupe modes miss the most common real duplicate: the SAME person
submitted several times with a different name spelling, typo'd age, re-cropped or
redaction-barred photo, and free-text location. The only invariant is the FACE.

This computes a 512-d ArcFace embedding (InsightFace buffalo_l) of the primary
face per photo and writes it to D1 (personas.photo_face_vec) as base64 of 512
little-endian float32s (L2-normalised). scripts/face-cluster.mjs then groups by
cosine similarity into the dup_cluster review queue.

Workers can't decode JPEG or run ONNX, so this runs locally — mirroring
scripts/dhash-photos-local.mjs. Resumable/idempotent (WHERE photo_face_vec IS
NULL). Photo bytes come from the R2 mirror (foto_r2, the common case for family
submissions) or the source URL. A faceless photo gets a unique 'noface:<id>'
sentinel and an undecodable one 'dead:<id>' so neither re-selects nor forms a
false face cluster (a shared sentinel would collapse every failure into one group).

Usage:
  unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID
  uv run scripts/face-embed-local.py [maxRows]      # default: drain the queue
  IDS=p9d9..,pf94.. uv run scripts/face-embed-local.py   # only these ids (testing)

First run downloads the buffalo_l model (~280MB) to ~/.insightface.
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import urllib.request

import cv2
import numpy as np

DB = "sismo911"
PHOTO_BASE = os.environ.get("PHOTO_BASE", "https://sismo911.com/api/familia/photo/")
BATCH = 200
MAX = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 10**9
ONLY_IDS = [s for s in os.environ.get("IDS", "").split(",") if s.strip()]
# Parallel sharding: launch N copies with SHARDS=N SHARD=0..N-1. Each drains a
# DISJOINT slice via (rowid % N) so workers never select the same row (no wasted
# work, no races — D1 writes are idempotent anyway). CPU-bound (~1.5s/photo), so
# N≈cores-few gives ~Nx throughput. SHARDS=1 (default) = single-process, full table.
SHARDS = max(1, int(os.environ.get("SHARDS", "1")))
SHARD = int(os.environ.get("SHARD", "0")) % SHARDS
SHARD_SQL = f" AND (rowid % {SHARDS}) = {SHARD} " if SHARDS > 1 else " "

ENV = {**os.environ}
ENV.pop("CLOUDFLARE_API_TOKEN", None)   # force gmail OAuth wrangler session
ENV.pop("CLOUDFLARE_ACCOUNT_ID", None)


def d1_json(sql: str):
    out = subprocess.run(
        ["npx", "wrangler", "d1", "execute", DB, "--remote", "--json", "--command", sql],
        capture_output=True, text=True, env=ENV, check=True,
    ).stdout
    data = json.loads(out)
    return (data[0] if isinstance(data, list) else data).get("results", [])


def d1_file(sql_text: str):
    with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f:
        f.write(sql_text)
        path = f.name
    try:
        subprocess.run(
            ["npx", "wrangler", "d1", "execute", DB, "--remote", "--file", path],
            capture_output=True, text=True, env=ENV, check=True,
        )
    finally:
        os.unlink(path)


def url_bytes(url: str):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 SISMO911-face/1.0"})
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.read() or None
    except Exception:
        return None


def photo_bytes(pid: str, foto):
    # Prefer the DEPLOYED photo endpoint, which serves the R2 mirror (foto_r2) and
    # falls back to the source URL server-side — one HTTP GET, no per-photo
    # `wrangler r2 object get` node cold-start. ~10-50x faster across a 55k backfill.
    b = url_bytes(PHOTO_BASE + str(pid))
    if b is None and foto and str(foto).strip():
        b = url_bytes(str(foto).strip())   # last-resort direct fetch
    return b


def q(s: str) -> str:
    return "'" + str(s).replace("'", "''") + "'"


def decode(b: bytes):
    arr = np.frombuffer(b, dtype=np.uint8)
    return cv2.imdecode(arr, cv2.IMREAD_COLOR)   # BGR, what InsightFace expects


def pick_primary(faces):
    # Largest, most-confident face: bbox area × detector score.
    def rank(f):
        x1, y1, x2, y2 = f.bbox
        return float(f.det_score) * max(1.0, (x2 - x1) * (y2 - y1))
    return max(faces, key=rank)


def main():
    print("Loading InsightFace buffalo_l (CPU)…", flush=True)
    from insightface.app import FaceAnalysis
    app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
    app.prepare(ctx_id=-1, det_size=(640, 640))

    done = 0
    while done < MAX:
        if ONLY_IDS:
            ph = ",".join(q(i) for i in ONLY_IDS)
            rows = d1_json(
                f"SELECT id, foto, foto_r2 FROM personas WHERE id IN ({ph}) "
                f"AND photo_face_vec IS NULL")
        else:
            rows = d1_json(
                "SELECT id, foto, foto_r2 FROM personas "
                "WHERE photo_face_vec IS NULL "
                "AND (trim(coalesce(foto,'')) <> '' OR trim(coalesce(foto_r2,'')) <> '') "
                f"{SHARD_SQL}"
                f"ORDER BY (CASE WHEN trim(coalesce(foto_r2,'')) <> '' THEN 0 ELSE 1 END), "
                f"updated_at DESC LIMIT {min(BATCH, MAX - done)}")
        if not rows:
            break

        updates, hashed, noface, dead = [], 0, 0, 0
        for r in rows:
            pid, foto = r["id"], r.get("foto")
            b = photo_bytes(pid, foto)
            if b is None:
                updates.append((pid, f"dead:{pid}", 0, None)); dead += 1; continue
            img = decode(b)
            if img is None:
                updates.append((pid, f"dead:{pid}", 0, None)); dead += 1; continue
            faces = app.get(img)
            if not faces:
                updates.append((pid, f"noface:{pid}", 0, None)); noface += 1; continue
            face = pick_primary(faces)
            vec = np.asarray(face.normed_embedding, dtype="<f4")   # 512 × float32 LE, L2-normed
            b64 = base64.b64encode(vec.tobytes()).decode("ascii")
            updates.append((pid, b64, len(faces), round(float(face.det_score), 4)))
            hashed += 1

        # One batched file: N UPDATEs, a few D1 subrequests instead of N round-trips.
        stmts = []
        for pid, vec, fc, score in updates:
            sc = "NULL" if score is None else str(score)
            stmts.append(
                f"UPDATE personas SET photo_face_vec={q(vec)}, face_count={fc}, "
                f"face_det_score={sc} WHERE id={q(pid)};")
        for i in range(0, len(stmts), 200):
            d1_file("\n".join(stmts[i:i + 200]))

        done += len(rows)
        tag = f"[shard {SHARD}/{SHARDS}] " if SHARDS > 1 else ""
        print(f"  {tag}batch: embedded {hashed}, no-face {noface}, dead {dead} "
              f"(total processed {done})", flush=True)
        if ONLY_IDS:
            break

    remaining = d1_json(
        "SELECT COUNT(*) AS n FROM personas WHERE photo_face_vec IS NULL "
        "AND (trim(coalesce(foto,'')) <> '' OR trim(coalesce(foto_r2,'')) <> '')"
        + SHARD_SQL)
    print(f"Done. Processed {done} this run. Remaining unembedded: {remaining[0]['n']}", flush=True)


if __name__ == "__main__":
    main()
