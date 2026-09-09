import JSZip from 'jszip';
import { parseDicom } from './dicom-reader';
import { groupAndAverageSlices, matchSlices, type MatchedSlice } from './series-builder';
import { estimateNoiseThreshold, computeTwoPointMaps, computeMultiBMaps } from './maps';
import { registerSlice } from './registration';
import { createDerivedDicom, exportZip } from './dicom-writer';
import type { DicomSlice, AveragedSlice, MapResult } from './types';
import { DicomNoSoportadoError } from './pixel-data';
import { es } from '../../i18n/es';

// We store state in the worker to handle recomputations and exports
let state: {
  matched: MatchedSlice[];
  bValues: number[];
  vendorAdcMaps: AveragedSlice[];
  threshold: number;
  registrationMode: "none" | "translation" | "rigid";
  bLow: number;
  bHigh: number;
  bTarget: number;
  useMultiB: boolean;
} | null = null;

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;

  try {
    if (type === 'LOAD_ZIP') {
      const { file } = payload;
      const zip = new JSZip();
      const unzipped = await zip.loadAsync(file);
      
      const files = Object.values(unzipped.files).filter(f => !f.dir);
      const totalFiles = files.length;
      
      const slices: DicomSlice[] = [];
      let processedCount = 0;
      // Un archivo que no es DICOM se ignora sin más; uno que sí lo es pero no se
      // puede decodificar tiene que llegar al usuario, agrupado por motivo, en
      // lugar de desaparecer y dejar una serie incompleta sin explicación.
      const ilegibles = new Map<string, number>();

      for (const f of files) {
        try {
          const buffer = await f.async('arraybuffer');
          const slice = parseDicom(buffer);
          slices.push(slice);
        } catch (err) {
          if (err instanceof DicomNoSoportadoError) {
            ilegibles.set(err.message, (ilegibles.get(err.message) ?? 0) + 1);
          }
          // Cualquier otro error se trata como archivo que no es DICOM.
        }
        processedCount++;
        if (processedCount % 10 === 0 || processedCount === totalFiles) {
          self.postMessage({ type: 'PROGRESS', payload: { step: es.pasoLectura, progress: processedCount / totalFiles } });
        }
      }

      const erroresLectura = [...ilegibles.entries()].map(([motivo, n]) =>
        es.errArchivosIlegibles.replace('{n}', String(n)).replace('{motivo}', motivo)
      );

      if (slices.length === 0) {
        throw new Error(erroresLectura[0] ?? es.errSinImagenes);
      }

      self.postMessage({ type: 'PROGRESS', payload: { step: es.pasoAgrupacion, progress: 1.0 } });
      
      const groups = groupAndAverageSlices(slices);
      
      const vendorAdcGroups = Array.from(groups.values()).filter(g => g.metadata.isVendorADC);
      const vendorAdcMaps = vendorAdcGroups.sort((a, b) => a.metadata.canonicalPosition - b.metadata.canonicalPosition);
      
      const bValues = Array.from(new Set(
        Array.from(groups.values())
        .filter(g => !g.metadata.isVendorADC)
        .map(g => g.metadata.bValue)
      )).sort((a, b) => a - b);
      
      let bLow = bValues.find(b => b >= 150) ?? bValues[0];
      let bHigh = bValues[bValues.length - 1];
      
      const { matched, discardedCount, errors } = matchSlices(groups, bValues);

      // Avisos sobre la procedencia de los valores b: un ADC calculado sobre una b
      // deducida del nombre de la secuencia no merece la misma confianza que uno
      // calculado sobre el tag estándar.
      const sinValorB = slices.filter(s => s.metadata.bValueSource === 'ausente').length;
      const bDeTexto = slices.filter(
        s => s.metadata.bValueSource === 'nombre-secuencia' || s.metadata.bValueSource === 'descripcion'
      ).length;

      const avisos = [...erroresLectura];
      if (sinValorB > 0) avisos.push(es.warnBInferred.replace('{n}', String(sinValorB)));
      if (bDeTexto > 0) avisos.push(es.warnBFromText.replace('{n}', String(bDeTexto)));
      
      let threshold = 0;
      if (matched.length > 0) {
        const refSlice = matched[Math.floor(matched.length / 2)].slicesByBValue.get(bLow);
        if (refSlice) {
          threshold = estimateNoiseThreshold(refSlice).threshold;
        }
      }
      
      state = {
        matched,
        bValues,
        vendorAdcMaps,
        threshold,
        registrationMode: 'translation',
        bLow,
        bHigh,
        bTarget: 2000,
        useMultiB: false
      };
      
      self.postMessage({
        type: 'LOADED',
        payload: {
          bValues,
          bLow,
          bHigh,
          threshold,
          discardedCount,
          errors: [...avisos, ...errors],
          sliceCount: matched.length,
          hasVendorAdc: vendorAdcMaps.length > 0,
          columns: matched.length > 0 ? matched[0].slicesByBValue.get(bLow)!.metadata.columns : 256,
          rows: matched.length > 0 ? matched[0].slicesByBValue.get(bLow)!.metadata.rows : 256
        }
      });
      
    } else if (type === 'COMPUTE') {
      if (!state) return;
      
      const { bLow, bHigh, bTarget, threshold, useMultiB, registrationMode } = payload;
      state.bLow = bLow;
      state.bHigh = bHigh;
      state.bTarget = bTarget;
      state.threshold = threshold;
      state.useMultiB = useMultiB;
      state.registrationMode = registrationMode || 'translation';
      
      const results: { sliceIndex: number; maps: MapResult; registeredSlices: Record<number, Float32Array>; transforms: Record<number, any> }[] = [];
      const totalSlices = state.matched.length;
      
      for (let i = 0; i < totalSlices; i++) {
        const match = state.matched[i];
        
        let refSlice = match.slicesByBValue.get(bLow)!;
        let slicesToUse: AveragedSlice[] = [];
        let bValuesToUse: number[] = [];
        let registeredSlices: Record<number, Float32Array> = {};
        let transforms: Record<number, any> = {};
        
        registeredSlices[bLow] = refSlice.pixelData;
        
        if (useMultiB) {
          bValuesToUse = state.bValues;
          for (const b of state.bValues) {
            let slice = match.slicesByBValue.get(b)!;
            if (b !== bLow) {
              const regResult = registerSlice(refSlice, slice, state.registrationMode);
              slice = regResult.registeredSlice;
              transforms[b] = { dx: regResult.dx, dy: regResult.dy, angle: regResult.angle, fallbackMode: regResult.fallbackMode };
            }
            slicesToUse.push(slice);
            registeredSlices[b] = slice.pixelData;
          }
        } else {
          let highSlice = match.slicesByBValue.get(bHigh)!;
          const regResult = registerSlice(refSlice, highSlice, state.registrationMode);
          highSlice = regResult.registeredSlice;
          transforms[bHigh] = { dx: regResult.dx, dy: regResult.dy, angle: regResult.angle, fallbackMode: regResult.fallbackMode };
          
          bValuesToUse = [bLow, bHigh];
          slicesToUse = [refSlice, highSlice];
          registeredSlices[bHigh] = highSlice.pixelData;
        }
        
        let maps: MapResult;
        if (useMultiB) {
          maps = computeMultiBMaps(slicesToUse, bValuesToUse, bTarget, threshold);
        } else {
          maps = computeTwoPointMaps(slicesToUse[0], slicesToUse[1], bLow, bHigh, bTarget, threshold);
        }
        
        results.push({ sliceIndex: i, maps, registeredSlices, transforms });
        
        if (i % 5 === 0 || i === totalSlices - 1) {
          self.postMessage({ type: 'PROGRESS', payload: { step: es.pasoCalculo, progress: (i + 1) / totalSlices } });
        }
      }
      
      // Also return raw arrays of vendor ADC if requested
      const vendorAdcData = state.vendorAdcMaps.map(m => m.pixelData);
      
      const dicomWindows: Record<number, { center: number, width: number } | null> = {};
      const refB = state.matched[Math.floor(state.matched.length / 2)];
      if (refB) {
        const bl = refB.slicesByBValue.get(bLow);
        if (bl && bl.metadata.windowWidth && bl.metadata.windowWidth > 1 && bl.metadata.windowCenter) {
          dicomWindows[bLow] = { center: bl.metadata.windowCenter, width: bl.metadata.windowWidth };
        }
        const bh = refB.slicesByBValue.get(bHigh);
        if (bh && bh.metadata.windowWidth && bh.metadata.windowWidth > 1 && bh.metadata.windowCenter) {
          dicomWindows[bHigh] = { center: bh.metadata.windowCenter, width: bh.metadata.windowWidth };
        }
      }
      
      self.postMessage({
        type: 'COMPUTED',
        payload: { results, vendorAdcData, dicomWindows, bLow, bHigh, threshold }
      });
      
    } else if (type === 'EXPORT_DICOM') {
      if (!state) return;
      const { mapsData } = payload; // Array of maps from UI or computed here
      
      let totalSaturated = 0;
      let totalUnmasked = 0;
      const filesToExport: { buffer: ArrayBuffer, mapType: string, index: number }[] = [];
      
      const dcmjs = (await import('dcmjs')).default;
      const seriesUIDs = {
        ADC: dcmjs.data.DicomMetaDictionary.uid(),
        EADC: dcmjs.data.DicomMetaDictionary.uid(),
        CDWI: dcmjs.data.DicomMetaDictionary.uid()
      };
      
      let processed = 0;
      const totalToExport = state.matched.length * 3;
      
      for (let i = 0; i < state.matched.length; i++) {
        const match = state.matched[i];
        const result = mapsData[i];
        
        const refSlice = match.slicesByBValue.get(state.bLow)!;
        
        for (let iMask = 0; iMask < result.maps.mask.length; iMask++) {
          if (result.maps.mask[iMask] === 1) totalUnmasked++;
        }
        
        const params = {
          bLow: state.bLow,
          bHigh: state.bHigh,
          bTarget: state.bTarget,
          bValues: state.useMultiB ? state.bValues : undefined,
          threshold: state.threshold,
          registration: state.registrationMode
        };
        
        const adcRes = await createDerivedDicom(refSlice, result.maps.adc, 'ADC', params, seriesUIDs.ADC, dcmjs.data.DicomMetaDictionary.uid());
        filesToExport.push({ buffer: adcRes.buffer, mapType: 'ADC', index: i });
        totalSaturated += adcRes.saturatedCount;
        processed++;
        
        const eadcRes = await createDerivedDicom(refSlice, result.maps.eadc, 'EADC', params, seriesUIDs.EADC, dcmjs.data.DicomMetaDictionary.uid());
        filesToExport.push({ buffer: eadcRes.buffer, mapType: 'EADC', index: i });
        totalSaturated += eadcRes.saturatedCount;
        processed++;
        
        const cdwiRes = await createDerivedDicom(refSlice, result.maps.cdwi, 'CDWI', params, seriesUIDs.CDWI, dcmjs.data.DicomMetaDictionary.uid());
        filesToExport.push({ buffer: cdwiRes.buffer, mapType: 'CDWI', index: i });
        totalSaturated += cdwiRes.saturatedCount;
        processed++;
        
        if (processed % 10 === 0) {
          self.postMessage({ type: 'PROGRESS', payload: { step: es.pasoGenerandoDicom, progress: processed / totalToExport } });
        }
      }
      
      self.postMessage({ type: 'PROGRESS', payload: { step: es.pasoComprimiendo, progress: 1.0 } });
      const zipBlob = await exportZip(filesToExport);
      
      const saturationPct = totalUnmasked > 0 ? (totalSaturated / (totalUnmasked * 3)) * 100 : 0;
      
      self.postMessage({
        type: 'EXPORTED',
        payload: { zipBlob, saturationPct }
      });
    }
  } catch (error: any) {
    self.postMessage({ type: 'ERROR', payload: error.message });
  }
};
