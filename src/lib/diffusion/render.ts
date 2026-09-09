export function renderToCanvas(
  pixels: Float32Array,
  width: number,
  height: number,
  windowCenter: number,
  windowWidth: number,
  canvas: HTMLCanvasElement,
  colormap: 'gray' | 'hot' = 'gray'
) {
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  
  const imgData = ctx.createImageData(width, height);
  const data = imgData.data;
  
  const vMin = windowCenter - windowWidth / 2;
  
  for (let i = 0; i < pixels.length; i++) {
    let v = pixels[i];
    let intensity = (v - vMin) / windowWidth;
    if (intensity < 0) intensity = 0;
    if (intensity > 1) intensity = 1;
    
    let r, g, b;
    if (colormap === 'hot') {
      r = Math.min(255, intensity * 255 * 2.5);
      g = Math.min(255, Math.max(0, (intensity - 0.4) * 255 * 2.5));
      b = Math.min(255, Math.max(0, (intensity - 0.8) * 255 * 5));
    } else {
      const c = intensity * 255;
      r = c; g = c; b = c;
    }
    
    const idx = i * 4;
    data[idx] = r;
    data[idx+1] = g;
    data[idx+2] = b;
    data[idx+3] = 255;
  }
  
  ctx.putImageData(imgData, 0, 0);
}

export function autoWindowLevel(pixels: Float32Array, mask?: Uint8Array): { windowCenter: number, windowWidth: number } {
  let min = Infinity, max = -Infinity;
  let values: number[] = [];
  
  for (let i = 0; i < pixels.length; i++) {
    if (!mask || mask[i]) {
      const v = pixels[i];
      if (v < min) min = v;
      if (v > max) max = v;
      values.push(v);
    }
  }
  
  if (values.length === 0) return { windowCenter: 0, windowWidth: 1 };
  
  values.sort((a, b) => a - b);
  const p1 = values[Math.floor(values.length * 0.01)];
  const p99 = values[Math.floor(values.length * 0.99)];
  
  const windowWidth = p99 - p1;
  const windowCenter = (p99 + p1) / 2;
  return { windowCenter, windowWidth: windowWidth > 0 ? windowWidth : 1 };
}
