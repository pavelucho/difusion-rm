import { describe, it, expect } from 'vitest';
import { computeRoiStats } from '../stats';
import { getImageMapping } from '../coordinates';

describe('ROI Tool Defect Fixes', () => {
  describe('computeRoiStats', () => {
    it('returns exact values when no pixels are masked (FIX A)', () => {
      // 32x32 image = 1024 pixels
      const pixels = new Float32Array(1024).fill(100);
      const validityMask = new Uint8Array(1024).fill(1); // all valid
      
      const roiMask = new Uint8Array(1024).fill(0);
      // 10x10 rectangular ROI = 100 pixels
      for (let y = 0; y < 10; y++) {
        for (let x = 0; x < 10; x++) {
          roiMask[y * 32 + x] = 1;
        }
      }

      const stats = computeRoiStats({ pixels, validityMask, roiMask });
      
      expect(stats.n).toBe(100);
      expect(stats.mean).toBe(100);
      expect(stats.masked).toBe(0);
    });

    it('handles partially masked ROIs correctly (FIX C.2)', () => {
      const pixels = new Float32Array(1024).fill(100);
      const roiMask = new Uint8Array(1024).fill(0);
      const validityMask = new Uint8Array(1024).fill(1);
      
      for (let y = 0; y < 10; y++) {
        for (let x = 0; x < 10; x++) {
          const idx = y * 32 + x;
          roiMask[idx] = 1;
          // Mask out half the ROI
          if (y < 5) {
            validityMask[idx] = 0;
          }
        }
      }

      const stats = computeRoiStats({ pixels, validityMask, roiMask });
      
      expect(stats.n).toBe(100);
      expect(stats.masked).toBe(50);
      expect(stats.maskedPercentage).toBe(50);
      expect(stats.mean).toBe(100);
    });
  });

  describe('getImageMapping', () => {
    it('correctly maps 256x256 image in 850x470 box (FIX B)', () => {
      const rect = { left: 100, top: 50, width: 850, height: 470 };
      const imgW = 256;
      const imgH = 256;
      
      const mapping = getImageMapping(rect, imgW, imgH);
      
      const expectedScale = 470 / 256;
      expect(mapping.scale).toBeCloseTo(expectedScale);
      
      expect(mapping.offX).toBeCloseTo(rect.left + (850 - 470) / 2); // 100 + 190 = 290
      expect(mapping.offY).toBeCloseTo(rect.top + (470 - 470) / 2); // 50
      
      // Centre of the box
      const centerX = rect.left + rect.width / 2; // 100 + 425 = 525
      const centerY = rect.top + rect.height / 2; // 50 + 235 = 285
      
      const imgX = (centerX - mapping.offX) / mapping.scale;
      const imgY = (centerY - mapping.offY) / mapping.scale;
      
      expect(imgX).toBeCloseTo(128, 0);
      expect(imgY).toBeCloseTo(128, 0);
    });
  });
});
