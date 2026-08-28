import L from "leaflet";
import "leaflet/dist/leaflet.css";

import "./style.css";
import { AlertVoice } from "./alerts.ts";
import { Dashcam } from "./dashcam.ts";
import { Detector } from "./detector.ts";
import { AlertEngine, corridorHalfWidth, type Alert, type Track } from "./hazards.ts";
import { Compass, HazardNetwork, ReportQueue, RideLocation, distanceM } from "./geo.ts";
import { className, type Detection } from "./types.ts";
import { formatDistance, formatDuration, remainingM, route, search, type Place, type Route } from "./nav.ts";

const API_BASE = import.meta.env.VITE_API_BASE ?? "";
const SETTINGS_KEY = "pathfinder.settings";
/** Report to the network only when we are quite sure - false positives poison the map. */
const REPORT_CONFIDENCE = 0.55;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const detector = new Detector();
const engine = new AlertEngine();
const voice = new AlertVoice();
const dashcam = new Dashcam();
const rider = new RideLocation();
const queue = new ReportQueue(API_BASE);
const network = new HazardNetwork(API_BASE);
const compass = new Compass();

const video = $<HTMLVideoElement>("cam");
const overlay = $<HTMLCanvasElement>("overlay");
const paint = overlay.getContext("2d")!;

let stream: MediaStream | undefined;
let wakeLock: WakeLockSentinel | undefined;
let running = false;
let ride = { startedAt: 0, metres: 0, hazards: 0, alerts: 0 };
let lastFrameAt = 0;
let fps = 0;

// ---------------------------------------------------------------- settings
interface Settings {
  heightM: number;
  horizonFrac: number;
  vFovDeg: number;
  minScore: number;
  warnSeconds: number;
  bufferSeconds: number;
  speech: boolean;
  upload: boolean;
}

const settings: Settings = {
  heightM: 1,
  horizonFrac: 0.45,
  vFovDeg: 55,
  minScore: 0.4,
  warnSeconds: 3.5,
  bufferSeconds: 180,
  speech: true,
  upload: true,
  ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>),
};

function applySettings(): void {
  engine.cam.heightM = settings.heightM;
  engine.cam.horizonFrac = settings.horizonFrac;
  engine.cam.vFovDeg = settings.vFovDeg;
  engine.cfg.minScore = settings.minScore;
  engine.cfg.warnSeconds = settings.warnSeconds;
  dashcam.bufferSeconds = settings.bufferSeconds;
  voice.speech = settings.speech;
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

function bindSettings(): void {
  const bindRange = (inputId: string, outputId: string, key: keyof Settings, format: (v: number) => string) => {
    const input = $<HTMLInputElement>(inputId);
    const output = $<HTMLOutputElement>(outputId);
    input.value = String(settings[key]);
    output.textContent = format(Number(settings[key]));
    input.addEventListener("input", () => {
      (settings[key] as number) = Number(input.value);
      output.textContent = format(Number(input.value));
      applySettings();
    });
  };

  bindRange("in-height", "out-height", "heightM", (v) => v.toFixed(2) + " m");
  bindRange("in-horizon", "out-horizon", "horizonFrac", (v) => v.toFixed(2));
  bindRange("in-fov", "out-fov", "vFovDeg", (v) => v + "Â°");
  bindRange("in-score", "out-score", "minScore", (v) => v.toFixed(2));
  bindRange("in-warn", "out-warn", "warnSeconds", (v) => v.toFixed(1) + " s");
  bindRange("in-buffer", "out-buffer", "bufferSeconds", (v) => v + " s");

  for (const [id, key] of [["in-speech", "speech"], ["in-upload", "upload"]] as const) {
    const box = $<HTMLInputElement>(id);
    box.checked = settings[key];
    box.addEventListener("change", () => {
      settings[key] = box.checked;
      applySettings();
    });
  }
}

// ------------------------------------------------------------------ screens
type ScreenName = "home" | "ride" | "summary" | "settings";

function show(target: ScreenName): void {
  for (const name of ["home", "ride", "summary", "settings"] as ScreenName[]) {
    $("screen-" + name).classList.toggle("hidden", name !== target);
  }
}

// ---------------------------------------------------------------------- map
let map: L.Map | undefined;
let rideMap: L.Map | undefined;
let riderMarker: L.CircleMarker | undefined;
let rideMarker: L.Marker | undefined;
let routeLine: L.Polyline | undefined;
const hazardLayer = L.layerGroup();
const rideHazardLayer = L.layerGroup();

let destination: Place | undefined;
let activeRoute: Route | undefined;

const tiles = () =>
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 });

function initMap(): void {
  map = L.map("home-map", { zoomControl: false, attributionControl: false }).setView([20.59, 78.96], 5);
  tiles().addTo(map);
  hazardLayer.addTo(map);

  // the in-ride map: no controls, nothing to fiddle with while moving
  rideMap = L.map("ride-map", {
    zoomControl: false,
    attributionControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
    keyboard: false,
  }).setView([20.59, 78.96], 16);
  tiles().addTo(rideMap);
  rideHazardLayer.addTo(rideMap);
}

/**
 * Draw the crowdsourced hazards onto both maps.
 *
 * Consensus drives the styling: one lone report looks faint, many look solid.
 * The dark halo keeps them legible against the red route line.
 */
function drawHazardLayers(): void {
  for (const [layer, withPopup] of [[hazardLayer, true], [rideHazardLayer, false]] as const) {
    layer.clearLayers();
    for (const hazard of network.hazards) {
      const marker = L.circleMarker([hazard.lat, hazard.lon], {
        radius: 6 + 4 * hazard.score,
        color: "#12181f",
        weight: 2,
        fillColor: "#ffd400",
        fillOpacity: 0.45 + 0.5 * hazard.score,
      });
      if (withPopup) {
        marker.bindPopup(
          hazard.type.replace(/_/g, " ") +
            " · " + hazard.reports + " report(s) · " +
            Math.round(hazard.score * 100) + "% confidence",
        );
      }
      marker.addTo(layer);
    }
  }
  $("st-network").textContent = String(network.hazards.length);
}

/**
 * A cone pointing the way the phone is facing, like a maps app. Drawn as an
 * icon rather than a circle so it can be rotated with the compass.
 */
function riderIcon(): L.DivIcon {
  return L.divIcon({
    className: "",
    iconSize: [64, 64],
    iconAnchor: [32, 32],
    html:
      '<div class="rider-marker"><svg viewBox="0 0 64 64">' +
      '<g class="rider-cone">' +
      // solid black, white-edged so it reads on both pale and dark map tiles
      '<path d="M32 5 L47 33 A17 17 0 0 0 17 33 Z" fill="#0d0d0d" stroke="#fff" stroke-width="2.5"' +
      ' stroke-linejoin="round"/>' +
      "</g>" +
      '<circle cx="32" cy="32" r="11" fill="#0d0d0d" stroke="#fff" stroke-width="3.5"/>' +
      "</svg></div>",
  });
}

/** Point the cone along the compass, falling back to GPS course while moving. */
function updateRiderHeading(): void {
  const heading = compass.headingDeg ?? rider.headingDeg;
  const cone = document.querySelector<SVGGElement>(".rider-cone");
  if (cone && typeof heading === "number") cone.style.transform = `rotate(${heading}deg)`;
}

function drawRoute(): void {
  routeLine?.remove();
  routeLine = undefined;
  if (!activeRoute || !rideMap) return;
  routeLine = L.polyline(activeRoute.points, {
    color: "#ff7a00",
    weight: 7,
    opacity: 0.95,
    lineJoin: "round",
  }).addTo(rideMap);
}

function updateNavStrip(): void {
  $("nav-name").textContent = destination ? destination.name.split(",")[0] : "No destination set";
  if (!activeRoute || !rider.position) {
    $("nav-distance").textContent = destination ? "—" : "";
    $("nav-eta").textContent = destination ? "routing…" : "free ride";
    return;
  }
  const left = remainingM(activeRoute, rider.position.coords.latitude, rider.position.coords.longitude);
  $("nav-distance").textContent = formatDistance(left);
  // hold the original ETA rather than recomputing from a noisy instant speed
  $("nav-eta").textContent = formatDuration(activeRoute.durationS * (left / activeRoute.distanceM || 1));
}

/** Route to a place the rider picked from the candidate list. */
async function chooseDestination(place: Place): Promise<void> {
  destination = place;
  activeRoute = undefined;
  $("dest-results").classList.add("hidden");

  const status = $("dest-status");
  const here = rider.position;
  if (!here) {
    status.textContent = place.name + " — waiting for GPS before routing";
    updateNavStrip();
    return;
  }

  status.textContent = "Finding a route…";
  try {
    activeRoute = await route(
      { lat: here.coords.latitude, lon: here.coords.longitude },
      place,
    );
    status.textContent = activeRoute
      ? place.name + " · " + formatDistance(activeRoute.distanceM) + " · " + formatDuration(activeRoute.durationS)
      : "No road route found to " + place.name;
    drawRoute();
  } catch (err) {
    status.textContent = "Routing service unreachable: " + (err as Error).message;
  }
  updateNavStrip();
}

/**
 * Show every plausible match instead of guessing. Plenty of Indian place names
 * repeat across towns, and routing to the wrong one silently is worse than
 * asking.
 */
async function searchDestination(query: string): Promise<void> {
  const status = $("dest-status");
  const results = $("dest-results");
  results.innerHTML = "";

  if (!query.trim()) {
    destination = undefined;
    activeRoute = undefined;
    drawRoute();
    updateNavStrip();
    status.textContent = "";
    results.classList.add("hidden");
    return;
  }

  status.textContent = "Searching…";
  let places: Place[];
  try {
    const here = rider.position;
    places = await search(
      query,
      here ? { lat: here.coords.latitude, lon: here.coords.longitude } : undefined,
    );
  } catch (err) {
    status.textContent = "Place search unreachable: " + (err as Error).message;
    return;
  }

  if (!places.length) {
    status.textContent = "No match for that place.";
    results.classList.add("hidden");
    return;
  }

  if (places.length === 1) {
    await chooseDestination(places[0]);
    return;
  }

  status.textContent = places.length + " places match — pick the right one:";
  const here = rider.position;
  for (const place of places) {
    const away = here
      ? distanceM(here.coords.latitude, here.coords.longitude, place.lat, place.lon)
      : undefined;
    const item = document.createElement("li");
    item.tabIndex = 0;

    const name = document.createElement("b");
    name.textContent = place.name;
    const detail = document.createElement("span");
    detail.textContent = place.address;
    item.append(name, detail);

    if (away !== undefined) {
      const near = document.createElement("em");
      near.textContent = formatDistance(away) + " away";
      item.append(near);
    }

    const pick = () => void chooseDestination(place);
    item.addEventListener("click", pick);
    item.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") pick();
    });
    results.append(item);
  }
  results.classList.remove("hidden");
}

// ------------------------------------------------------------------ overlay
/**
 * The video is displayed with `object-fit: contain` (see style.css), so
 * detections in video pixels are scaled down to fit and centred in the pane.
 * Must stay in step with that CSS or the boxes drift off their hazards.
 */
function videoToScreen() {
  const scale = Math.min(overlay.width / video.videoWidth, overlay.height / video.videoHeight);
  return {
    scale,
    dx: (overlay.width - video.videoWidth * scale) / 2,
    dy: (overlay.height - video.videoHeight * scale) / 2,
  };
}

function render(tracks: Track[]): void {
  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.round(overlay.clientWidth * dpr);
  const targetH = Math.round(overlay.clientHeight * dpr);
  if (overlay.width !== targetW || overlay.height !== targetH) {
    overlay.width = targetW;
    overlay.height = targetH;
  }
  paint.clearRect(0, 0, overlay.width, overlay.height);
  if (!video.videoWidth) return;
  const { scale, dx, dy } = videoToScreen();

  // The corridor the alert engine treats as "the rider's path" - built in
  // video pixels first (so it lines up with isInPath's own maths), then mapped
  // through the same scale/offset as the detections, so it always sits inside
  // the visible frame regardless of object-fit or aspect ratio.
  const horizonYVid = engine.cam.horizonFrac * video.videoHeight;
  const bottomHalf = corridorHalfWidth(1) * video.videoWidth;
  const horizonHalf = corridorHalfWidth(0) * video.videoWidth;
  const midX = video.videoWidth / 2;

  const toScreen = (vx: number, vy: number): [number, number] => [vx * scale + dx, vy * scale + dy];
  const [lx1, ly1] = toScreen(midX - horizonHalf, horizonYVid);
  const [lx2, ly2] = toScreen(midX - bottomHalf, video.videoHeight);
  const [rx1, ry1] = toScreen(midX + horizonHalf, horizonYVid);
  const [rx2, ry2] = toScreen(midX + bottomHalf, video.videoHeight);

  paint.strokeStyle = "rgba(53, 208, 165, 0.4)";
  paint.lineWidth = 2 * dpr;
  paint.beginPath();
  paint.moveTo(lx1, ly1);
  paint.lineTo(lx2, ly2);
  paint.moveTo(rx1, ry1);
  paint.lineTo(rx2, ry2);
  paint.stroke();

  for (const track of tracks) {
    const x = track.box.x * scale + dx;
    const y = track.box.y * scale + dy;
    const w = track.box.w * scale;
    const h = track.box.h * scale;
    const hot = track.inPath && track.severity >= engine.cfg.alertSeverity;

    // A glow flattened into an ellipse reads as something lying ON the road,
    // where a plain rectangle reads as a floating label. Purely presentation -
    // the detector outputs boxes, this just draws them like a hazard.
    if (track.inPath) {
      const midX = x + w / 2;
      const midY = y + h / 2;
      const radius = Math.max(w, h) * 0.8;
      const glow = paint.createRadialGradient(midX, midY, 0, midX, midY, radius);
      glow.addColorStop(0, hot ? "rgba(255, 45, 45, 0.85)" : "rgba(255, 176, 32, 0.7)");
      glow.addColorStop(0.45, hot ? "rgba(255, 70, 70, 0.38)" : "rgba(255, 176, 32, 0.26)");
      glow.addColorStop(1, "rgba(255, 90, 40, 0)");
      paint.fillStyle = glow;
      paint.beginPath();
      paint.ellipse(midX, midY, radius, radius * 0.62, 0, 0, Math.PI * 2);
      paint.fill();
    }

    paint.strokeStyle = hot ? "#ff4d4d" : track.inPath ? "#ffb020" : "rgba(232, 238, 244, 0.5)";
    paint.lineWidth = (hot ? 3 : 2) * dpr;
    paint.beginPath();
    paint.roundRect(x, y, w, h, 8 * dpr);
    paint.stroke();

    if (!track.inPath) continue;
    const distance = Number.isFinite(track.distanceM) ? track.distanceM.toFixed(0) + " m" : "far";
    const label = className(track.cls).replace(/_/g, " ") + " Â· " + distance;
    paint.font = 13 * dpr + "px system-ui, sans-serif";
    const pad = 6 * dpr;
    const textW = paint.measureText(label).width;
    paint.fillStyle = hot ? "#ff4d4d" : "#ffb020";
    paint.fillRect(x, y - 20 * dpr, textW + pad * 2, 20 * dpr);
    paint.fillStyle = "#12060a";
    paint.fillText(label, x + pad, y - 6 * dpr);
  }
}

let bannerTimer: ReturnType<typeof setTimeout> | undefined;

function showBanner(title: string, sub: string, severe = false): void {
  $("alert-title").textContent = title;
  $("alert-sub").textContent = sub;
  $("alert-banner").classList.toggle("severe", severe);
  $("alert-banner").classList.remove("hidden");
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => $("alert-banner").classList.add("hidden"), 2600);
}

function handleAlert(alert: Alert): void {
  ride.alerts++;
  voice.announce(alert);
  showBanner(
    alert.label + " ahead",
    "DISTANCE: " + alert.distanceM.toFixed(0) + " m",
    alert.severity >= 0.6,
  );
}

function reportHazard(alert: Alert): void {
  const position = rider.position;
  if (!settings.upload || !position || alert.track.box.score < REPORT_CONFIDENCE) return;
  queue.add({
    lat: position.coords.latitude,
    lon: position.coords.longitude,
    type: className(alert.track.cls),
    confidence: alert.track.box.score,
    at: Date.now(),
  });
  $("st-queue").textContent = String(queue.pending);
}

// -------------------------------------------------------------------- ride
async function startRide(): Promise<void> {
  voice.unlock();
  void compass.start();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
  } catch (err) {
    alert(
      "Camera unavailable: " + (err as Error).message +
        "\n\nThe app needs an HTTPS origin and camera permission.",
    );
    return;
  }

  video.srcObject = stream;
  await video.play();

  engine.reset();
  network.reset();
  dashcam.start(stream);
  rider.start();
  ride = { startedAt: Date.now(), metres: 0, hazards: 0, alerts: 0 };
  running = true;
  show("ride");

  // leaflet measures its container on creation; this one was hidden until now
  rideMap?.invalidateSize();
  drawHazardLayers();
  drawRoute();
  updateNavStrip();

  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {
    /* not fatal - the rider can keep the screen on manually */
  }

  voice.say("Ride started. Watching the road.");
  void loop();
}

async function loop(): Promise<void> {
  const seen = new Set<number>();
  while (running) {
    if (video.readyState < 2) {
      await new Promise((resolve) => setTimeout(resolve, 60));
      continue;
    }

    let dets: Detection[] = [];
    try {
      dets = await detector.detect(video, video.videoWidth, video.videoHeight, engine.cfg.minScore);
    } catch (err) {
      console.error("[detect]", err);
      await new Promise((resolve) => setTimeout(resolve, 300));
      continue;
    }

    const now = performance.now();
    fps = lastFrameAt ? 0.8 * fps + 0.2 * (1000 / (now - lastFrameAt)) : 0;
    lastFrameAt = now;

    for (const alert of engine.update(dets, video.videoWidth, video.videoHeight, rider.speedMps, now)) {
      handleAlert(alert);
      reportHazard(alert);
    }

    const tracks = engine.active;
    for (const track of tracks) {
      if (!seen.has(track.id)) {
        seen.add(track.id);
        ride.hazards++;
      }
    }
    render(tracks);

    $("hud-fps").textContent = fps.toFixed(0);
    $("hud-speed").textContent = (rider.speedMps * 3.6).toFixed(0);
    $("hud-hazards").textContent = String(ride.hazards);
    $("hud-buffer").textContent = dashcam.bufferedSeconds.toFixed(0) + "s";

    // yield to the compositor so the camera preview stays smooth
    await new Promise(requestAnimationFrame);
  }
}

async function endRide(): Promise<void> {
  running = false;
  dashcam.stop();
  rider.stop();
  compass.stop();
  stream?.getTracks().forEach((track) => track.stop());
  stream = undefined;
  video.srcObject = null;
  try {
    await wakeLock?.release();
  } catch {
    /* already released */
  }
  wakeLock = undefined;

  const minutes = (Date.now() - ride.startedAt) / 60000;
  $("sum-duration").textContent = minutes.toFixed(0) + " min";
  $("sum-distance").textContent = (ride.metres / 1000).toFixed(2) + " km";
  $("sum-hazards").textContent = String(ride.hazards);
  $("sum-alerts").textContent = String(ride.alerts);
  renderClips();
  show("summary");

  await queue.flush();
  $("st-queue").textContent = String(queue.pending);
}

function renderClips(): void {
  const list = $("clip-list");
  list.innerHTML = "";
  if (!dashcam.clips.length) {
    const empty = document.createElement("p");
    empty.className = "fineprint";
    empty.textContent = "No incidents saved this ride.";
    list.append(empty);
    return;
  }
  for (const clip of dashcam.clips) {
    const url = URL.createObjectURL(clip.blob);
    const card = document.createElement("div");
    card.className = "clip";

    const player = document.createElement("video");
    player.src = url;
    player.controls = true;
    player.playsInline = true;

    const meta = document.createElement("div");
    meta.className = "fineprint";
    meta.textContent =
      new Date(clip.at).toLocaleString() + " Â· last " + clip.seconds + "s" +
      (clip.lat !== undefined ? " Â· " + clip.lat.toFixed(5) + ", " + clip.lon!.toFixed(5) : "");

    const link = document.createElement("a");
    link.href = url;
    link.download = "pathfinder-" + clip.id + ".webm";
    link.textContent = "Download clip";

    card.append(player, meta, link);
    list.append(card);
  }
}

// -------------------------------------------------------------------- boot
async function boot(): Promise<void> {
  applySettings();
  bindSettings();
  initMap();
  $("st-queue").textContent = String(queue.pending);

  let lastFix: GeolocationPosition | undefined;
  // where the hazard layer was last downloaded, so a long ride keeps pulling in
  // the road ahead instead of riding off the edge of the initial 3 km fetch
  let refreshedAt: { lat: number; lon: number } | undefined;

  async function refreshNetworkAround(lat: number, lon: number): Promise<void> {
    refreshedAt = { lat, lon };
    await network.refresh(lat, lon);
    drawHazardLayers();
    await queue.flush();
    $("st-queue").textContent = String(queue.pending);
  }

  rider.onUpdate = (position) => {
    const { latitude, longitude, accuracy } = position.coords;
    $("st-gps").textContent = "Â±" + accuracy.toFixed(0) + " m";

    const point: L.LatLngExpression = [latitude, longitude];
    if (map) {
      riderMarker ??= L.circleMarker(point, { radius: 7, color: "#ffffff", weight: 2, fillColor: "#0d0d0d", fillOpacity: 1 }).addTo(map);
      riderMarker.setLatLng(point);
    }
    if (rideMap) {
      rideMarker ??= L.marker(point, { icon: riderIcon(), interactive: false }).addTo(rideMap);
      rideMarker.setLatLng(point);
      updateRiderHeading();
      if (running) rideMap.setView(point, rideMap.getZoom(), { animate: false });
    }
    updateNavStrip();

    if (running) {
      if (lastFix) {
        const step = distanceM(lastFix.coords.latitude, lastFix.coords.longitude, latitude, longitude);
        if (step < 200) ride.metres += step; // ignore GPS jumps
      }
      // a mapped hazard round the corner, warned about before the camera can see it
      const upcoming = network.upcoming(latitude, longitude, rider.headingDeg);
      if (upcoming) {
        ride.alerts++;
        const label = "Reported " + upcoming.type.replace(/_/g, " ");
        voice.say(label + " ahead");
        showBanner(
          label + " ahead",
          "DISTANCE: " + distanceM(latitude, longitude, upcoming.lat, upcoming.lon).toFixed(0) + " m",
        );
      }
    }
    lastFix = position;

    // half the fetch radius: re-download before the rider can outrun the data
    if (!refreshedAt || distanceM(refreshedAt.lat, refreshedAt.lon, latitude, longitude) > 1500) {
      void refreshNetworkAround(latitude, longitude);
    }
  };
  rider.start();

  // first fix: centre the map and pull in what the network already knows
  navigator.geolocation?.getCurrentPosition((position) => {
    const { latitude, longitude } = position.coords;
    map?.setView([latitude, longitude], 15);
    void refreshNetworkAround(latitude, longitude);
  });

  const destinationInput = $<HTMLInputElement>("in-destination");
  $("btn-destination").addEventListener("click", () => void searchDestination(destinationInput.value));
  destinationInput.addEventListener("keydown", (event) => {
    if ((event as KeyboardEvent).key === "Enter") void searchDestination(destinationInput.value);
  });

  $("btn-start").addEventListener("click", startRide);
  $("btn-end").addEventListener("click", endRide);
  $("btn-home").addEventListener("click", () => show("home"));
  $("btn-settings").addEventListener("click", () => show("settings"));
  $("btn-settings-back").addEventListener("click", () => show("home"));
  $("btn-incident").addEventListener("click", () => {
    const clip = dashcam.saveIncident(rider.position);
    showBanner(clip ? "Incident saved" : "Nothing buffered yet", clip ? clip.seconds + "s of footage" : "");
    voice.say(clip ? "Footage saved" : "Nothing recorded yet");
  });
  $("btn-mute").addEventListener("click", () => {
    voice.enabled = !voice.enabled;
    $("btn-mute").textContent = voice.enabled ? "Mute" : "Unmute";
  });
  // a double tap anywhere on the camera view also flags an incident, for gloved hands
  overlay.addEventListener("dblclick", () => $("btn-incident").click());

  addEventListener("online", async () => {
    await queue.flush();
    $("st-queue").textContent = String(queue.pending);
  });

  try {
    await detector.load("/models/pathfinder.onnx");
    $("st-model").textContent = "ready Â· " + detector.backend + " Â· " + detector.size + "px";
    $<HTMLButtonElement>("btn-start").disabled = false;
  } catch (err) {
    console.error(err);
    $("st-model").textContent = "load failed";
    // phones have no hover tooltip and usually no attached devtools, so the
    // only way to see this error is printing it directly on the page
    const banner = document.createElement("p");
    banner.className = "fineprint";
    banner.style.color = "#ff4d4d";
    banner.style.whiteSpace = "pre-wrap";
    banner.style.wordBreak = "break-word";
    banner.textContent = "Model load error: " + (err instanceof Error ? err.message : String(err));
    $("st-model").closest(".status-grid")?.after(banner);
  }

  if ("serviceWorker" in navigator && import.meta.env.PROD) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

void boot();
