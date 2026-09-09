import type { AveragedSlice, MapResult } from './types';

export function estimateNoiseThreshold(lowBSlice: AveragedSlice, multiplier: number = 3): { threshold: number, mean: number, sd: number } {
  const { columns, rows } = lowBSlice.metadata;
  const pixels = lowBSlice.pixelData;
  const patchSize = 16;
  const corners = [
    { startX: 0, startY: 0 },
    { startX: columns - patchSize, startY: 0 },
    { startX: 0, startY: rows - patchSize },
    { startX: columns - patchSize, startY: rows - patchSize }
  ];

  const samples: number[] = [];
  for (const corner of corners) {
    // If image is smaller than 32x32, we just clamp
    const endX = Math.min(corner.startX + patchSize, columns);
    const endY = Math.min(corner.startY + patchSize, rows);
    const startX = Math.max(0, corner.startX);
    const startY = Math.max(0, corner.startY);

    for (let y = startY; y < endY; y++) {
      for (let x = startX; x < endX; x++) {
        samples.push(pixels[y * columns + x]);
      }
    }
  }

  if (samples.length === 0) return { threshold: 0, mean: 0, sd: 0 };

  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i];
  const mean = sum / samples.length;

  let sqSum = 0;
  for (let i = 0; i < samples.length; i++) {
    const diff = samples[i] - mean;
    sqSum += diff * diff;
  }
  const sd = Math.sqrt(sqSum / (samples.length > 1 ? samples.length - 1 : 1));

  return {
    threshold: mean + multiplier * sd,
    mean,
    sd
  };
}

export function computeTwoPointMaps(
  s1Slice: AveragedSlice,
  s2Slice: AveragedSlice,
  b1: number,
  b2: number,
  bTarget: number,
  threshold: number
): MapResult {
  const numPixels = s1Slice.pixelData.length;
  const adc = new Float32Array(numPixels);
  const eadc = new Float32Array(numPixels);
  const cdwi = new Float32Array(numPixels);
  const mask = new Uint8Array(numPixels);

  const s1 = s1Slice.pixelData;
  const s2 = s2Slice.pixelData;

  const db = b2 - b1;
  if (db === 0) {
    throw new Error('Identical b-values');
  }

  for (let i = 0; i < numPixels; i++) {
    const v1 = s1[i];
    const v2 = s2[i];

    if (v1 > threshold && v2 > 0) {
      const computedAdc = Math.log(v1 / v2) / db;
      if (Number.isFinite(computedAdc) && computedAdc >= 0 && computedAdc <= 0.004) {
        adc[i] = computedAdc;
        eadc[i] = Math.exp(-b2 * computedAdc);
        cdwi[i] = v1 * Math.exp((b1 - bTarget) * computedAdc);
        mask[i] = 1;
        continue;
      }
    }

    // Invalid voxels
    adc[i] = 0;
    eadc[i] = 0;
    cdwi[i] = 0;
    mask[i] = 0;
  }

  return { adc, eadc, cdwi, mask, bTarget, bLow: b1, bHigh: b2 };
}

export function computeMultiBMaps(
  slices: AveragedSlice[],
  bValues: number[],
  bTarget: number,
  threshold: number
): MapResult {
  const numPixels = slices[0].pixelData.length;
  const adc = new Float32Array(numPixels);
  const eadc = new Float32Array(numPixels);
  const cdwi = new Float32Array(numPixels);
  const r2Map = new Float32Array(numPixels);
  const mask = new Uint8Array(numPixels);

  const minBIndex = bValues.indexOf(Math.min(...bValues));
  const maxBIndex = bValues.indexOf(Math.max(...bValues));
  
  const bLow = bValues[minBIndex];
  const bHigh = bValues[maxBIndex];
  
  const sLow = slices[minBIndex].pixelData;
  const sHigh = slices[maxBIndex].pixelData;

  for (let i = 0; i < numPixels; i++) {
    const v1 = sLow[i];
    const v2 = sHigh[i];

    let validSlices = true;
    for (let j = 0; j < slices.length; j++) {
      if (slices[j].pixelData[i] <= 0) {
        validSlices = false;
        break;
      }
    }

    if (v1 > threshold && v2 > 0 && validSlices) {
      let sumW = 0, sumWx = 0, sumWy = 0, sumWxx = 0, sumWxy = 0;
      let sumY = 0;
      
      for (let j = 0; j < bValues.length; j++) {
        const s = slices[j].pixelData[i];
        const b = bValues[j];
        const y = Math.log(s);
        const w = s * s;
        
        sumW += w;
        sumWx += w * b;
        sumWy += w * y;
        sumWxx += w * b * b;
        sumWxy += w * b * y;
        sumY += y;
      }
      
      const delta = sumW * sumWxx - sumWx * sumWx;
      if (delta !== 0) {
        // y = C - ADC * b => slope is -ADC
        const slope = (sumW * sumWxy - sumWx * sumWy) / delta;
        const intercept = (sumWxx * sumWy - sumWx * sumWxy) / delta;
        const computedAdc = -slope;

        if (Number.isFinite(computedAdc) && computedAdc >= 0 && computedAdc <= 0.004) {
          adc[i] = computedAdc;
          eadc[i] = Math.exp(-bHigh * computedAdc);
          // General cdwi from fitted intercept: cDWI = S(bTarget) = exp(intercept - bTarget * ADC)
          // Wait, prompt says "cDWI = S1 * Math.exp((b1 - bTarget) * ADC)" for two point.
          // For multi-b, what should we use? Let's use the fitted intercept (S0 = exp(intercept)) 
          // cDWI = S0 * exp(-bTarget * ADC).
          cdwi[i] = Math.exp(intercept - bTarget * computedAdc);
          
          // R^2 calculation
          let yMeanW = sumWy / sumW;
          let ssTot = 0;
          let ssRes = 0;
          
          for (let j = 0; j < bValues.length; j++) {
            const s = slices[j].pixelData[i];
            const b = bValues[j];
            const y = Math.log(s);
            const w = s * s;
            const yPred = intercept + slope * b;
            
            ssTot += w * (y - yMeanW) * (y - yMeanW);
            ssRes += w * (y - yPred) * (y - yPred);
          }
          
          let r2 = 1 - (ssRes / (ssTot === 0 ? 1 : ssTot));
          if (!Number.isFinite(r2)) r2 = 0;
          r2Map[i] = r2;

          mask[i] = 1;
          continue;
        }
      }
    }

    // Invalid voxels
    adc[i] = 0;
    eadc[i] = 0;
    cdwi[i] = 0;
    r2Map[i] = 0;
    mask[i] = 0;
  }

  return { adc, eadc, cdwi, r2: r2Map, mask, bTarget, bLow, bHigh };
}
