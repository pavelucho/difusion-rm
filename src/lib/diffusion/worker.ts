import JSZip from 'jszip';
import { parseDicom } from './dicom-reader';
import {
  inventariarSeries,
  serieInicial,
  type MatchedSlice,
  type SerieDetectada,
} from './series-builder';
import { calcularMapas, prepararConjunto, type AdcEquipoPreparado } from './estudio';
import { emparejarAdcEquipo } from './adc-equipo';
import { nombrePuedeSerDicom } from '../entrada-archivos';
import { createDerivedDicom, exportZip } from './dicom-writer';
import type { DicomSlice, AveragedSlice } from './types';
import { DicomNoSoportadoError } from './pixel-data';
import { es } from '../../i18n/es';

// We store state in the worker to handle recomputations and exports
let state: {
  /** Todos los cortes legibles del estudio, para poder cambiar de serie sin releer. */
  todosLosCortes: DicomSlice[];
  series: SerieDetectada[];
  serieElegida: string[];
  /** Grupos de difusión; el emparejamiento se rehace según el modo de cálculo. */
  diffusionGroups: Map<string, AveragedSlice>;
  matched: MatchedSlice[];
  bValues: number[];
  /** ADC del equipo de la misma adquisición, en mm²/s; se empareja por posición. */
  adcEquipo?: AdcEquipoPreparado;
  threshold: number;
  registrationMode: "none" | "translation" | "rigid";
  bLow: number;
  bHigh: number;
  bTarget: number;
  useMultiB: boolean;
} | null = null;

/**
 * Deja el estudio listo para calcular a partir de una serie concreta, y avisa a la
 * interfaz. Se usa al cargar y cada vez que se cambia de serie, sin releer nada:
 * los cortes ya están en memoria.
 */
function prepararSerie(
  todosLosCortes: DicomSlice[],
  series: SerieDetectada[],
  elegida: SerieDetectada,
  erroresLectura: string[]
): void {
  // El desplegable no deja elegir lo que no es difusión, pero el cálculo no debe
  // depender de eso: una T1 o un eADC no son una serie de difusión.
  if (!elegida.esDifusion) throw new Error(es.errSerieNoDifusion);

  const {
    diffusion, bValues, bLow, bHigh, multiB, matched, discardedCount, errors, avisos, threshold, adcEquipo,
  } = prepararConjunto(todosLosCortes, series, elegida);

  state = {
    todosLosCortes,
    series,
    serieElegida: elegida.seriesUIDs,
    diffusionGroups: diffusion,
    matched,
    bValues,
    adcEquipo,
    threshold,
    registrationMode: 'translation',
    bLow,
    bHigh,
    bTarget: 2000,
    useMultiB: multiB
  };

  self.postMessage({
    type: 'LOADED',
    payload: {
      bValues,
      bLow,
      bHigh,
      useMultiB: multiB,
      threshold,
      discardedCount,
      errors: [...erroresLectura, ...avisos, ...errors],
      sliceCount: matched.length,
      hasVendorAdc: Boolean(adcEquipo && adcEquipo.cortes.length > 0),
      adcEquipo: adcEquipo && {
        descripcion: adcEquipo.descripcion,
        unidad: adcEquipo.unidad.etiqueta,
        origenUnidad: adcEquipo.unidad.origen,
      },
      series: series.map(s => ({
        id: s.seriesUIDs.join('|'),
        descripcion: s.descripcion,
        imagenes: s.imagenes,
        valoresB: s.valoresB,
        matriz: `${s.filas}×${s.columnas}`,
        esDifusion: s.esDifusion,
        excluida: s.excluida,
        conAdc: Boolean(s.adcEquipo),
      })),
      serieElegida: elegida.seriesUIDs.join('|'),
      columns: matched.length > 0 ? matched[0].slicesByBValue.get(bLow)!.metadata.columns : 256,
      rows: matched.length > 0 ? matched[0].slicesByBValue.get(bLow)!.metadata.rows : 256
    }
  });
}

self.onmessage = async (e: MessageEvent) => {
  const { type, payload } = e.data;

  try {
    if (type === 'LOAD_ZIP' || type === 'LOAD_FILES') {
      // Dos formas de llegar al mismo sitio: un ZIP que hay que descomprimir, o los
      // archivos del estudio tal cual, que es como los tiene quien copia una carpeta
      // del PACS o mete el CD. En ambos casos se acaba con una lista de búferes.
      let leerArchivo: (indice: number) => Promise<ArrayBuffer>;
      let totalFiles: number;

      if (type === 'LOAD_ZIP') {
        const zip = new JSZip();
        const unzipped = await zip.loadAsync(payload.file);
        // Un export de PACS trae dentro el visor de escritorio y sus instaladores:
        // descomprimir cientos de megas para descubrir que no son imágenes es
        // tiempo y memoria tirados.
        const entradas = Object.values(unzipped.files)
          .filter(f => !f.dir && nombrePuedeSerDicom(f.name));
        totalFiles = entradas.length;
        leerArchivo = (i) => entradas[i].async('arraybuffer');
      } else {
        const archivos: File[] = payload.files;
        totalFiles = archivos.length;
        leerArchivo = (i) => archivos[i].arrayBuffer();
      }

      const slices: DicomSlice[] = [];
      let processedCount = 0;
      // Un archivo que no es DICOM se ignora sin más; uno que sí lo es pero no se
      // puede decodificar tiene que llegar al usuario, agrupado por motivo, en
      // lugar de desaparecer y dejar una serie incompleta sin explicación.
      const ilegibles = new Map<string, number>();

      for (let indice = 0; indice < totalFiles; indice++) {
        try {
          const buffer = await leerArchivo(indice);
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

      // Un estudio exportado del PACS trae todas las secuencias del examen y una
      // sola de difusión. Hay que quedarse con esa antes de agrupar nada.
      const series = inventariarSeries(slices);
      const elegida = serieInicial(series);

      if (!elegida) {
        throw new Error(es.errSinDifusion);
      }

      prepararSerie(slices, series, elegida, erroresLectura);

    } else if (type === 'SELECT_SERIES') {
      if (!state) return;
      const elegida = state.series.find(s => s.seriesUIDs.join('|') === payload.id);
      if (!elegida) return;
      prepararSerie(state.todosLosCortes, state.series, elegida, []);

    } else if (type === 'COMPUTE') {
      if (!state) return;
      
      const { bLow, bHigh, bTarget, threshold, useMultiB, registrationMode } = payload;
      state.bLow = bLow;
      state.bHigh = bHigh;
      state.bTarget = bTarget;
      state.threshold = threshold;
      state.useMultiB = useMultiB;
      state.registrationMode = registrationMode || 'translation';

      const emparejado = calcularMapas(
        state.diffusionGroups,
        state.bValues,
        { bLow, bHigh, bTarget, threshold, useMultiB, registrationMode: state.registrationMode },
        (i, total) => {
          if (i % 5 === 0 || i === total - 1) {
            self.postMessage({ type: 'PROGRESS', payload: { step: es.pasoCalculo, progress: (i + 1) / total } });
          }
        }
      );
      state.matched = emparejado.matched;
      const results = emparejado.resultados;

      // El ADC del equipo, corte a corte a la misma altura que cada corte
      // calculado, o null donde el equipo no tiene corte. Se rehace aquí porque
      // los cortes emparejados cambian con el modo de cálculo.
      const avisosCalculo = [...emparejado.errors];
      let vendorAdcData: (Float32Array | null)[] = [];
      if (state.adcEquipo) {
        const { porCorte, sinPareja } = emparejarAdcEquipo(state.matched, state.adcEquipo.cortes);
        vendorAdcData = porCorte.map(corte => corte?.pixelData ?? null);
        if (sinPareja > 0) {
          avisosCalculo.push(
            es.avisoAdcSinPareja
              .replace('{n}', String(sinPareja))
              .replace('{total}', String(state.matched.length))
          );
        }
      }

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
        payload: {
          results,
          vendorAdcData,
          dicomWindows,
          bLow,
          bHigh,
          threshold,
          discardedCount: emparejado.discardedCount,
          matchErrors: avisosCalculo
        }
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
