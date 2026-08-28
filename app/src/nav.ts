/**
 * Destination search and routing.
 *
 * Uses the free, key-less OpenStreetMap services: Nominatim to turn a typed
 * place into coordinates, OSRM to turn two coordinates into a road route. Both
 * are public demo endpoints - fine for a prototype and a demo, rate-limited and
 * not to be relied on for production traffic.
 */
import { distanceM } from "./geo.ts";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OSRM = "https://router.project-osrm.org/route/v1/driving";

export interface Place {
  /** Short label, e.g. "Kamal Public School". */
  name: string;
  /** Full address, so two places with the same name can be told apart. */
  address: string;
  lat: number;
  lon: number;
}

export interface Route {
  /** Road geometry as [lat, lon] pairs, ready for leaflet. */
  points: [number, number][];
  distanceM: number;
  durationS: number;
}

/**
 * Candidate matches for a typed place name, nearest first.
 *
 * Returns a list rather than a single best guess: "Kamal Public School" or
 * "MG Road" match dozens of places in India, and silently picking one routes the
 * rider to the wrong town. The caller shows these and lets the rider choose.
 */
export async function search(
  query: string,
  near?: { lat: number; lon: number },
  limit = 6,
): Promise<Place[]> {
  const params = new URLSearchParams({
    q: query,
    format: "jsonv2",
    limit: String(limit),
    addressdetails: "1",
    countrycodes: "in",
  });
  if (near) {
    // a 1-degree box around the rider, so nearby matches rank first
    params.set("viewbox", `${near.lon - 1},${near.lat + 1},${near.lon + 1},${near.lat - 1}`);
  }

  const res = await fetch(`${NOMINATIM}?${params}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`place search failed (${res.status})`);

  const places: Place[] = (await res.json()).map((hit: { display_name: string; lat: string; lon: string }) => {
    const [head, ...rest] = hit.display_name.split(",");
    return {
      name: head.trim(),
      address: rest.join(",").trim() || head.trim(),
      lat: Number(hit.lat),
      lon: Number(hit.lon),
    };
  });

  if (!near) return places;
  return places.sort(
    (a, b) => distanceM(near.lat, near.lon, a.lat, a.lon) - distanceM(near.lat, near.lon, b.lat, b.lon),
  );
}

export async function route(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
): Promise<Route | undefined> {
  const url = `${OSRM}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=full&geometries=geojson`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`routing failed (${res.status})`);
  const data = await res.json();
  const leg = data.routes?.[0];
  if (!leg) return undefined;
  return {
    points: leg.geometry.coordinates.map(([lon, lat]: [number, number]) => [lat, lon]),
    distanceM: leg.distance,
    durationS: leg.duration,
  };
}

/** Straight-line metres from the rider to the end of the route. */
export function remainingM(route: Route, lat: number, lon: number): number {
  const [endLat, endLon] = route.points[route.points.length - 1];
  return distanceM(lat, lon, endLat, endLon);
}

export function formatDistance(metres: number): string {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}

export function formatDuration(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)} h ${minutes % 60} min` : `${minutes} min`;
}
