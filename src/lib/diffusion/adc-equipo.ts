import type { AveragedSlice, DicomMetadata } from './types';
import type { MatchedSlice } from './series-builder';

/** Distancia máxima entre dos cortes para darlos por la misma posición, en mm. */
export const TOLERANCIA_POSICION_MM = 0.5;

export interface UnidadAdc {
  /** Factor que lleva el valor de píxel, ya reescalado, a mm²/s. */
  factor: number;
  /** Unidad en la que venía el mapa, para avisos y para el registro. */
  etiqueta: string;
  /** De dónde se sacó: la declaración del DICOM o, sin ella, la magnitud de los valores. */
  origen: 'rescale-type' | 'descripcion' | 'magnitud';
  /** Unidad declarada que no cuadraba con los valores y se descartó. */
  declaradaDescartada?: string;
}

const UNIDADES: Record<string, { factor: number; etiqueta: string }> = {
  micro: { factor: 1e-6, etiqueta: '10⁻⁶ mm²/s' },
  mili: { factor: 1e-3, etiqueta: '10⁻³ mm²/s' },
  base: { factor: 1, etiqueta: 'mm²/s' },
};

/**
 * Unidad declarada en el propio DICOM.
 *
 * RescaleType (0028,1054) es la declaración estándar: «10-6 mm2/s» en los mapas
 * que la declaran, incluidos los que exporta esta aplicación. GE deja «US» (sin
 * especificar) y escribe la unidad en la descripción de serie, «ADC (10^-6 mm²/s)».
 * Siemens no la declara en ninguno de los dos sitios.
 */
export function unidadDeclarada(
  metadata: Pick<DicomMetadata, 'rescaleType' | 'seriesDescription'>
): UnidadAdc | undefined {
  const tipo = normalizarUnidad(metadata.rescaleType ?? '');
  if (/^(10-6|1e-6)mm2\/s$|^um2\/s$/.test(tipo)) return { ...UNIDADES.micro, origen: 'rescale-type' };
  if (/^(10-3|1e-3)mm2\/s$/.test(tipo)) return { ...UNIDADES.mili, origen: 'rescale-type' };
  if (tipo === 'mm2/s') return { ...UNIDADES.base, origen: 'rescale-type' };

  const descripcion = normalizarUnidad(metadata.seriesDescription);
  if (/10-6mm2/.test(descripcion)) return { ...UNIDADES.micro, origen: 'descripcion' };
  if (/10-3mm2/.test(descripcion)) return { ...UNIDADES.mili, origen: 'descripcion' };

  return undefined;
}

/** «10^-6 mm²/s», «10 -6 mm2/s», «10⁻⁶ mm²/s» y «µm²/s» quedan en la misma forma. */
function normalizarUnidad(texto: string): string {
  return texto
    .toLowerCase()
    .replace(/[⁻−–]/g, '-')
    .replace(/⁶/g, '6')
    .replace(/³/g, '3')
    .replace(/²/g, '2')
    .replace(/[µμ]/g, 'u')
    .replace(/[\s^]/g, '');
}

/**
 * Unidad deducida de los valores.
 *
 * El ADC de tejido y de líquido va de 1·10⁻⁴ a 4·10⁻³ mm²/s: escrito en 10⁻⁶ son
 * cientos o miles, en 10⁻³ ronda la unidad y en mm²/s son milésimas. Los tres
 * rangos quedan separados por un factor mil, así que el percentil 90 de los
 * valores positivos basta para distinguirlos aunque el fondo tenga ruido.
 */
export function unidadPorMagnitud(cortes: { pixelData: Float32Array }[]): UnidadAdc {
  const muestra: number[] = [];
  const total = cortes.reduce((suma, c) => suma + c.pixelData.length, 0);
  const paso = Math.max(1, Math.floor(total / 200_000));
  let indice = 0;
  for (const corte of cortes) {
    for (let i = 0; i < corte.pixelData.length; i++, indice++) {
      if (indice % paso === 0 && corte.pixelData[i] > 0) muestra.push(corte.pixelData[i]);
    }
  }
  if (muestra.length === 0) return { ...UNIDADES.micro, origen: 'magnitud' };

  muestra.sort((a, b) => a - b);
  const p90 = muestra[Math.floor(muestra.length * 0.9)];
  if (p90 > 50) return { ...UNIDADES.micro, origen: 'magnitud' };
  if (p90 > 0.05) return { ...UNIDADES.mili, origen: 'magnitud' };
  return { ...UNIDADES.base, origen: 'magnitud' };
}

/**
 * Unidad de un mapa ADC del equipo: la declarada, salvo que los valores la
 * desmientan. Un error aquí multiplica el ADC del equipo por mil en la pestaña
 * de validación, que es justo lo que pasaba cuando no se convertía.
 */
export function resolverUnidadAdc(cortes: { metadata: DicomMetadata; pixelData: Float32Array }[]): UnidadAdc {
  const porMagnitud = unidadPorMagnitud(cortes);
  const declarada = cortes.length > 0 ? unidadDeclarada(cortes[0].metadata) : undefined;
  if (!declarada) return porMagnitud;
  if (declarada.factor === porMagnitud.factor) return declarada;
  return { ...porMagnitud, declaradaDescartada: declarada.etiqueta };
}

/**
 * Asigna a cada corte calculado el corte del ADC del equipo que está en su misma
 * posición.
 *
 * Emparejar por índice solo funciona si las dos series tienen exactamente los
 * mismos cortes en el mismo orden. En cuanto el mapa del equipo trae menos
 * cortes, o el estudio trae dos mapas, cada ROI se comparaba con otra altura del
 * paciente sin ningún aviso.
 */
export function emparejarAdcEquipo(
  matched: MatchedSlice[],
  adc: AveragedSlice[],
  tolerancia: number = TOLERANCIA_POSICION_MM
): { porCorte: (AveragedSlice | undefined)[]; sinPareja: number } {
  const porCorte = matched.map(({ position }) => {
    let mejor: AveragedSlice | undefined;
    let distanciaMejor = Infinity;
    for (const corte of adc) {
      const distancia = Math.abs(corte.metadata.canonicalPosition - position);
      if (distancia <= tolerancia && distancia < distanciaMejor) {
        mejor = corte;
        distanciaMejor = distancia;
      }
    }
    return mejor;
  });
  return { porCorte, sinPareja: porCorte.filter(c => !c).length };
}
