import type { AveragedSlice, DicomSlice, MapResult } from './types';
import {
  cortesDelConjunto,
  groupAndAverageSlices,
  matchSlices,
  type MatchedSlice,
  type MotivoExclusion,
  type SerieDetectada,
} from './series-builder';
import { resolverUnidadAdc, type UnidadAdc } from './adc-equipo';
import { computeMultiBMaps, computeTwoPointMaps, estimateNoiseThreshold } from './maps';
import { registerSlice, type RegistrationMode } from './registration';
import { es } from '../../i18n/es';

export interface AdcEquipoPreparado {
  descripcion: string;
  /** Un corte por posición, ya en mm²/s y ordenados por posición. */
  cortes: AveragedSlice[];
  unidad: UnidadAdc;
}

export interface ConjuntoPreparado {
  diffusion: Map<string, AveragedSlice>;
  bValues: number[];
  bLow: number;
  bHigh: number;
  /** Ajuste multi-b por defecto: con tres o más valores b. */
  multiB: boolean;
  /** Cortes emparejados en el modo por defecto. */
  matched: MatchedSlice[];
  discardedCount: number;
  /** Errores del emparejamiento de cortes. */
  errors: string[];
  /** Avisos sobre el conjunto: valores b, serie elegida, series apartadas, unidades. */
  avisos: string[];
  threshold: number;
  adcEquipo?: AdcEquipoPreparado;
}

const NOMBRE_EXCLUSION: Record<MotivoExclusion, string> = {
  eadc: es.exclEadc,
  'b-calculada': es.exclBCalculada,
  sintetica: es.exclSintetica,
  'mapa-derivado': es.exclMapaDerivado,
  'copia-orig': es.exclCopiaOrig,
  'adc-equipo': es.exclAdcEquipo,
};

export function nombreExclusion(motivo: MotivoExclusion): string {
  return NOMBRE_EXCLUSION[motivo];
}

/**
 * Deja un conjunto de difusión listo para calcular, igual que al abrir el estudio
 * con los valores por defecto: agrupa, elige b baja, b alta y modo de ajuste,
 * empareja los cortes y prepara el ADC del equipo en mm²/s. La usan el worker y
 * las pruebas.
 */
export function prepararConjunto(
  todosLosCortes: DicomSlice[],
  series: SerieDetectada[],
  elegida: SerieDetectada
): ConjuntoPreparado {
  const { difusion, adcEquipo: cortesAdc, sinValorB } = cortesDelConjunto(todosLosCortes, elegida);
  const { diffusion } = groupAndAverageSlices(difusion);

  const bValues = Array.from(
    new Set(Array.from(diffusion.values()).map(g => g.metadata.bValue))
  ).sort((a, b) => a - b);
  if (bValues.length === 0) throw new Error(es.errSinDifusion);

  // Por defecto se calcula como el equipo y como las guías (PI-RADS v2.1, QIBA):
  // con los valores b del protocolo, cuya b baja ya está en 0–100 s/mm². Con dos
  // valores b, entre ambos; con tres o más, ajuste sobre todos. Hasta la versión
  // 1.2 la b baja era la primera >= 150 s/mm², que ninguna guía usa y que en los
  // protocolos de cuerpo daba hasta un 40 % de diferencia con el ADC del equipo.
  const bLow = bValues[0];
  const bHigh = bValues[bValues.length - 1];
  const multiB = bValues.length >= 3;

  const { matched, discardedCount, errors } = matchSlices(diffusion, multiB ? bValues : [bLow, bHigh]);

  // Avisos sobre la procedencia de los valores b: un ADC calculado sobre una b
  // deducida del nombre de la secuencia no merece la misma confianza que uno
  // calculado sobre el tag estándar.
  const bDeTexto = difusion.filter(
    s => s.metadata.bValueSource === 'nombre-secuencia' || s.metadata.bValueSource === 'descripcion'
  ).length;

  const avisos: string[] = [];
  if (sinValorB > 0) avisos.push(es.warnBInferred.replace('{n}', String(sinValorB)));
  if (bDeTexto > 0) avisos.push(es.warnBFromText.replace('{n}', String(bDeTexto)));
  if (series.length > 1) {
    avisos.push(
      es.avisoSerieElegida
        .replace('{serie}', elegida.descripcion)
        .replace('{total}', String(series.length))
    );
  }

  // Las derivadas con la misma geometría son las que antes se mezclaban con la
  // difusión: se dice cuáles se han dejado fuera.
  const apartadas = series.filter(
    s => s.excluida && s.excluida !== 'adc-equipo' && s.geometria === elegida.geometria
  );
  if (apartadas.length > 0) {
    avisos.push(
      es.avisoSeriesApartadas
        .replace('{n}', String(apartadas.length))
        .replace('{lista}', apartadas.map(s => `«${s.descripcion}» (${nombreExclusion(s.excluida!)})`).join(', '))
    );
  }

  let threshold = 0;
  if (matched.length > 0) {
    const refSlice = matched[Math.floor(matched.length / 2)].slicesByBValue.get(bLow);
    if (refSlice) threshold = estimateNoiseThreshold(refSlice).threshold;
  }

  let adcEquipo: AdcEquipoPreparado | undefined;
  if (elegida.adcEquipo && cortesAdc.length > 0) {
    const { vendorAdc } = groupAndAverageSlices(cortesAdc);
    const cortes = [...vendorAdc.values()].sort(
      (a, b) => a.metadata.canonicalPosition - b.metadata.canonicalPosition
    );
    // El equipo guarda el ADC en 10⁻⁶ mm²/s y la aplicación calcula en mm²/s:
    // sin convertirlo, la pestaña de validación comparaba 800 con 0,0008.
    const unidad = resolverUnidadAdc(cortes);
    for (const corte of cortes) {
      for (let i = 0; i < corte.pixelData.length; i++) corte.pixelData[i] *= unidad.factor;
    }
    if (unidad.declaradaDescartada) {
      avisos.push(
        es.avisoUnidadAdc
          .replace('{declarada}', unidad.declaradaDescartada)
          .replaceAll('{usada}', unidad.etiqueta)
      );
    }
    adcEquipo = { descripcion: elegida.adcEquipo.descripcion, cortes, unidad };
  }

  return { diffusion, bValues, bLow, bHigh, multiB, matched, discardedCount, errors, avisos, threshold, adcEquipo };
}

export interface ParametrosCalculo {
  bLow: number;
  bHigh: number;
  bTarget: number;
  threshold: number;
  useMultiB: boolean;
  registrationMode: RegistrationMode;
}

export interface Transformacion {
  dx: number;
  dy: number;
  angle: number;
  fallbackMode?: 'translation' | 'none';
}

export interface CorteCalculado {
  sliceIndex: number;
  maps: MapResult;
  /** Imagen de cada valor b usada en el cálculo, ya corregistrada con la b baja. */
  registeredSlices: Record<number, Float32Array>;
  transforms: Record<number, Transformacion>;
}

/**
 * Calcula los mapas de todos los cortes: empareja según el modo, corregistra
 * cada valor b con la b baja y ajusta. La usan el worker y las pruebas, para que
 * estas calculen exactamente como la aplicación.
 */
export function calcularMapas(
  diffusion: Map<string, AveragedSlice>,
  bValues: number[],
  p: ParametrosCalculo,
  alAvanzar?: (hechos: number, total: number) => void
): { matched: MatchedSlice[]; resultados: CorteCalculado[]; discardedCount: number; errors: string[] } {
  // El ajuste de dos puntos solo necesita los dos valores b elegidos; el multi-b
  // los necesita todos en cada corte.
  const bUsadas = p.useMultiB ? bValues : [p.bLow, p.bHigh];
  const { matched, discardedCount, errors } = matchSlices(diffusion, bUsadas);

  const resultados = matched.map((match, i): CorteCalculado => {
    const referencia = match.slicesByBValue.get(p.bLow)!;
    const registeredSlices: Record<number, Float32Array> = { [p.bLow]: referencia.pixelData };
    const transforms: Record<number, Transformacion> = {};

    const cortes = bUsadas.map(b => {
      if (b === p.bLow) return referencia;
      const r = registerSlice(referencia, match.slicesByBValue.get(b)!, p.registrationMode);
      transforms[b] = { dx: r.dx, dy: r.dy, angle: r.angle, fallbackMode: r.fallbackMode };
      registeredSlices[b] = r.registeredSlice.pixelData;
      return r.registeredSlice;
    });

    const maps = p.useMultiB
      ? computeMultiBMaps(cortes, bUsadas, p.bTarget, p.threshold)
      : computeTwoPointMaps(cortes[0], cortes[1], p.bLow, p.bHigh, p.bTarget, p.threshold);

    alAvanzar?.(i, matched.length);
    return { sliceIndex: i, maps, registeredSlices, transforms };
  });

  return { matched, resultados, discardedCount, errors };
}
