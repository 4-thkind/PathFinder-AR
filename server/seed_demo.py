"""Populate the hazard map with plausible demo data.

A crowdsourced network is unimpressive when it is empty. This scatters hazards
along a few real Indian arterial roads, with a realistic mix of well-corroborated
and single-sighting reports, so the dashboard and the rider map have something
to show before a single real ride has happened.

    python server/seed_demo.py [--api http://localhost:8000]
"""
from __future__ import annotations

import argparse
import random
import time
import urllib.error
import urllib.request
import json

#: (name, lat, lon, bearing) - stretches of road to scatter hazards along.
ROUTES = [
    ("Outer Ring Road, Bengaluru", 12.9352, 77.6245, 35),
    ("Sarjapur Road, Bengaluru", 12.9010, 77.6874, 110),
    ("Western Express Highway, Mumbai", 19.1136, 72.8697, 5),
    ("Ring Road, Delhi", 28.5672, 77.2100, 300),
    ("OMR, Chennai", 12.8996, 80.2209, 20),
]

TYPES = ["pothole"] * 7 + ["water_pothole", "speed_breaker", "waterlogging"]


def offset(lat: float, lon: float, bearing_deg: int, metres: float) -> tuple[float, float]:
    import math

    b = math.radians(bearing_deg)
    return (
        lat + (metres * math.cos(b)) / 111_320,
        lon + (metres * math.sin(b)) / (111_320 * math.cos(math.radians(lat))),
    )


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--api", default="http://localhost:8000")
    ap.add_argument("--per-route", type=int, default=14)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    now = int(time.time() * 1000)
    reports = []

    for _, lat, lon, bearing in ROUTES:
        for _ in range(args.per_route):
            spot_lat, spot_lon = offset(lat, lon, bearing, rng.uniform(0, 4000))
            # jitter sideways so hazards do not sit in a perfect line
            spot_lat, spot_lon = offset(spot_lat, spot_lon, bearing + 90, rng.uniform(-6, 6))
            kind = rng.choice(TYPES)
            # most hazards were seen by one or two riders; a few are notorious
            sightings = rng.choices([1, 2, 3, 6, 11], weights=[42, 25, 18, 10, 5])[0]
            for _ in range(sightings):
                # each rider's GPS lands a few metres off the true position
                r_lat, r_lon = offset(spot_lat, spot_lon, rng.uniform(0, 360), rng.uniform(0, 9))
                reports.append({
                    "lat": round(r_lat, 6),
                    "lon": round(r_lon, 6),
                    "type": kind,
                    "confidence": round(rng.uniform(0.55, 0.95), 3),
                    "at": now - rng.randint(0, 30) * 86_400_000,
                })

    rng.shuffle(reports)
    sent = 0
    for start in range(0, len(reports), 100):
        body = json.dumps({"reports": reports[start:start + 100]}).encode()
        request = urllib.request.Request(
            f"{args.api}/api/hazards", data=body, headers={"content-type": "application/json"}
        )
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                sent += json.load(response)["accepted"]
        except urllib.error.URLError as exc:
            raise SystemExit(f"could not reach {args.api} - is uvicorn running? ({exc})")

    stats = json.load(urllib.request.urlopen(f"{args.api}/api/stats", timeout=15))
    print(f"sent {sent} reports")
    print(f"map now holds {stats['hazards']} hazards ({stats['confirmed']} confirmed)")
    print(f"dashboard: {args.api}/dashboard")


if __name__ == "__main__":
    main()
