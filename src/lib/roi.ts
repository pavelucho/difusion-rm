export type RoiShape = 'circle' | 'ellipse' | 'polygon';

export interface Point {
  x: number;
  y: number;
}

export interface RoiState {
  id: string;
  label: string;
  color: string;
  shape: RoiShape;
  geometry: Point[];
  sliceIndex: number;
}

export function rasterizeRoi(roi: RoiState, width: number, height: number): Uint8Array {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return new Uint8Array(width * height);

  ctx.fillStyle = 'white';
  ctx.beginPath();

  if (roi.shape === 'circle' && roi.geometry.length === 2) {
    const center = roi.geometry[0];
    const edge = roi.geometry[1];
    const radius = Math.hypot(edge.x - center.x, edge.y - center.y);
    ctx.arc(center.x, center.y, radius, 0, 2 * Math.PI);
  } else if (roi.shape === 'ellipse' && roi.geometry.length >= 2) {
    const center = roi.geometry[0];
    const edge = roi.geometry[1];
    // Simple bounding-box based ellipse
    const rx = Math.abs(edge.x - center.x);
    const ry = Math.abs(edge.y - center.y);
    ctx.ellipse(center.x, center.y, rx, ry, 0, 0, 2 * Math.PI);
  } else if (roi.shape === 'polygon' && roi.geometry.length >= 3) {
    ctx.moveTo(roi.geometry[0].x, roi.geometry[0].y);
    for (let i = 1; i < roi.geometry.length; i++) {
      ctx.lineTo(roi.geometry[i].x, roi.geometry[i].y);
    }
    ctx.closePath();
  }

  ctx.fill();

  const imgData = ctx.getImageData(0, 0, width, height).data;
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = imgData[i * 4] > 128 ? 1 : 0;
  }
  return mask;
}
