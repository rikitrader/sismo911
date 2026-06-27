#!/usr/bin/env python3
"""
External PyTorch satellite-damage inference for SISMO911.

Cloudflare Workers cannot run Python/PyTorch in-process. Run this script on a
local CPU/GPU box, CI runner, or notebook, then optionally POST the result back
to /api/sat/pytorch-results.

Example:
  python3 scripts/satellite_damage_pytorch.py chip.jpg --lat 10.6 --lon -68.7
  python3 scripts/satellite_damage_pytorch.py chip.jpg --model model.pt --post-url https://sismo911.com/api/sat/pytorch-results --token "$SATELLITE_INGEST_TOKEN"

The default path uses a deterministic image heuristic when no model is supplied.
If --model is provided, the model should accept a tensor shaped [1,3,H,W] and
return either class logits or a dict with a "logits" tensor.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any

from PIL import Image, ImageStat

LABELS = ["ninguno", "leve", "moderado", "grave", "severo"]


def load_tensor(path: Path, size: int):
    import torch
    import numpy as np

    image = Image.open(path).convert("RGB").resize((size, size))
    arr = np.asarray(image).astype("float32") / 255.0
    arr = (arr - np.array([0.485, 0.456, 0.406], dtype="float32")) / np.array([0.229, 0.224, 0.225], dtype="float32")
    tensor = torch.from_numpy(arr).permute(2, 0, 1).unsqueeze(0)
    return image, tensor


def heuristic(image: Image.Image) -> dict[str, Any]:
    gray = image.convert("L")
    stat = ImageStat.Stat(gray)
    mean = float(stat.mean[0])
    stddev = float(stat.stddev[0])
    dark = sum(1 for p in gray.getdata() if p < 55) / (gray.width * gray.height)
    bright = sum(1 for p in gray.getdata() if p > 210) / (gray.width * gray.height)
    texture = stddev / 128.0
    score = min(1.0, max(0.0, texture * 0.65 + dark * 0.25 + bright * 0.10))
    idx = min(4, max(0, round(score * 4)))
    hazards = []
    if texture > 0.38:
        hazards.append("textura irregular compatible con escombros")
    if dark > 0.18:
        hazards.append("zonas oscuras extensas")
    if bright > 0.16:
        hazards.append("superficies claras o expuestas")
    if not hazards:
        hazards.append("sin señal visual fuerte")
    return {
        "severity": LABELS[idx],
        "confidence": round(score, 3),
        "hazards": hazards,
        "summary": f"Heurística visual: brillo medio {mean:.1f}, contraste {stddev:.1f}, índice de daño {score:.2f}. Requiere verificación humana.",
        "model": "pytorch_external_heuristic_v1",
    }


def model_infer(model_path: Path, tensor, device: str) -> dict[str, Any]:
    import torch

    dev = torch.device(device if device != "auto" else ("cuda" if torch.cuda.is_available() else "cpu"))
    model = torch.load(model_path, map_location=dev)
    model.eval()
    tensor = tensor.to(dev)
    with torch.inference_mode():
        out = model(tensor)
    logits = out.get("logits") if isinstance(out, dict) else out
    probs = torch.softmax(logits, dim=1)[0].detach().cpu()
    idx = int(torch.argmax(probs).item())
    severity = LABELS[min(idx, len(LABELS) - 1)]
    confidence = float(probs[idx].item())
    return {
        "severity": severity,
        "confidence": round(confidence, 4),
        "hazards": [f"clasificador:{severity}"],
        "summary": f"Modelo PyTorch clasificó el chip satelital como {severity} con confianza {confidence:.2f}. Requiere verificación humana.",
        "model": f"pytorch:{model_path.name}",
    }


def post_result(url: str, token: str, payload: dict[str, Any]) -> dict[str, Any]:
    import urllib.request

    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "content-type": "application/json",
        "authorization": f"Bearer {token}",
    })
    with urllib.request.urlopen(req, timeout=30) as res:
        return json.loads(res.read().decode("utf-8"))


def main() -> int:
    ap = argparse.ArgumentParser(description="Run PyTorch satellite damage inference and optionally post to SISMO911.")
    ap.add_argument("image", type=Path)
    ap.add_argument("--model", type=Path)
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--lat", type=float, required=True)
    ap.add_argument("--lon", type=float, required=True)
    ap.add_argument("--zoom", type=int, default=18)
    ap.add_argument("--imagery-source", default="external")
    ap.add_argument("--imagery-date")
    ap.add_argument("--event-id", default="us6000t7zp")
    ap.add_argument("--post-url")
    ap.add_argument("--token")
    args = ap.parse_args()

    image, tensor = load_tensor(args.image, args.size)
    result = model_infer(args.model, tensor, args.device) if args.model else heuristic(image)
    payload = {
        **result,
        "lat": args.lat,
        "lon": args.lon,
        "zoom": args.zoom,
        "imagery_source": args.imagery_source,
        "imagery_date": args.imagery_date,
        "event_id": args.event_id,
        "created_ms": int(time.time() * 1000),
    }
    if args.post_url:
        if not args.token:
            raise SystemExit("--token is required with --post-url")
        payload["ingest"] = post_result(args.post_url, args.token, payload)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
