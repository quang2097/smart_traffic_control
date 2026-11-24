export type Crop = { x: number; y: number; width: number; height: number };
export function cropFromPoints(a: { x: number; y: number }, b: { x: number; y: number }): Crop {
  const clamp = (n: number) => Math.max(0, Math.min(1, n));
  const left = clamp(Math.min(a.x, b.x)), top = clamp(Math.min(a.y, b.y));
  return { x: left, y: top, width: clamp(Math.max(a.x, b.x)) - left, height: clamp(Math.max(a.y, b.y)) - top };
}
export function pixelCrop(crop: Crop, width: number, height: number): Crop {
  const x = Math.min(width - 1, Math.max(0, Math.round(crop.x * width)));
  const y = Math.min(height - 1, Math.max(0, Math.round(crop.y * height)));
  return { x, y, width: Math.max(1, Math.min(width - x, Math.round(crop.width * width))), height: Math.max(1, Math.min(height - y, Math.round(crop.height * height))) };
}
export function validResolution(width: number, height: number) {
  return Number.isInteger(width) && Number.isInteger(height) && width >= 32 && height >= 32 && width <= 2048 && height <= 2048;
}
