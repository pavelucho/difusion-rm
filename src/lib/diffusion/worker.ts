import JSZip from 'jszip';
import { leerCabecera, parseDicom } from './dicom-reader';
import {
  crearAgrupador,
  cortesDelConjunto,
  inventariarSeries,
  serieInicial,
  type MatchedSlice,
  type SerieDetectada,
} from './series-builder';
import { calcularMapas, prepararAgrupado, type AdcEquipoPreparado } from './estudio';
import { emparejarAdcEquipo } from './adc-equipo';
import { nombrePuedeSerDicom } from '../entrada-archivos';
import { hayDescompresionNativa, leerEntradaZip, leerIndiceZip } from '../zip-lectura';
import { createDerivedDicom, exportZip } from './dicom-writer';
import type { DicomSlice, AveragedSlice } from './types';
import { DicomNoSoportadoError } from './pixel-data';
import { es } from '../../i18n/es';

/**
 * De dónde se leen los archivos del estudio, por su posición. Se conserva para
 * releer la serie elegida: los archivos siguen en el disco y no en la memoria.
 */
interface Origen {
  total: number;
  leer: (indice: number) => Promise<ArrayBuffer>;
}

// We store state in the worker to handle recomputations and exports
let state: {
  origen: Origen;
  /** Cabeceras de todo el estudio, sin píxeles, para poder cambiar de serie. */
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

async function abrirOrigen(type: string, payload: any): Promise<Origen> {
  // Dos formas de llegar al mismo sitio: un ZIP que hay que descomprimir, o los
  // archivos del estudio tal cual, que es como los tiene quien copia una carpeta
  // del PACS o mete el CD.
  if (type === 'LOAD_FILES') {
    const archivos: File[] = payload.files;
    return { total: archivos.length, leer: (i) => archivos[i].arrayBuffer() };
  }

  const zip: File = payload.file;
  // Un export de PACS trae dentro el visor de escritorio y sus instaladores:
  // descomprimir cientos de megas para descubrir que no son imágenes es
  // tiempo y memoria tirados.
  if (hayDescompresionNativa()) {
    try {
      const entradas = (await leerIndiceZip(zip)).filter(e => nombrePuedeSerDicom(e.nombre));
      return { total: entradas.length, leer: (i) => leerEntradaZip(zip, entradas[i]) };
    } catch {
      // Un ZIP que el lector propio no entiende se abre con JSZip, como antes.
    }
  }
  // JSZip mantiene el ZIP entero en memoria: es el último recurso.
  const unzipped = await new JSZip().loadAsync(zip);
  const entradas = Object.values(unzipped.files).filter(f => !f.dir && nombrePuedeSerDicom(f.name));
  return { total: entradas.length, leer: (i) => entradas[i].async('arraybuffer') };
}

/**
 * Lee las cabeceras de todo el estudio. Los píxeles se comprueban pero no se
 * guardan: solo hacen falta los de la serie que se va a calcular.
 */
async function leerCabeceras(origen: Origen): Promise<{ cortes: DicomSlice[]; erroresLectura: string[] }> {
  const cortes: DicomSlice[] = [];
  // Un archivo que no es DICOM se ignora sin más; uno que sí lo es pero no se
  // puede decodificar tiene que llegar al usuario, agrupado por motivo, en
  // lugar de desaparecer y dejar una serie incompleta sin explicación.
  const ilegibles = new Map<string, number>();

  for (let indice = 0; indice < origen.total; indice++) {
    try {
      cortes.push(leerCabecera(await origen.leer(indice), indice));
    } catch (err) {
      if (err instanceof DicomNoSoportadoError) {
        ilegibles.set(err.message, (ilegibles.get(err.message) ?? 0) + 1);
      }
      // Cualquier otro error se trata como archivo que no es DICOM.
    }
    const leidos = indice + 1;
    if (leidos % 10 === 0 || leidos === origen.total) {
      self.postMessage({ type: 'PROGRESS', payload: { step: es.pasoLectura, progress: leidos / origen.total } });
    }
  }

  const erroresLectura = [...ilegibles.entries()].map(([motivo, n]) =>
    es.errArchivosIlegibles.replace('{n}', String(n)).replace('{motivo}', motivo)
  );
  return { cortes, erroresLectura };
}

/**
 * Lee del origen los píxeles de unos cortes y los va promediando por posición y
 * valor b, sin tener nunca la serie entera en memoria. El primer corte de cada
 * grupo conserva su archivo: es el que se clona al exportar los mapas.
 */
async function leerAgrupando(origen: Origen, cortes: DicomSlice[], avance: { hechos: number; total: number }) {
  const agrupador = crearAgrupador();
  for (const cabecera of cortes) {
    let buffer: ArrayBuffer;
    let pixelData: Float32Array;
    try {
      buffer = await origen.leer(cabecera.metadata.origen!);
      pixelData = parseDicom(buffer).pixelData;
    } catch {
      // Ya se leyó una vez: si ahora falla, el archivo ya no está o ha cambiado.
      throw new Error(es.errReleer);
    }
    agrupador.agregar({ metadata: { ...cabecera.metadata, buffer }, pixelData });
    avance.hechos++;
    if (avance.hechos % 10 === 0 || avance.hechos === avance.total) {
      self.postMessage({ type: 'PROGRESS', payload: { step: es.pasoLecturaSerie, progress: avance.hechos / avance.total } });
    }
  }
  return agrupador.terminar();
}

/**
 * Deja el estudio listo para calcular a partir de una serie concreta, y avisa a la
 * interfaz. Se usa al cargar y cada vez que se cambia de serie: las cabeceras ya
 * están en memoria, y de la serie elegida se leen los píxeles.
 */
async function prepararSerie(
  origen: Origen,
  todosLosCortes: DicomSlice[],
  series: SerieDetectada[],
  elegida: SerieDetectada,
  erroresLectura: string[]
): Promise<void> {
  // El desplegable no deja elegir lo que no es difusión, pero el cálculo no debe
  // depender de eso: una T1 o un eADC no son una serie de difusión.
  if (!elegida.esDifusion) throw new Error(es.errSerieNoDifusion);

  // La serie anterior se suelta antes de leer la nueva, para no tener las dos.
  state = null;

  const cortes = cortesDelConjunto(todosLosCortes, elegida);
  const avance = {
    hechos: 0,
    total: cortes.difusion.length + (elegida.adcEquipo ? cortes.adcEquipo.length : 0),
  };
  const { diffusion: grupos } = await leerAgrupando(origen, cortes.difusion, avance);
  const { vendorAdc } = elegida.adcEquipo
    ? await leerAgrupando(origen, cortes.adcEquipo, avance)
    : { vendorAdc: new Map<string, AveragedSlice>() };

  const {
    diffusion, bValues, bLow, bHigh, multiB, matched, discardedCount, errors, avisos, threshold, adcEquipo,
  } = prepararAgrupado(cortes, grupos, vendorAdc, series, elegida);

  state = {
    origen,
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

// Los mensajes se atienden de uno en uno: leer una serie es asíncrono, y un
// cálculo que llegara a mitad de la lectura trabajaría con el estado a medias.
let cola: Promise<void> = Promise.resolve();
self.onmessage = (e: MessageEvent) => {
  cola = cola.then(() => atender(e));
};

async function atender(e: MessageEvent): Promise<void> {
  const { type, payload } = e.data;

  try {
    if (type === 'LOAD_ZIP' || type === 'LOAD_FILES') {
      // El estudio anterior se suelta antes de leer el nuevo.
      state = null;
      const origen = await abrirOrigen(type, payload);
      const { cortes, erroresLectura } = await leerCabeceras(origen);

      if (cortes.length === 0) {
        throw new Error(erroresLectura[0] ?? es.errSinImagenes);
      }

      self.postMessage({ type: 'PROGRESS', payload: { step: es.pasoAgrupacion, progress: 0 } });

      // Un estudio exportado del PACS trae todas las secuencias del examen y una
      // sola de difusión. Hay que quedarse con esa antes de agrupar nada.
      const series = inventariarSeries(cortes);
      const elegida = serieInicial(series);

      if (!elegida) {
        throw new Error(es.errSinDifusion);
      }

      await prepararSerie(origen, cortes, series, elegida, erroresLectura);

    } else if (type === 'SELECT_SERIES') {
      if (!state) return;
      const elegida = state.series.find(s => s.seriesUIDs.join('|') === payload.id);
      if (!elegida) return;
      const { origen, todosLosCortes, series } = state;
      await prepararSerie(origen, todosLosCortes, series, elegida, []);

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
}
