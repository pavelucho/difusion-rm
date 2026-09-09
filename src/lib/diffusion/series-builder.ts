import type { DicomSlice, AveragedSlice } from './types';
import { es } from '../../i18n/es';

export function groupAndAverageSlices(slices: DicomSlice[]): Map<string, AveragedSlice> {
  const groups = new Map<string, AveragedSlice>();
  
  for (const slice of slices) {
    // Ignore vendor ADC maps
    if (slice.metadata.isVendorADC) continue;
    
    const key = `${slice.metadata.bValue}|${slice.metadata.canonicalPosition.toFixed(2)}`;
    
    if (groups.has(key)) {
      const existing = groups.get(key)!;
      for (let i = 0; i < existing.pixelData.length; i++) {
        existing.pixelData[i] += slice.pixelData[i];
      }
      existing.count += 1;
    } else {
      groups.set(key, {
        metadata: slice.metadata,
        pixelData: new Float32Array(slice.pixelData),
        count: 1
      });
    }
  }
  
  // Finalize average
  for (const group of groups.values()) {
    if (group.count > 1) {
      for (let i = 0; i < group.pixelData.length; i++) {
        group.pixelData[i] /= group.count;
      }
    }
  }
  
  return groups;
}

export interface MatchedSlice {
  position: number;
  slicesByBValue: Map<number, AveragedSlice>;
}

export function matchSlices(
  groups: Map<string, AveragedSlice>,
  selectedBValues: number[]
): { matched: MatchedSlice[]; discardedCount: number; errors: string[] } {
  const slicesByB = new Map<number, AveragedSlice[]>();
  
  for (const b of selectedBValues) {
    slicesByB.set(b, []);
  }
  
  for (const slice of groups.values()) {
    const b = slice.metadata.bValue;
    if (slicesByB.has(b)) {
      slicesByB.get(b)!.push(slice);
    }
  }
  
  for (const list of slicesByB.values()) {
    list.sort((a, b) => a.metadata.canonicalPosition - b.metadata.canonicalPosition);
  }
  
  if (selectedBValues.length === 0) {
    return { matched: [], discardedCount: 0, errors: [] };
  }

  const refB = selectedBValues[0];
  const refSlices = slicesByB.get(refB) || [];
  
  const matched: MatchedSlice[] = [];
  let discardedCount = 0;
  const errors: Set<string> = new Set();
  
  let totalSelectedSlices = 0;
  for (const b of selectedBValues) {
    totalSelectedSlices += (slicesByB.get(b)?.length || 0);
  }
  
  for (const refSlice of refSlices) {
    const pos = refSlice.metadata.canonicalPosition;
    const matchForThisPos = new Map<number, AveragedSlice>();
    matchForThisPos.set(refB, refSlice);
    
    let isCompleteMatch = true;
    let hasGeometryError = false;
    
    for (let i = 1; i < selectedBValues.length; i++) {
      const b = selectedBValues[i];
      const candidates = slicesByB.get(b) || [];
      const bestMatch = candidates.find(c => Math.abs(c.metadata.canonicalPosition - pos) <= 0.5);
      
      if (!bestMatch) {
        isCompleteMatch = false;
        break;
      }
      
      if (
        bestMatch.metadata.columns !== refSlice.metadata.columns ||
        bestMatch.metadata.rows !== refSlice.metadata.rows ||
        bestMatch.metadata.frameOfReferenceUID !== refSlice.metadata.frameOfReferenceUID
      ) {
        hasGeometryError = true;
        errors.add(es.errGeometryMismatch);
        isCompleteMatch = false;
        break;
      }
      
      matchForThisPos.set(b, bestMatch);
    }
    
    if (isCompleteMatch && !hasGeometryError) {
      matched.push({
        position: pos,
        slicesByBValue: matchForThisPos
      });
    }
  }
  
  const usedSlices = matched.length * selectedBValues.length;
  discardedCount = totalSelectedSlices - usedSlices;
  
  return { matched, discardedCount, errors: Array.from(errors) };
}
