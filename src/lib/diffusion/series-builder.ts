import type { DicomMetadata, DicomSlice, AveragedSlice } from './types';
import { TOLERANCIA_POSICION_MM } from './adc-equipo';
import { es } from '../../i18n/es';

/**
 * Por qué una serie del estudio no entra en el cálculo aunque traiga valores b.
 *
 * Todas son imágenes que el equipo fabrica a partir de la difusión adquirida, así
 * que calcular con ellas es circular: GE guarda el eADC con el valor b de la DWI,
 * y Siemens y GE sintetizan imágenes a b altas a partir de su propio ADC.
 */
export type MotivoExclusion =
  | 'eadc'           // mapa eADC del equipo
  | 'b-calculada'    // imagen de b calculada (Siemens CALC_BVALUE)
  | 'sintetica'      // DWI sintética (GE «DW_Synthetic: …»)
  | 'mapa-derivado'  // FA, FA en color, ADC exponencial, tensor
  | 'copia-orig'     // copia «ORIG:» de una serie que el equipo ya procesó
  | 'adc-equipo';    // mapa ADC del equipo que no se asoció a ninguna difusión

export interface AdcDelConjunto {
  seriesUID: string;
  descripcion: string;
  imagenes: number;
}

export interface SerieDetectada {
  /** Series que forman el conjunto. Un equipo puede repartir los valores b en varias. */
  seriesUIDs: string[];
  descripcion: string;
  imagenes: number;
  valoresB: number[];
  columnas: number;
  filas: number;
  esDifusion: boolean;
  /** Marco de referencia, orientación, matriz y tamaño de píxel, comunes a todo el conjunto. */
  geometria: string;
  /** Posiciones de corte distintas. */
  posiciones: number;
  /** Imágenes por posición y valor b: 1 en una traza; más con direcciones o repeticiones. */
  repeticiones: number;
  /** Serie que se lista pero no se puede usar para calcular. */
  excluida?: MotivoExclusion;
  /** Mapa ADC del equipo de la misma adquisición, contra el que se valida. */
  adcEquipo?: AdcDelConjunto;
}

/** Una serie del estudio, tal como la ve el inventario. */
interface SerieLeida {
  uid: string;
  descripcion: string;
  numero: number;
  /** Cortes de la geometría dominante de la serie. */
  cortes: DicomSlice[];
  /** De esos, los que traen el valor b en un tag o en el nombre de la secuencia. */
  conValorB: DicomSlice[];
  geometria: string;
  /** TR y TE: las series de una misma adquisición los comparten. */
  firma: string;
  valoresB: Set<number>;
  posiciones: number[];
  horasAdquisicion: Set<string>;
  esAdcEquipo: boolean;
  aportaDifusion: boolean;
  excluida?: MotivoExclusion;
}

/**
 * Inventaría lo que trae el estudio y arma los conjuntos de difusión.
 *
 * Un estudio exportado del PACS trae todas las secuencias, varias copias y mapas
 * que el propio equipo deriva de la difusión. Un conjunto de difusión solo reúne:
 *
 * - imágenes con el valor b leído de un tag (sin él, antes pasaban por b = 0);
 * - de una misma geometría: marco de referencia, orientación, matriz y píxel (una
 *   T1 sagital con el mismo marco y matriz que la DWI axial acababa promediada
 *   con su b = 0);
 * - y de una misma serie, salvo cuando el equipo reparte los valores b de una
 *   adquisición en varias series: mismos TR y TE, mismos cortes y valores b que
 *   no se repiten. Dos series con el mismo valor b son dos adquisiciones o una
 *   copia, y promediarlas mezclaba la DWI con su copia sin procesar.
 *
 * Las imágenes derivadas o sintéticas del equipo se apartan antes, aunque traigan
 * valor b, y el mapa ADC del equipo se asocia al conjunto de su adquisición.
 */
export function inventariarSeries(slices: DicomSlice[]): SerieDetectada[] {
  const leidas = leerSeries(slices);
  marcarCopiasOrig(leidas);

  const candidatas = leidas.filter(s => !s.excluida && !s.esAdcEquipo && s.aportaDifusion);
  const mapasAdc = leidas.filter(s => !s.excluida && s.esAdcEquipo);
  const adcUsados = new Set<string>();

  const detectadas = reunirValoresBRepartidos(candidatas).map(miembros => {
    const adc = elegirAdcEquipo(miembros, mapasAdc);
    if (adc) adcUsados.add(adc.uid);
    return describirConjunto(miembros, adc);
  });

  for (const serie of leidas) {
    if (candidatas.includes(serie) || adcUsados.has(serie.uid)) continue;
    detectadas.push(describirSuelta(serie));
  }

  return detectadas.sort(ordenDePreferencia);
}

/** La que se elige al abrir el estudio: la primera de difusión del inventario. */
export function serieInicial(series: SerieDetectada[]): SerieDetectada | undefined {
  return series.find(s => s.esDifusion);
}

/**
 * Primero la difusión, y de ella la que trae el ADC del equipo, que es la que
 * el equipo calculó y la que se puede validar. Después, más valores b, la traza
 * antes que las direcciones sueltas y más cortes.
 */
function ordenDePreferencia(a: SerieDetectada, b: SerieDetectada): number {
  const grupo = (s: SerieDetectada) => (s.esDifusion ? 0 : s.excluida ? 1 : 2);
  if (grupo(a) !== grupo(b)) return grupo(a) - grupo(b);
  if (a.esDifusion) {
    if (Boolean(a.adcEquipo) !== Boolean(b.adcEquipo)) return a.adcEquipo ? -1 : 1;
    if (a.valoresB.length !== b.valoresB.length) return b.valoresB.length - a.valoresB.length;
    if (a.repeticiones !== b.repeticiones) return a.repeticiones - b.repeticiones;
    if (a.posiciones !== b.posiciones) return b.posiciones - a.posiciones;
  }
  return b.imagenes - a.imagenes;
}

/**
 * Clave de serie de cada corte. Sin SeriesInstanceUID, la descripción hace de
 * identificador. Si una serie mezcla imágenes adquiridas con el ADC del equipo o
 * con imágenes derivadas —hay equipos que guardan el ADC dentro de la serie de
 * la DWI—, esas partes se separan con un sufijo.
 */
function clavesDeSerie(slices: DicomSlice[]): Map<DicomSlice, string> {
  const tipo = (s: DicomSlice) =>
    s.metadata.isVendorADC ? 'adc' : motivoDerivada(s.metadata.imageType, s.metadata.seriesDescription) ?? '';
  const uid = (s: DicomSlice) => s.metadata.seriesInstanceUID || `sin-uid-${s.metadata.seriesDescription}`;

  const tiposPorSerie = new Map<string, Set<string>>();
  for (const s of slices) {
    const tipos = tiposPorSerie.get(uid(s)) ?? new Set<string>();
    tipos.add(tipo(s));
    tiposPorSerie.set(uid(s), tipos);
  }

  const claves = new Map<DicomSlice, string>();
  for (const s of slices) {
    const mezclada = tiposPorSerie.get(uid(s))!.size > 1;
    claves.set(s, mezclada && tipo(s) ? `${uid(s)}#${tipo(s)}` : uid(s));
  }
  return claves;
}

/**
 * Lo que tienen que compartir dos imágenes para compararse vóxel a vóxel.
 * La orientación se redondea: las series de una misma adquisición la repiten
 * exacta, y una sagital y una axial difieren en la unidad.
 */
export function claveGeometria(m: DicomMetadata): string {
  const orientacion = m.imageOrientationPatient
    ? m.imageOrientationPatient
        .flatMap(v => [v.x, v.y, v.z])
        .map(v => (Math.abs(v) < 5e-4 ? 0 : v).toFixed(3))
        .join(',')
    : 'sin-orientacion';
  const pixel = m.pixelSpacing.map(v => v.toFixed(3)).join('x');
  return `${m.frameOfReferenceUID}|${orientacion}|${m.rows}x${m.columns}|${pixel}`;
}

function firmaAdquisicion(m: DicomMetadata): string {
  const fijo = (v: number | undefined) => (v === undefined ? '' : v.toFixed(2));
  return `${fijo(m.repetitionTime)}|${fijo(m.echoTime)}`;
}

function leerSeries(slices: DicomSlice[]): SerieLeida[] {
  const claves = clavesDeSerie(slices);
  const porSerie = new Map<string, DicomSlice[]>();
  for (const slice of slices) {
    const clave = claves.get(slice)!;
    const lista = porSerie.get(clave);
    if (lista) lista.push(slice);
    else porSerie.set(clave, [slice]);
  }

  return [...porSerie.entries()].map(([uid, todos]) => {
    // Un localizador trae tres orientaciones en una serie. Para el cálculo solo
    // cuenta la geometría mayoritaria.
    const geometria = masFrecuente(todos.map(s => claveGeometria(s.metadata)));
    const cortes = todos.filter(s => claveGeometria(s.metadata) === geometria);
    const conValorB = cortes.filter(s => s.metadata.bValueSource !== 'ausente');
    const primera = cortes[0].metadata;

    return {
      uid,
      descripcion: primera.seriesDescription,
      numero: primera.seriesNumber ?? 0,
      cortes,
      conValorB,
      geometria,
      firma: firmaAdquisicion(primera),
      valoresB: new Set(conValorB.map(s => s.metadata.bValue)),
      posiciones: posicionesDistintas(cortes),
      horasAdquisicion: new Set(
        cortes.map(s => s.metadata.acquisitionTime).filter((t): t is string => Boolean(t))
      ),
      esAdcEquipo: primera.isVendorADC,
      // La DWI de GE no se declara DIFFUSION en ImageType, pero trae b > 0; una T2
      // de GE trae el tag de b de GE a cero, y no por eso es difusión.
      aportaDifusion: conValorB.some(
        s => s.metadata.bValue > 0 || s.metadata.imageType.includes('DIFFUSION')
      ),
      excluida: primera.isVendorADC ? undefined : motivoDerivada(primera.imageType, primera.seriesDescription),
    };
  });
}

/**
 * ¿Es una imagen que el equipo derivó de la difusión, y no una adquirida?
 *
 * Se mira ImageType y, como respaldo, los sufijos con que Siemens y GE nombran
 * esas series. La traza (TRACEW) y la b = 0 del tensor (TENSOR_B0) son las
 * imágenes adquiridas que el equipo usa para su propio ADC: esas sí valen.
 */
export function motivoDerivada(tipo: string[], descripcion: string): MotivoExclusion | undefined {
  const desc = descripcion.toUpperCase();
  if (tipo.some(c => c.startsWith('EADC')) || /(^|[^A-Z])EADC/.test(desc)) return 'eadc';
  if (tipo.some(c => c.startsWith('CALC_BVAL')) || desc.includes('CALC_BVAL')) return 'b-calculada';
  if (desc.includes('SYNTHETIC')) return 'sintetica';
  if (tipo.some(c => c === 'FA' || c === 'COLFA' || c === 'EXP' || c === 'TENSOR')) return 'mapa-derivado';
  // «_FA» o «_EXP» en el nombre de una serie adquirida pueden significar otra
  // cosa: por la descripción solo se aparta lo que el equipo declara derivado.
  const derivada = tipo.length === 0 || tipo.includes('DERIVED');
  if (derivada && /_(COLFA|FA|EXP)(_|$)|_TENSOR(?!_B0)(_|$)/.test(desc)) return 'mapa-derivado';
  return undefined;
}

/**
 * GE archiva, además de la DWI procesada, su copia sin procesar con el prefijo
 * «ORIG:». El ADC del equipo sale de la procesada; la copia solo se usa si es lo
 * único que hay.
 */
function marcarCopiasOrig(leidas: SerieLeida[]): void {
  const PREFIJO = /^\s*ORIG\s*:\s*/i;
  for (const serie of leidas) {
    if (serie.excluida || !PREFIJO.test(serie.descripcion)) continue;
    const original = serie.descripcion.replace(PREFIJO, '').trim().toLowerCase();
    const hayProcesada = leidas.some(
      otra =>
        otra !== serie &&
        !otra.excluida &&
        !PREFIJO.test(otra.descripcion) &&
        otra.descripcion.trim().toLowerCase() === original &&
        otra.geometria === serie.geometria
    );
    if (hayProcesada) serie.excluida = 'copia-orig';
  }
}

/**
 * Reúne las series que son los valores b repartidos de una misma adquisición
 * (Siemens guarda a veces b = 0 y b = 1000 en series separadas). Lo demás queda
 * como conjuntos distintos, que el usuario puede elegir en el desplegable.
 */
function reunirValoresBRepartidos(candidatas: SerieLeida[]): SerieLeida[][] {
  const ordenadas = [...candidatas].sort((a, b) => a.numero - b.numero || a.uid.localeCompare(b.uid));
  const conjuntos: SerieLeida[][] = [];

  for (const serie of ordenadas) {
    const destino = conjuntos.find(miembros =>
      miembros.every(
        m =>
          m.geometria === serie.geometria &&
          m.firma === serie.firma &&
          ![...m.valoresB].some(b => serie.valoresB.has(b))
      ) && compartenCortes(miembros.flatMap(m => m.posiciones), serie.posiciones)
    );
    if (destino) destino.push(serie);
    else conjuntos.push([serie]);
  }

  return conjuntos;
}

/** Al menos la mitad de los cortes de la serie más corta están en la otra. */
function compartenCortes(a: number[], b: number[]): boolean {
  const [corta, larga] = a.length <= b.length ? [a, b] : [b, a];
  if (corta.length === 0) return false;
  const comunes = corta.filter(p => larga.some(q => Math.abs(p - q) <= TOLERANCIA_POSICION_MM)).length;
  return comunes * 2 >= corta.length;
}

/**
 * De los mapas ADC del equipo con la misma geometría, el de la misma adquisición:
 * el que comparte hora de adquisición, después el de igual TR y TE, y después el
 * que cubre más cortes. Nunca más de uno: dos mapas intercalados por posición
 * desalineaban la validación.
 */
function elegirAdcEquipo(miembros: SerieLeida[], mapas: SerieLeida[]): SerieLeida | undefined {
  const { geometria, firma } = miembros[0];
  const posiciones = miembros.flatMap(m => m.posiciones);
  const horas = new Set(miembros.flatMap(m => [...m.horasAdquisicion]));

  let mejor: { mapa: SerieLeida; puntos: number[] } | undefined;
  for (const mapa of [...mapas].sort((a, b) => a.numero - b.numero || a.uid.localeCompare(b.uid))) {
    if (mapa.geometria !== geometria) continue;
    const cortesComunes = mapa.posiciones.filter(p =>
      posiciones.some(q => Math.abs(p - q) <= TOLERANCIA_POSICION_MM)
    ).length;
    if (cortesComunes === 0) continue;

    const puntos = [
      [...mapa.horasAdquisicion].some(h => horas.has(h)) ? 1 : 0,
      mapa.firma === firma ? 1 : 0,
      cortesComunes,
    ];
    if (!mejor || esMejor(puntos, mejor.puntos)) mejor = { mapa, puntos };
  }
  return mejor?.mapa;
}

function esMejor(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

function describirConjunto(miembros: SerieLeida[], adc: SerieLeida | undefined): SerieDetectada {
  const cortes = miembros.flatMap(m => m.conValorB);
  const valoresB = [...new Set(cortes.map(s => s.metadata.bValue))].sort((a, b) => a - b);
  const bPositiva = cortes.some(s => s.metadata.bValue > 0);
  const tipoDifusion = cortes.some(s => s.metadata.imageType.includes('DIFFUSION'));
  const primera = cortes[0].metadata;

  return {
    seriesUIDs: miembros.map(m => m.uid),
    descripcion: descripcionComun(miembros.map(m => m.descripcion)),
    imagenes: cortes.length,
    valoresB,
    columnas: primera.columns,
    filas: primera.rows,
    esDifusion: (valoresB.length > 1 && bPositiva) || (bPositiva && tipoDifusion),
    geometria: miembros[0].geometria,
    posiciones: posicionesDistintas(cortes).length,
    repeticiones: maximoPorPosicionYValorB(cortes),
    adcEquipo: adc && { seriesUID: adc.uid, descripcion: adc.descripcion, imagenes: adc.cortes.length },
  };
}

function describirSuelta(serie: SerieLeida): SerieDetectada {
  const primera = serie.cortes[0].metadata;
  return {
    seriesUIDs: [serie.uid],
    descripcion: serie.descripcion || 'Serie sin descripción',
    imagenes: serie.cortes.length,
    valoresB: [...serie.valoresB].sort((a, b) => a - b),
    columnas: primera.columns,
    filas: primera.rows,
    esDifusion: false,
    geometria: serie.geometria,
    posiciones: serie.posiciones.length,
    repeticiones: maximoPorPosicionYValorB(serie.cortes),
    excluida: serie.excluida ?? (serie.esAdcEquipo ? 'adc-equipo' : undefined),
  };
}

function descripcionComun(descripciones: string[]): string {
  const distintas = [...new Set(descripciones.filter(Boolean))];
  if (distintas.length === 0) return 'Serie sin descripción';
  if (distintas.length === 1) return distintas[0];
  return `${distintas[0]} (+${distintas.length - 1})`;
}

function masFrecuente(valores: string[]): string {
  const cuenta = new Map<string, number>();
  for (const v of valores) cuenta.set(v, (cuenta.get(v) ?? 0) + 1);
  return [...cuenta.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function posicionesDistintas(cortes: DicomSlice[]): number[] {
  return [...new Set(cortes.map(s => Number(s.metadata.canonicalPosition.toFixed(2))))].sort((a, b) => a - b);
}

function maximoPorPosicionYValorB(cortes: DicomSlice[]): number {
  const cuenta = new Map<string, number>();
  for (const s of cortes) {
    const clave = `${s.metadata.bValue}|${s.metadata.canonicalPosition.toFixed(2)}`;
    cuenta.set(clave, (cuenta.get(clave) ?? 0) + 1);
  }
  return Math.max(0, ...cuenta.values());
}

/**
 * Los cortes con los que se calcula un conjunto y los del ADC del equipo que le
 * corresponde. Los cortes sin valor b en ningún tag se quedan fuera: tomarlos
 * como b = 0 era lo que metía una T1 en el cálculo.
 */
export function cortesDelConjunto(
  slices: DicomSlice[],
  conjunto: SerieDetectada
): { difusion: DicomSlice[]; adcEquipo: DicomSlice[]; sinValorB: number } {
  const miembros = new Set(conjunto.seriesUIDs);
  const uidAdc = conjunto.adcEquipo?.seriesUID;
  const claves = clavesDeSerie(slices);
  const difusion: DicomSlice[] = [];
  const adcEquipo: DicomSlice[] = [];
  let sinValorB = 0;

  for (const slice of slices) {
    const uid = claves.get(slice)!;
    if (!miembros.has(uid) && uid !== uidAdc) continue;
    if (claveGeometria(slice.metadata) !== conjunto.geometria) continue;

    if (uid === uidAdc) adcEquipo.push(slice);
    else if (slice.metadata.bValueSource === 'ausente') sinValorB++;
    else difusion.push(slice);
  }

  return { difusion, adcEquipo, sinValorB };
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
 * Recibe solo los cortes de un conjunto, así que lo que promedia son las
 * repeticiones y direcciones de una misma serie, o de las series en que el
 * equipo repartió los valores b, que nunca coinciden en valor b.
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
      const bestMatch = candidates.find(c => Math.abs(c.metadata.canonicalPosition - pos) <= TOLERANCIA_POSICION_MM);

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
