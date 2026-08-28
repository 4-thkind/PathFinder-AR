/** Bounding box in source-frame pixels. */
export interface Detection {
  x: number;
  y: number;
  w: number;
  h: number;
  score: number;
  cls: number;
}

/** Must match `names` in ml/data/data.yaml, in the same order. */
export const CLASS_NAMES = ["pothole"] as const;

/** Per-class contribution to severity; tune as classes are added. */
export const CLASS_WEIGHT: Record<string, number> = {
  pothole: 1.0,
  water_pothole: 1.0,
  speed_breaker: 0.7,
  waterlogging: 0.8,
  debris: 0.9,
};

export function className(cls: number): string {
  return CLASS_NAMES[cls] ?? `class_${cls}`;
}
