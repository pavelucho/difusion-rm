export interface RoiStats {
  n: number;
  masked: number;
  maskedPercentage: number;
  mean: number;
  std: number;
  median: number;
  min: number;
  max: number;
  p10: number;
  p90: number;
}

export function computeRoiStats(args: {
  pixels: Float32Array;
  validityMask: Uint8Array;
  roiMask: Uint8Array;
}): RoiStats {
  const { pixels, validityMask, roiMask } = args;
  const values: number[] = [];
  let n = 0;
  
  for (let i = 0; i < pixels.length; i++) {
    if (roiMask[i] === 1) {
      n++;
      if (validityMask[i] === 1) {
        values.push(pixels[i]);
      }
    }
  }
  
  const masked = n - values.length;
  const maskedPercentage = n > 0 ? (masked / n) * 100 : 0;
  
  if (values.length === 0) {
    return {
      n, masked, maskedPercentage,
      mean: 0, std: 0, median: 0, min: 0, max: 0, p10: 0, p90: 0
    };
  }
  
  values.sort((a, b) => a - b);
  
  const min = values[0];
  const max = values[values.length - 1];
  
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  const mean = sum / values.length;
  
  let sqSum = 0;
  for (let i = 0; i < values.length; i++) {
    const diff = values[i] - mean;
    sqSum += diff * diff;
  }
  const std = Math.sqrt(sqSum / (values.length > 1 ? values.length - 1 : 1));
  
  const median = values[Math.floor(values.length / 2)];
  const p10 = values[Math.floor(values.length * 0.1)];
  const p90 = values[Math.floor(values.length * 0.9)];
  
  return {
    n, masked, maskedPercentage,
    mean, std, median, min, max, p10, p90
  };
}

/**
 * Contraste de una lesión frente a un tejido de referencia.
 *
 * CR usa el valor absoluto de la media de referencia: en mapas que admiten
 * valores negativos, dividir por la media con signo invertiría el contraste.
 */
export function computeContrast(
  lesionMean: number,
  referenceMean: number,
  backgroundSd: number
): { cr: number, cnr: number } {
  const cr = referenceMean !== 0 ? (lesionMean - referenceMean) / Math.abs(referenceMean) : 0;
  const cnr = backgroundSd !== 0 ? (lesionMean - referenceMean) / backgroundSd : 0;

  return { cr, cnr };
}

export function computeLinCCC(x: number[], y: number[]): { ccc: number; bias: number; sd: number } {
  if (x.length === 0 || x.length !== y.length) return { ccc: 0, bias: 0, sd: 0 };
  
  const n = x.length;
  let sumX = 0, sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += x[i];
    sumY += y[i];
  }
  
  const meanX = sumX / n;
  const meanY = sumY / n;
  
  let varX = 0, varY = 0, covXY = 0, sumDiffSq = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    varX += dx * dx;
    varY += dy * dy;
    covXY += dx * dy;
    
    const diff = y[i] - x[i] - (meanY - meanX);
    sumDiffSq += diff * diff;
  }
  
  varX /= n;
  varY /= n;
  covXY /= n;
  
  const expectedDifference = (meanX - meanY) * (meanX - meanY);
  const ccc = (2 * covXY) / (varX + varY + expectedDifference);
  
  const bias = meanY - meanX;
  const sd = Math.sqrt(sumDiffSq / (n > 1 ? n - 1 : 1));
  
  return { ccc, bias, sd };
}
