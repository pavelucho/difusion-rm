import type { DicomSlice, AveragedSlice } from './types';
import { es } from '../../i18n/es';

export interface SerieDetectada {
  /** Series que forman el conjunto. Un equipo puede repartir los valores b en varias. */
  seriesUIDs: string[];
  descripcion: string;
  imagenes: number;
  valoresB: number[];
  columnas: number;
  filas: number;
  esDifusion: boolean;
}

/**
 * Inventaría lo que trae el estudio, agrupando por serie.
 *
 * Un estudio exportado del PACS trae todas las secuencias: T1, T2, STIR,
 * dinámicos… y una sola de difusión. Sin este paso, todo lo que no lleva valor b
 * se toma como b = 0 y acaba promediado junto a la difusión —y con matrices
 * distintas, 256 contra 512 contra 1024—, de modo que el cálculo se hace sobre
 * una mezcla sin sentido.
 *
 * Las series se agrupan además por marco de referencia y matriz, porque hay
 * equipos que guardan cada valor b como una serie independiente: juntas forman un
 * único conjunto de difusión.
 */
export function inventariarSeries(slices: DicomSlice[]): SerieDetectada[] {
  const porSerie = new Map<string, DicomSlice[]>();
  for (const slice of slices) {
    const uid = slice.metadata.seriesInstanceUID || `sin-uid-${slice.metadata.seriesDescription}`;
    const lista = porSerie.get(uid);
    if (lista) lista.push(slice);
    else porSerie.set(uid, [slice]);
  }

  // Series compatibles entre sí: mismo marco de referencia y misma matriz.
  const conjuntos = new Map<string, { uids: string[]; slices: DicomSlice[] }>();
  for (const [uid, lista] of porSerie) {
    const m = lista[0].metadata;
    const clave = `${m.frameOfReferenceUID}|${m.rows}x${m.columns}`;
    const conjunto = conjuntos.get(clave);
    if (conjunto) {
      conjunto.uids.push(uid);
      conjunto.slices.push(...lista);
    } else {
      conjuntos.set(clave, { uids: [uid], slices: [...lista] });
    }
  }

  const detectadas: SerieDetectada[] = [];

  for (const { uids, slices: delConjunto } of conjuntos.values()) {
    const valoresB = [...new Set(delConjunto.map(s => s.metadata.bValue))].sort((a, b) => a - b);
    const primera = delConjunto[0].metadata;

    // Es difusión si hay más de un valor b real, o si algún corte trae un valor b
    // mayor que cero leído de un tag de valor b (no deducido de un texto).
    const bExplicita = delConjunto.some(
      s => s.metadata.bValue > 0 && s.metadata.bValueSource !== 'ausente'
    );
    const tipoDifusion = delConjunto.some(s =>
      (s.metadata.dataset?.string?.('x00080008') ?? '').toUpperCase().includes('DIFFUSION')
    );

    detectadas.push({
      seriesUIDs: uids,
      descripcion: descripcionComun(delConjunto),
      imagenes: delConjunto.length,
      valoresB,
      columnas: primera.columns,
      filas: primera.rows,
      esDifusion: (valoresB.length > 1 && bExplicita) || (bExplicita && tipoDifusion),
    });
  }

  return detectadas.sort((a, b) => {
    if (a.esDifusion !== b.esDifusion) return a.esDifusion ? -1 : 1;
    if (a.valoresB.length !== b.valoresB.length) return b.valoresB.length - a.valoresB.length;
    return b.imagenes - a.imagenes;
  });
}

function descripcionComun(slices: DicomSlice[]): string {
  const descripciones = [...new Set(slices.map(s => s.metadata.seriesDescription).filter(Boolean))];
  if (descripciones.length === 0) return 'Serie sin descripción';
  if (descripciones.length === 1) return descripciones[0];
  return `${descripciones[0]} (+${descripciones.length - 1})`;
}

/**
 * Se queda con los cortes del conjunto elegido. Sin conjunto, con los de la
 * primera serie de difusión que haya encontrado el inventario.
 */
export function filtrarPorSerie(slices: DicomSlice[], seriesUIDs: string[]): DicomSlice[] {
  const permitidos = new Set(seriesUIDs);
  return slices.filter(s => permitidos.has(s.metadata.seriesInstanceUID));
}

export interface GroupedSlices {
  /** Imágenes de difusión adquiridas, agrupadas por valor b y posición. */
  diffusion: Map<string, AveragedSlice>;
  /** Mapas de ADC ya calculados por el equipo, agrupados por serie y posición. */
  vendorAdc: Map<string, AveragedSlice>;
}

/**
 * Agrupa las imágenes por posición promediando las repeticiones.
 *
 * Los mapas de ADC del equipo se devuelven aparte en lugar de descartarse: son la
 * referencia contra la que se valida el ADC calculado. Antes se filtraban aquí y
 * después se buscaban en este mismo resultado, así que la comparación con el
 * equipo quedaba permanentemente vacía.
 */
export function groupAndAverageSlices(slices: DicomSlice[]): GroupedSlices {
  const diffusion = new Map<string, AveragedSlice>();
  const vendorAdc = new Map<string, AveragedSlice>();

  for (const slice of slices) {
    const posicion = slice.metadata.canonicalPosition.toFixed(2);
    // El valor b de un mapa de ADC no significa nada; lo que lo identifica es su
    // serie, para no promediar dos mapas distintos del mismo estudio.
    const destino = slice.metadata.isVendorADC ? vendorAdc : diffusion;
    const key = slice.metadata.isVendorADC
      ? `${slice.metadata.seriesInstanceUID}|${posicion}`
      : `${slice.metadata.bValue}|${posicion}`;

    const existing = destino.get(key);
    if (existing) {
      // Dos imágenes de la misma posición y valor b pero de distinta matriz no son
      // repeticiones: promediarlas mezclaría secuencias. Se deja la primera.
      if (existing.pixelData.length !== slice.pixelData.length) continue;
      for (let i = 0; i < existing.pixelData.length; i++) {
        existing.pixelData[i] += slice.pixelData[i];
      }
      existing.count += 1;
    } else {
      destino.set(key, {
        metadata: slice.metadata,
        pixelData: new Float32Array(slice.pixelData),
        count: 1
      });
    }
  }

  for (const grupo of [...diffusion.values(), ...vendorAdc.values()]) {
    if (grupo.count > 1) {
      for (let i = 0; i < grupo.pixelData.length; i++) {
        grupo.pixelData[i] /= grupo.count;
      }
    }
  }

  return { diffusion, vendorAdc };
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
