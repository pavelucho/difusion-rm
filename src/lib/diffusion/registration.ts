import type { AveragedSlice } from './types';

// Simple Bilinear Interpolator
function interpolate(
  pixels: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number
): number {
  if (x < 0 || x >= width - 1 || y < 0 || y >= height - 1) return 0;
  
  const x0 = Math.floor(x);
  const x1 = x0 + 1;
  const y0 = Math.floor(y);
  const y1 = y0 + 1;
  
  const fx = x - x0;
  const fy = y - y0;
  
  const p00 = pixels[y0 * width + x0];
  const p10 = pixels[y0 * width + x1];
  const p01 = pixels[y1 * width + x0];
  const p11 = pixels[y1 * width + x1];
  
  return p00 * (1 - fx) * (1 - fy) +
         p10 * fx * (1 - fy) +
         p01 * (1 - fx) * fy +
         p11 * fx * fy;
}

// Compute Mutual Information
function computeMI(
  refPixels: Float32Array,
  movPixels: Float32Array,
  width: number,
  height: number,
  dx: number,
  dy: number,
  angle: number // in radians
): number {
  const bins = 32;
  const jointHist = new Int32Array(bins * bins);
  const refHist = new Int32Array(bins);
  const movHist = new Int32Array(bins);
  
  const cx = width / 2;
  const cy = height / 2;
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  
  // Find min/max for binning (assume simple scaling)
  let refMin = Infinity, refMax = -Infinity;
  let movMin = Infinity, movMax = -Infinity;
  
  for (let i = 0; i < refPixels.length; i+=4) { // Subsample for speed
    if (refPixels[i] < refMin) refMin = refPixels[i];
    if (refPixels[i] > refMax) refMax = refPixels[i];
  }
  for (let i = 0; i < movPixels.length; i+=4) {
    if (movPixels[i] < movMin) movMin = movPixels[i];
    if (movPixels[i] > movMax) movMax = movPixels[i];
  }
  
  const refRange = refMax - refMin === 0 ? 1 : refMax - refMin;
  const movRange = movMax - movMin === 0 ? 1 : movMax - movMin;
  
  let count = 0;
  
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const mx0 = x - cx;
      const my0 = y - cy;
      const mx1 = mx0 * cosA - my0 * sinA;
      const my1 = mx0 * sinA + my0 * cosA;
      const mx = mx1 + cx - dx; // inverse transform
      const my = my1 + cy - dy;
      
      const vMov = interpolate(movPixels, width, height, mx, my);
      if (vMov > 0) {
        const vRef = refPixels[y * width + x];
        let binRef = Math.floor(((vRef - refMin) / refRange) * (bins - 1));
        let binMov = Math.floor(((vMov - movMin) / movRange) * (bins - 1));
        
        if (binRef < 0) binRef = 0; if (binRef >= bins) binRef = bins - 1;
        if (binMov < 0) binMov = 0; if (binMov >= bins) binMov = bins - 1;
        
        jointHist[binRef * bins + binMov]++;
        refHist[binRef]++;
        movHist[binMov]++;
        count++;
      }
    }
  }
  
  if (count === 0) return 0;
  
  let mi = 0;
  for (let r = 0; r < bins; r++) {
    for (let m = 0; m < bins; m++) {
      const pxy = jointHist[r * bins + m] / count;
      if (pxy > 0) {
        const px = refHist[r] / count;
        const py = movHist[m] / count;
        mi += pxy * Math.log(pxy / (px * py));
      }
    }
  }
  
  return mi;
}

export type RegistrationMode = 'none' | 'translation' | 'rigid';

export interface RegistrationResult {
  registeredSlice: AveragedSlice;
  dx: number;
  dy: number;
  angle: number;
  fallbackMode?: 'translation' | 'none';
}

export function registerSlice(
  refSlice: AveragedSlice,
  movSlice: AveragedSlice,
  mode: RegistrationMode = 'translation'
): RegistrationResult {
  const width = refSlice.metadata.columns;
  const height = refSlice.metadata.rows;
  
  if (mode === 'none') {
    return {
      registeredSlice: movSlice,
      dx: 0, dy: 0, angle: 0
    };
  }
  
  let bestMI = computeMI(refSlice.pixelData, movSlice.pixelData, width, height, 0, 0, 0);
  
  const searchGrid = [
    { transStep: 2, rotStep: 1 * Math.PI / 180, range: 2 },
    { transStep: 0.5, rotStep: 0.5 * Math.PI / 180, range: 1 }
  ];
  
  let currentDx = 0;
  let currentDy = 0;
  let currentAngle = 0;
  
  for (const step of searchGrid) {
    let improved = true;
    while (improved) {
      improved = false;
      let localBestMI = bestMI;
      let localBestDx = currentDx;
      let localBestDy = currentDy;
      let localBestAngle = currentAngle;
      
      for (let dx = -step.range; dx <= step.range; dx++) {
        for (let dy = -step.range; dy <= step.range; dy++) {
          for (let da = -step.range; da <= step.range; da++) {
            if (dx === 0 && dy === 0 && da === 0) continue;
            
            const testDx = currentDx + dx * step.transStep;
            const testDy = currentDy + dy * step.transStep;
            const testAngle = mode === 'rigid' ? currentAngle + da * step.rotStep : 0;
            
            // Limit bounds
            if (Math.abs(testDx) > 8 || Math.abs(testDy) > 8) continue;
            if (Math.abs(testAngle) > 3 * Math.PI / 180) continue;
            
            const mi = computeMI(refSlice.pixelData, movSlice.pixelData, width, height, testDx, testDy, testAngle);
            if (mi > localBestMI) {
              localBestMI = mi;
              localBestDx = testDx;
              localBestDy = testDy;
              localBestAngle = testAngle;
              improved = true;
            }
          }
        }
      }
      
      if (improved) {
        bestMI = localBestMI;
        currentDx = localBestDx;
        currentDy = localBestDy;
        currentAngle = localBestAngle;
      }
    }
  }
  
  let fallbackMode: 'translation' | 'none' | undefined;
  
  // Rejection checks
  if (mode === 'rigid' && Math.abs(currentAngle) > 3 * Math.PI / 180) {
    fallbackMode = 'translation';
    currentAngle = 0;
  }
  
  if (Math.abs(currentDx) > 8 || Math.abs(currentDy) > 8) {
    fallbackMode = 'none';
    currentDx = 0;
    currentDy = 0;
    currentAngle = 0;
  }
  
  if (currentDx === 0 && currentDy === 0 && currentAngle === 0) {
    return {
      registeredSlice: movSlice,
      dx: 0, dy: 0, angle: 0, fallbackMode
    };
  }
  
  // Apply best transform
  const newPixels = new Float32Array(movSlice.pixelData.length);
  const cx = width / 2;
  const cy = height / 2;
  const cosA = Math.cos(currentAngle);
  const sinA = Math.sin(currentAngle);
  
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const mx0 = x - cx;
      const my0 = y - cy;
      const mx1 = mx0 * cosA - my0 * sinA;
      const my1 = mx0 * sinA + my0 * cosA;
      const mx = mx1 + cx - currentDx;
      const my = my1 + cy - currentDy;
      
      newPixels[y * width + x] = interpolate(movSlice.pixelData, width, height, mx, my);
    }
  }
  
  return {
    registeredSlice: {
      metadata: movSlice.metadata,
      pixelData: newPixels,
      count: movSlice.count
    },
    dx: currentDx,
    dy: currentDy,
    angle: currentAngle,
    fallbackMode
  };
}
