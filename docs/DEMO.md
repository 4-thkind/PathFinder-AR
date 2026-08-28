# Demo runbook

A 90-second video that shows the whole product. Shoot it in this order.

## Before you record

```bash
uvicorn server.main:app --host 0.0.0.0 --port 8000    # terminal 1
python server/seed_demo.py                            # once, populates the map
cd app && npm run dev                                 # terminal 2
```

Checklist:

- [ ] Phone and laptop on the **same wifi**; open the `https://192.168.x.x:5173`
      URL Vite prints and accept the certificate warning.
- [ ] Camera and location permissions **already granted** — a permission dialog
      on camera mid-video wastes 10 seconds.
- [ ] Home screen shows `Detector: ready · webgpu` (or `wasm`). If it says
      *model missing*, `python ml/train.py` has not finished.
- [ ] Calibrate in Settings: measure the lens height off the ground, and nudge
      the horizon slider until the green corridor lines sit on your lane.
- [ ] Phone on **Do Not Disturb**, brightness up, volume up — the warnings are
      audio and the mic needs to catch them.

If you cannot ride while filming, hold the phone at riding height and walk
towards a real pothole. The alert engine uses GPS speed, so at walking pace
warnings fire later; drop **Warn this far ahead** to ~6 s in Settings for the
shoot and say so honestly if asked.

## The 90 seconds

| Time | Shot | What to say |
|---|---|---|
| 0:00–0:10 | Phone clamped to the handlebar, road ahead | "Every rider here has hit a pothole they saw half a second too late." |
| 0:10–0:20 | Home screen: map with hazards, tap **Start Ride** | "This is a phone you already own. Nothing else." |
| 0:20–0:40 | **Screen recording** of the ride: boxes lock on, banner appears, voice says *"pothole ahead, 20 metres"* | "It detects the hazard, works out how far it is, decides whether it's in your lane — and only then speaks." |
| 0:40–0:50 | Pan past a kerb-side pothole that is boxed but **silent** | "That one it saw and deliberately ignored. It's not in your path. Silence is the feature." |
| 0:50–1:00 | Tap **Save clip**, then show it in the ride summary | "Rolling dashcam. Nothing is written to storage until you flag an incident." |
| 1:00–1:15 | Laptop: `/dashboard` filling up | "Every warning also becomes an anonymous data point. Coordinates and type — never video." |
| 1:15–1:30 | Dashboard repair-priority table | "Which is a live road-condition map a municipality can act on. Same data, second business." |

## Recording the screen

Android 11+ has a built-in screen recorder in the quick-settings tray — enable
**Record audio → Device audio** so the spoken warnings land in the video. Record
the ride segment on-screen and cut it against outside footage of the bike; a
handheld shot of a phone screen in daylight will not read on a projector.

## Two things that will be asked

**"Isn't this just YOLO?"** — Open [`app/src/hazards.ts`](../app/src/hazards.ts).
The detector is one of six stages. Persistence, path relevance, distance,
time-to-hazard, severity and suppression are what make it usable instead of a
device that beeps forty times a kilometre. `npm run check` runs the assertions.

**"What about privacy?"** — Frames are analysed in memory; there is no upload
path for video anywhere in the repo. The payload is
`{lat, lon, type, confidence, timestamp}`, with no account or device id, and it
can be switched off in Settings without affecting safety.

## Known rough edges — say them before you are asked

- One hazard class today (pothole). Speed breakers and waterlogging need
  annotated Indian data; the pipeline takes them without a code change.
- Distance assumes a flat road, so it is optimistic on slopes.
- Incident capture is manual; the accelerometer trigger is not wired yet.
