import { describe, it, expect } from 'vitest';
import { computeTwoPointMaps, computeMultiBMaps } from '../maps';
import type { AveragedSlice } from '../types';

function createSlice(value: number): AveragedSlice {
  return {
    metadata: {
      columns: 1,
      rows: 1,
      pixelSpacing: [1, 1],
      imagePositionPatient: { x: 0, y: 0, z: 0 },
      imageOrientationPatient: [{ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
      canonicalPosition: 0,
      seriesInstanceUID: '',
      studyInstanceUID: '',
      frameOfReferenceUID: '',
      seriesDescription: '',
      instanceNumber: 1,
      bValue: 0,
      bValueInferred: false,
      isVendorADC: false,
      rescaleIntercept: 0,
      rescaleSlope: 1,
      dataset: null,
      buffer: new ArrayBuffer(0)
    },
    pixelData: new Float32Array([value]),
    count: 1
  };
}

describe('Map Computation', () => {
  it('1. ADC recovery from two point fit (150, 800)', () => {
    const trueADC = 1.2e-3;
    const S0 = 1000;
    const b1 = 150;
    const b2 = 800;
    const s1 = S0 * Math.exp(-b1 * trueADC);
    const s2 = S0 * Math.exp(-b2 * trueADC);

    const slice1 = createSlice(s1);
    const slice2 = createSlice(s2);

    const result = computeTwoPointMaps(slice1, slice2, b1, b2, 2000, 0);

    expect(Math.abs(result.adc[0] - trueADC)).toBeLessThan(1e-9);
  });

  it('2. cDWI recovery at b=2000', () => {
    const trueADC = 1.2e-3;
    const S0 = 1000;
    const b1 = 150;
    const b2 = 800;
    const s1 = S0 * Math.exp(-b1 * trueADC);
    const s2 = S0 * Math.exp(-b2 * trueADC);

    const slice1 = createSlice(s1);
    const slice2 = createSlice(s2);

    const result = computeTwoPointMaps(slice1, slice2, b1, b2, 2000, 0);
    const trueCDWI = S0 * Math.exp(-2000 * trueADC);

    expect(Math.abs(result.cdwi[0] - trueCDWI) / trueCDWI).toBeLessThan(1e-6);
  });

  it('3. eADC definition', () => {
    const trueADC = 1.2e-3;
    const S0 = 1000;
    const b1 = 150;
    const b2 = 800;
    const s1 = S0 * Math.exp(-b1 * trueADC);
    const s2 = S0 * Math.exp(-b2 * trueADC);

    const slice1 = createSlice(s1);
    const slice2 = createSlice(s2);

    const result = computeTwoPointMaps(slice1, slice2, b1, b2, 2000, 0);
    const expectedEADC = Math.exp(-b2 * trueADC);

    expect(result.eadc[0]).toBeCloseTo(expectedEADC, 7);
    expect(result.eadc[0]).not.toBeCloseTo(s2 / s1, 7); // Verify it's not simply s2/s1
  });

  it('4. S2 > S1 voxel masking', () => {
    const slice1 = createSlice(500);
    const slice2 = createSlice(600); // S2 > S1 => negative ADC

    const result = computeTwoPointMaps(slice1, slice2, 0, 1000, 2000, 0);

    expect(result.adc[0]).toBe(0);
    expect(result.mask[0]).toBe(0); // Masked out
  });

  it('5. Identical b-values throw error', () => {
    const slice1 = createSlice(1000);
    const slice2 = createSlice(500);

    expect(() => computeTwoPointMaps(slice1, slice2, 1000, 1000, 2000, 0)).toThrow();
  });

  it('6. Multi-b fit recovery', () => {
    const trueADC = 1.2e-3;
    const S0 = 1000;
    const bValues = [0, 150, 400, 800];
    const slices = bValues.map(b => createSlice(S0 * Math.exp(-b * trueADC)));

    const result = computeMultiBMaps(slices, bValues, 2000, 0);

    expect(Math.abs(result.adc[0] - trueADC)).toBeLessThan(1e-6);
    expect(result.r2![0]).toBeCloseTo(1, 4);
  });
});
