import { describe, it, expect } from 'vitest';
import { parseDicom } from '../dicom-reader';
import {
  inventariarSeries,
  motivoDerivada,
  serieInicial,
  type MatchedSlice,
  type SerieDetectada,
} from '../series-builder';
import { calcularMapas, prepararConjunto } from '../estudio';
import {
  emparejarAdcEquipo,
  resolverUnidadAdc,
  unidadDeclarada,
  unidadPorMagnitud,
} from '../adc-equipo';
import { computeLinCCC, computeRoiStats } from '../stats';
import type { AveragedSlice, DicomSlice, MapResult } from '../types';
import {
  AXIAL,
  CORONAL,
  SAGITAL,
  dicomSintetico,
  enTejido,
  imagen,
  posicionEn,
  type CorteSintetico,
} from './dicom-sintetico';

/**
 * Regresión de los defectos hallados al pasar el motor de la aplicación por 100
 * estudios reales de Horos (2026-09-28): con el estudio completo y los valores
 * por defecto, 74 de 94 daban un ADC no comparable con el del equipo.
 *
 * Cada caso reproduce con DICOM sintéticos la forma en que GE y Siemens guardan
 * las series implicadas, y comprueba lo que hace la aplicación al abrir el
 * estudio entero: qué series reúne, con qué valores b calcula y contra qué corte
 * del ADC del equipo valida.
 */

const FILAS = 64;
const COLUMNAS = 64;
const S0 = 20000;
const MARCO = '1.2.826.0.1.3680043.10.1338.5';
const ALTURAS = [0, 5, 10, 15, 20, 25];

/** ADC verdadero del tejido a cada altura: distinto por corte, para detectar cruces. */
const adcA = (z: number) => 0.0005 + 0.00005 * z;

const senal = (b: number, adc: number) => S0 * Math.exp(-b * adc);

function leer(c: CorteSintetico): DicomSlice {
  return parseDicom(dicomSintetico(c));
}

interface Serie {
  uid: string;
  descripcion: string;
  numero: number;
  tipo?: string[];
  fabricante?: string;
  hora?: string;
  tr?: number;
  te?: number;
  orientacion?: number[];
  alturas?: number[];
  espaciado?: [number, number];
}

type EtiquetaB = Pick<CorteSintetico, 'bEstandar' | 'bSiemens' | 'bGE' | 'nombreSecuencia'>;

/** Una imagen por altura con la señal dada; la geometría por defecto es la axial común. */
function serie(
  s: Serie,
  pixeles: (z: number) => Uint16Array,
  extra: (z: number) => Partial<CorteSintetico> = () => ({})
): DicomSlice[] {
  const orientacion = s.orientacion ?? AXIAL;
  return (s.alturas ?? ALTURAS).map((z, i) =>
    leer({
      serieUID: s.uid,
      descripcion: s.descripcion,
      numeroSerie: s.numero,
      instancia: i + 1,
      tipoImagen: s.tipo,
      fabricante: s.fabricante,
      horaAdquisicion: s.hora,
      tr: s.tr,
      te: s.te,
      marcoReferencia: MARCO,
      orientacion,
      posicion: posicionEn(orientacion, z),
      filas: FILAS,
      columnas: COLUMNAS,
      espaciado: s.espaciado,
      pixeles: pixeles(z),
      ...extra(z),
    })
  );
}

/** Serie de difusión con varios valores b, cada uno con sus etiquetas de valor b. */
function difusion(
  s: Serie,
  valores: number[],
  etiquetas: (b: number) => EtiquetaB,
  adc: (z: number) => number = adcA
): DicomSlice[] {
  return valores.flatMap(b =>
    serie(s, z => imagen(FILAS, COLUMNAS, () => senal(b, adc(z))), () => etiquetas(b))
  );
}

const etiquetasGE = (b: number): EtiquetaB => ({
  bEstandar: b > 0 ? b : undefined, // GE no escribe (0018,9087) en la b = 0
  bGE: `${b}\\8\\0\\0`,
});
const etiquetasSiemens = (b: number): EtiquetaB => ({
  bSiemens: b,
  nombreSecuencia: b > 0 ? `*ep_b${b}t` : '*ep_b0',
});

/** Mapa ADC del equipo tal como lo guarda GE: 10⁻⁶ mm²/s, intercepto −1, sin RescaleType útil. */
function adcGE(s: Serie, adc: (z: number) => number = adcA): DicomSlice[] {
  return serie(
    { tipo: ['DERIVED', 'PRIMARY', 'DIFFUSION', 'ADC'], fabricante: 'GE MEDICAL SYSTEMS', ...s },
    z => imagen(FILAS, COLUMNAS, () => Math.round(adc(z) * 1e6) + 1),
    () => ({ tipoReescalado: 'US', pendiente: 1, intercepto: -1, bEstandar: 1000, bGE: '1000\\8\\0\\0' })
  );
}

/** Mapa ADC del equipo tal como lo guarda Siemens: 10⁻⁶ mm²/s sin declararlo. */
function adcSiemens(s: Serie, adc: (z: number) => number = adcA): DicomSlice[] {
  return serie(
    { tipo: ['DERIVED', 'PRIMARY', 'DIFFUSION', 'ADC', 'NORM', 'DIS2D'], ...s },
    z => imagen(FILAS, COLUMNAS, () => Math.round(adc(z) * 1e6)),
    () => ({ nombreSecuencia: '*ep_b0_1000' })
  );
}

function tejido(): Uint8Array {
  const mascara = new Uint8Array(FILAS * COLUMNAS);
  for (let i = 0; i < mascara.length; i++) mascara[i] = enTejido(i, FILAS, COLUMNAS) ? 1 : 0;
  return mascara;
}

function mediaEnTejido(pixeles: Float32Array): number {
  let suma = 0;
  let n = 0;
  for (let i = 0; i < pixeles.length; i++) {
    if (enTejido(i, FILAS, COLUMNAS)) {
      suma += pixeles[i];
      n++;
    }
  }
  return suma / n;
}

/**
 * Lo que hace la aplicación al abrir el estudio completo con los valores por
 * defecto: inventario, conjunto inicial, b baja, b alta y modo de ajuste por
 * defecto, y el mismo cálculo que el worker (sin corregistro, que aquí no hay
 * movimiento que corregir).
 */
function abrirComoLaApp(cortes: DicomSlice[]) {
  const series = inventariarSeries(cortes);
  const elegida = serieInicial(series);
  if (!elegida) throw new Error('sin serie de difusión');
  const preparado = prepararConjunto(cortes, series, elegida);
  const { matched, resultados } = calcularMapas(preparado.diffusion, preparado.bValues, {
    bLow: preparado.bLow,
    bHigh: preparado.bHigh,
    bTarget: 2000,
    threshold: preparado.threshold,
    useMultiB: preparado.multiB,
    registrationMode: 'none',
  });
  const mapas = resultados.map(r => r.maps);
  const adcEquipo = emparejarAdcEquipo(matched, preparado.adcEquipo?.cortes ?? []);
  return { series, elegida, preparado, matched, mapas, adcEquipo };
}

/** Pares de la pestaña Validación: una ROI de tejido por corte con ADC del equipo. */
function paresDeValidacion(
  matched: MatchedSlice[],
  mapas: MapResult[],
  porCorte: (AveragedSlice | undefined)[]
) {
  const roi = tejido();
  return matched.flatMap((_, i) => {
    const delEquipo = porCorte[i];
    if (!delEquipo) return [];
    const calc = computeRoiStats({ pixels: mapas[i].adc, validityMask: mapas[i].mask, roiMask: roi });
    const vend = computeRoiStats({ pixels: delEquipo.pixelData, validityMask: mapas[i].mask, roiMask: roi });
    return [{ calcMean: calc.mean, vendMean: vend.mean }];
  });
}

function porUid(series: SerieDetectada[], uid: string): SerieDetectada | undefined {
  return series.find(s => s.seriesUIDs.includes(uid));
}

describe('GE: eADC y copia ORIG junto a la DWI', () => {
  const ge = { fabricante: 'GE MEDICAL SYSTEMS', hora: '091236', tr: 4567, te: 94.2 };
  const cortes = [
    ...difusion({ ...ge, uid: 'dwi', descripcion: 'Ax DWI ALL b1000', numero: 4 }, [1000, 0], etiquetasGE),
    // La copia sin procesar no es la misma imagen escalada: su b alta cae distinto.
    ...difusion({ ...ge, uid: 'orig', descripcion: 'ORIG: Ax DWI ALL b1000', numero: 410 }, [1000, 0], etiquetasGE, z => adcA(z) * 1.25),
    // eADC = exp(−b·ADC) guardado con pendiente 1/4095: valores entre 0 y 1.
    ...serie(
      { ...ge, uid: 'eadc', descripcion: 'eADC', numero: 451, tipo: ['DERIVED', 'PRIMARY', 'DIFFUSION', 'EADC'] },
      z => imagen(FILAS, COLUMNAS, () => Math.exp(-1000 * adcA(z)) * 4095 + 1),
      () => ({ bEstandar: 1000, bGE: '1000\\8\\0\\0', pendiente: 0.0002442, intercepto: -0.0002442, tipoReescalado: 'US' })
    ),
    ...adcGE({ ...ge, uid: 'adc', descripcion: 'ADC (10^-6 mm²/s)', numero: 450 }),
    // Una T2 de GE trae el tag de b de GE a cero en la misma geometría.
    ...serie(
      { fabricante: 'GE MEDICAL SYSTEMS', uid: 't2', descripcion: 'Ax T2 FSE', numero: 6, tr: 6859, te: 120.7 },
      () => imagen(FILAS, COLUMNAS, () => 9000),
      () => ({ bGE: '0\\2097184\\0\\0' })
    ),
  ];

  const { series, elegida, preparado, mapas, adcEquipo, matched } = abrirComoLaApp(cortes);

  it('calcula solo con la DWI procesada', () => {
    expect(elegida.seriesUIDs).toEqual(['dwi']);
    expect(elegida.descripcion).toBe('Ax DWI ALL b1000');
    expect(preparado.bValues).toEqual([0, 1000]);
    for (const grupo of preparado.diffusion.values()) expect(grupo.count).toBe(1);
  });

  it('lista el eADC y la copia ORIG como series que no se usan', () => {
    expect(porUid(series, 'eadc')).toMatchObject({ esDifusion: false, excluida: 'eadc' });
    expect(porUid(series, 'orig')).toMatchObject({ esDifusion: false, excluida: 'copia-orig' });
    expect(porUid(series, 't2')).toMatchObject({ esDifusion: false, excluida: undefined });
    expect(preparado.avisos.some(a => a.includes('«eADC»') && a.includes('«ORIG: Ax DWI ALL b1000»'))).toBe(true);
  });

  it('reproduce el ADC verdadero en cada corte', () => {
    matched.forEach((m, i) => {
      expect(mediaEnTejido(mapas[i].adc)).toBeCloseTo(adcA(m.position), 6);
    });
  });

  it('asocia el ADC del equipo, lo lee en mm²/s y lo empareja por posición', () => {
    expect(elegida.adcEquipo?.seriesUID).toBe('adc');
    expect(preparado.adcEquipo?.unidad).toMatchObject({ factor: 1e-6, origen: 'descripcion' });
    expect(adcEquipo.sinPareja).toBe(0);
    matched.forEach((m, i) => {
      expect(mediaEnTejido(adcEquipo.porCorte[i]!.pixelData)).toBeCloseTo(adcA(m.position), 9);
    });
  });

  it('da en la pestaña Validación un sesgo nulo y concordancia perfecta', () => {
    const pares = paresDeValidacion(matched, mapas, adcEquipo.porCorte);
    expect(pares).toHaveLength(ALTURAS.length);
    const { ccc, bias } = computeLinCCC(pares.map(p => p.vendMean), pares.map(p => p.calcMean));
    expect(ccc).toBeGreaterThan(0.999);
    expect(Math.abs(bias)).toBeLessThan(1e-6);
    for (const p of pares) expect(Math.abs(p.calcMean - p.vendMean) / p.vendMean).toBeLessThan(0.001);
  });

  it('usa la copia ORIG si es lo único que hay', () => {
    const soloOrig = cortes.filter(c => c.metadata.seriesInstanceUID !== 'dwi');
    const { elegida: usada } = abrirComoLaApp(soloOrig);
    expect(usada.seriesUIDs).toEqual(['orig']);
  });
});

describe('GE: DWI sintética', () => {
  const ge = { fabricante: 'GE MEDICAL SYSTEMS', hora: '153532', tr: 5573, te: 83.7 };
  const cortes = [
    ...difusion({ ...ge, uid: 'dwi', descripcion: 'MF Ax DWI b800', numero: 9 }, [800, 0], etiquetasGE),
    // GE la guarda a b = 1000 con ImageType de difusión: solo la delata la descripción.
    ...serie(
      { ...ge, uid: 'sint', descripcion: 'DW_Synthetic: MF Ax DWI b800', numero: 900, tipo: ['DERIVED', 'PRIMARY', 'DIFFUSION', 'DIFFUSION'] },
      z => imagen(FILAS, COLUMNAS, () => senal(1000, adcA(z) * 0.8)),
      () => etiquetasGE(1000)
    ),
    ...adcGE({ ...ge, uid: 'adc', descripcion: 'ADC (10^-6 mm²/s)', numero: 950 }),
  ];

  it('no toma la b sintética como adquirida', () => {
    const { series, elegida, preparado, mapas, matched } = abrirComoLaApp(cortes);
    expect(elegida.seriesUIDs).toEqual(['dwi']);
    expect(preparado.bValues).toEqual([0, 800]);
    expect(preparado.bHigh).toBe(800);
    expect(porUid(series, 'sint')?.excluida).toBe('sintetica');
    matched.forEach((m, i) => {
      expect(mediaEnTejido(mapas[i].adc)).toBeCloseTo(adcA(m.position), 6);
    });
  });
});

describe('Siemens: b calculadas (CALC_BVAL)', () => {
  const xa = { fabricante: 'Siemens Healthineers', tr: 4200, te: 72.24 };
  const traza = ['DERIVED', 'PRIMARY', 'DIFFUSION', 'TRACEW', 'NORM', 'DIS2D', 'MFSPLIT'];
  const calc = ['DERIVED', 'PRIMARY', 'DIFFUSION', 'CALC_BVALUE', 'TRACEW', 'NORM', 'DIS2D', 'MFSPLIT'];

  it('reúne la b = 0 y la b = 1000 guardadas en series separadas y aparta la b calculada', () => {
    // Siemens XA: cada valor b de la traza en su propia serie, y la b = 1500
    // sintetizada a partir de su ADC (aquí, con un ADC que no es el verdadero).
    const cortes = [
      ...difusion({ ...xa, uid: 'b0', descripcion: 'resolve_TRACEW', numero: 9001, tipo: traza, hora: '103636' }, [0], etiquetasSiemens),
      ...difusion({ ...xa, uid: 'b1000', descripcion: 'resolve_TRACEW', numero: 9002, tipo: traza, hora: '103743' }, [1000], etiquetasSiemens),
      ...difusion({ ...xa, uid: 'calc', descripcion: 'resolve_CALC_BVAL', numero: 11001, tipo: calc, hora: '103743' }, [1500], etiquetasSiemens, z => adcA(z) * 1.2),
      ...adcSiemens({ ...xa, uid: 'adc', descripcion: 'resolve_ADC', numero: 10001, hora: '103743' }),
    ];
    const { series, elegida, preparado, mapas, adcEquipo, matched } = abrirComoLaApp(cortes);

    expect(elegida.seriesUIDs).toEqual(['b0', 'b1000']);
    expect(preparado.bValues).toEqual([0, 1000]);
    expect(preparado.bHigh).toBe(1000);
    expect(porUid(series, 'calc')?.excluida).toBe('b-calculada');
    matched.forEach((m, i) => {
      expect(mediaEnTejido(mapas[i].adc)).toBeCloseTo(adcA(m.position), 6);
      expect(mediaEnTejido(adcEquipo.porCorte[i]!.pixelData)).toBeCloseTo(adcA(m.position), 9);
    });
    // Siemens no declara la unidad: se deduce de los valores.
    expect(preparado.adcEquipo?.unidad).toMatchObject({ factor: 1e-6, origen: 'magnitud' });
  });

  it('no promedia la b = 1400 adquirida con la b = 1400 calculada', () => {
    const cuerpo = { ...xa, tipo: ['DERIVED', 'PRIMARY', 'DIFFUSION', 'TRACEW', 'NORM', 'DIS2D', 'DFC'], hora: '120000' };
    const cortes = [
      ...difusion({ ...cuerpo, uid: 'traza', descripcion: 'ep2d_diff_b50_800_1400_TRACEW_DFC_MIX', numero: 5 }, [50, 800, 1400], etiquetasSiemens),
      ...difusion({ ...cuerpo, uid: 'calc', descripcion: 'ep2d_diff_b50_800_1400_CALC_BVAL_DFC_MIX', numero: 7, tipo: calc }, [1400], etiquetasSiemens, z => adcA(z) * 1.2),
    ];
    const { preparado } = abrirComoLaApp(cortes);

    expect(preparado.bValues).toEqual([50, 800, 1400]);
    for (const [clave, grupo] of preparado.diffusion) {
      expect(grupo.count, clave).toBe(1);
      if (grupo.metadata.bValue === 1400) {
        const z = grupo.metadata.canonicalPosition;
        expect(grupo.pixelData[(FILAS / 2) * COLUMNAS + COLUMNAS / 2]).toBe(Math.round(senal(1400, adcA(z))));
      }
    }
  });

  it('en un tensor, calcula con la traza y su b = 0, no con las direcciones ni con la FA', () => {
    const dti = { ...xa, hora: '101500', tr: 4500, te: 98 };
    const direcciones = [1, 2, 3].flatMap(d =>
      difusion({ ...dti, uid: 'crudas', descripcion: 'ep2d_diff_mddw_12_p2', numero: 10, tipo: ['ORIGINAL', 'PRIMARY', 'DIFFUSION', 'NONE'] }, [1000], etiquetasSiemens, z => adcA(z) * (0.7 + 0.2 * d))
    );
    const cortes = [
      ...difusion({ ...dti, uid: 'crudas', descripcion: 'ep2d_diff_mddw_12_p2', numero: 10, tipo: ['ORIGINAL', 'PRIMARY', 'DIFFUSION', 'NONE'] }, [0], etiquetasSiemens),
      ...direcciones,
      ...difusion({ ...dti, uid: 'traza', descripcion: 'ep2d_diff_mddw_12_p2_TRACEW', numero: 12, tipo: ['DERIVED', 'PRIMARY', 'DIFFUSION', 'TRACEW', 'ND'] }, [1000], etiquetasSiemens),
      ...difusion({ ...dti, uid: 'b0tensor', descripcion: 'ep2d_diff_mddw_12_p2_TENSOR_B0', numero: 16, tipo: ['DERIVED', 'PRIMARY', 'DIFFUSION', 'TENSOR_B0', 'ND'] }, [0], etiquetasSiemens),
      ...serie(
        { ...dti, uid: 'fa', descripcion: 'ep2d_diff_mddw_12_p2_FA', numero: 13, tipo: ['DERIVED', 'PRIMARY', 'DIFFUSION', 'FA', 'ND'] },
        () => imagen(FILAS, COLUMNAS, () => 400),
        () => ({ nombreSecuencia: '*ep_b0_1000' })
      ),
      ...adcSiemens({ ...dti, uid: 'adc', descripcion: 'ep2d_diff_mddw_12_p2_ADC', numero: 11 }),
    ];
    const { series, elegida, mapas, matched } = abrirComoLaApp(cortes);

    expect(elegida.seriesUIDs.sort()).toEqual(['b0tensor', 'traza']);
    expect(elegida.repeticiones).toBe(1);
    expect(porUid(series, 'crudas')).toMatchObject({ esDifusion: true, repeticiones: 3 });
    expect(porUid(series, 'fa')?.excluida).toBe('mapa-derivado');
    matched.forEach((m, i) => {
      expect(mediaEnTejido(mapas[i].adc)).toBeCloseTo(adcA(m.position), 6);
    });
  });
});

describe('Siemens Avanto: T1 y T2 con el mismo marco y la misma matriz que la DWI', () => {
  const vb = { fabricante: 'SIEMENS' };
  const cortes = [
    ...serie(
      { ...vb, uid: 't1sag', descripcion: 't1_se_sag_p2_cer', numero: 2, orientacion: SAGITAL, tipo: ['ORIGINAL', 'PRIMARY', 'M', 'ND'], tr: 450, te: 5.9 },
      () => imagen(FILAS, COLUMNAS, () => 5000),
      () => ({ nombreSecuencia: '*se2d1' })
    ),
    ...difusion(
      { ...vb, uid: 'dwi', descripcion: 'diff_tra_ep2d_p2_b1000', numero: 5, tipo: ['ORIGINAL', 'PRIMARY', 'DIFFUSION', 'NONE', 'ND', 'NORM'], hora: '082143', tr: 3500, te: 94 },
      [0, 1000],
      etiquetasSiemens
    ),
    ...serie(
      { ...vb, uid: 't2tra', descripcion: 't2_tse_tra_p2_trig', numero: 25, tipo: ['ORIGINAL', 'PRIMARY', 'M', 'NORM'], tr: 5647, te: 93 },
      () => imagen(FILAS, COLUMNAS, () => 8000),
      () => ({ nombreSecuencia: '*tseR2d1rr30' })
    ),
    // El ADC del Avanto trae el tag de b de Siemens; lo identifica ImageType.
    ...adcSiemens({ ...vb, uid: 'adc', descripcion: 'ADC_S5_1', numero: 100, hora: '082143', tr: 3500, te: 94, tipo: ['DERIVED', 'PRIMARY', 'DIFFUSION', 'NONE', 'ND', 'NORM', 'ADC'] }),
  ];

  const { series, elegida, preparado, mapas, matched } = abrirComoLaApp(cortes);

  it('no mete como b = 0 series sin valor b ni de otra orientación', () => {
    expect(elegida.seriesUIDs).toEqual(['dwi']);
    expect(elegida.descripcion).toBe('diff_tra_ep2d_p2_b1000');
    for (const grupo of preparado.diffusion.values()) {
      expect(grupo.count).toBe(1);
      expect(grupo.metadata.seriesInstanceUID).toBe('dwi');
    }
    expect(porUid(series, 't1sag')?.esDifusion).toBe(false);
    expect(porUid(series, 't2tra')?.esDifusion).toBe(false);
  });

  it('calcula el ADC verdadero y valida contra el ADC_S5_1', () => {
    expect(elegida.adcEquipo?.seriesUID).toBe('adc');
    matched.forEach((m, i) => {
      expect(mediaEnTejido(mapas[i].adc)).toBeCloseTo(adcA(m.position), 6);
    });
  });

  it('descarta y avisa de las imágenes de la DWI que no traen valor b', () => {
    const sinB = cortes.map(c =>
      c.metadata.seriesInstanceUID === 'dwi' && c.metadata.canonicalPosition === 25 && c.metadata.bValue === 0
        ? { ...c, metadata: { ...c.metadata, bValue: 0, bValueSource: 'ausente' as const, bValueInferred: true } }
        : c
    );
    const { preparado: conHuecos } = abrirComoLaApp(sinB);
    expect(conHuecos.avisos.some(a => a.startsWith('1 imágenes de la serie no traen el valor b'))).toBe(true);
    expect(conHuecos.matched.map(m => m.position)).not.toContain(25);
  });
});

describe('ADC del equipo emparejado por posición', () => {
  const amira = { fabricante: 'SIEMENS', hora: '114500', tr: 5400, te: 70 };
  const traza = ['DERIVED', 'PRIMARY', 'DIFFUSION', 'TRACEW', 'NORM', 'DIS2D', 'DFC'];

  it('cuando el mapa del equipo tiene menos cortes que la DWI', () => {
    const cortes = [
      ...difusion({ ...amira, uid: 'traza', descripcion: 'ep2d_diff_b50_400_800_tra_p2_TRACEW_DFC_MIX', numero: 3, tipo: traza }, [50, 400, 800], etiquetasSiemens),
      // Solo las cuatro alturas superiores, y en orden inverso.
      ...adcSiemens({ ...amira, uid: 'adc', descripcion: 'ep2d_diff_b50_400_800_tra_p2_ADC_DFC_MIX', numero: 4, alturas: [25, 20, 15, 10] }),
    ];
    const { adcEquipo, matched } = abrirComoLaApp(cortes);

    expect(matched.map(m => m.position)).toEqual(ALTURAS);
    expect(adcEquipo.sinPareja).toBe(2);
    matched.forEach((m, i) => {
      const delEquipo = adcEquipo.porCorte[i];
      if (m.position < 10) {
        expect(delEquipo).toBeUndefined();
      } else {
        expect(delEquipo!.metadata.canonicalPosition).toBe(m.position);
        expect(mediaEnTejido(delEquipo!.pixelData)).toBeCloseTo(adcA(m.position), 9);
      }
    });
  });

  it('cuando el estudio trae el mapa dos veces', () => {
    const cortes = [
      ...difusion({ ...amira, uid: 'traza', descripcion: 'ep2d_TRACEW', numero: 3, tipo: traza }, [0, 1000], etiquetasSiemens),
      ...adcSiemens({ ...amira, uid: 'adc-1', descripcion: 'ep2d_ADC', numero: 4 }),
      ...adcSiemens({ ...amira, uid: 'adc-2', descripcion: 'ep2d_ADC', numero: 4 }),
    ];
    const { elegida, preparado, adcEquipo, matched } = abrirComoLaApp(cortes);

    expect(elegida.adcEquipo?.seriesUID).toBe('adc-1');
    expect(preparado.adcEquipo?.cortes).toHaveLength(ALTURAS.length);
    expect(adcEquipo.sinPareja).toBe(0);
    matched.forEach((m, i) => {
      expect(mediaEnTejido(adcEquipo.porCorte[i]!.pixelData)).toBeCloseTo(adcA(m.position), 9);
    });
  });

  it('cuando hay dos adquisiciones con la misma geometría', () => {
    // Una DWI repetida: la segunda, con otro ADC, para notar si se cruzan.
    const segunda = (z: number) => adcA(z) * 1.1;
    const ge = { fabricante: 'GE MEDICAL SYSTEMS', tr: 4567, te: 94.2 };
    const cortes = [
      ...difusion({ ...ge, uid: 'dwi-1', descripcion: 'Ax DWI', numero: 4, hora: '091000' }, [0, 1000], etiquetasGE),
      ...difusion({ ...ge, uid: 'dwi-2', descripcion: 'Ax DWI', numero: 5, hora: '092000' }, [0, 1000], etiquetasGE, segunda),
      ...adcGE({ ...ge, uid: 'adc-1', descripcion: 'ADC (10^-6 mm²/s)', numero: 450, hora: '091000' }),
      ...adcGE({ ...ge, uid: 'adc-2', descripcion: 'ADC (10^-6 mm²/s)', numero: 550, hora: '092000' }, segunda),
    ];
    const series = inventariarSeries(cortes);

    const primera = porUid(series, 'dwi-1')!;
    const repetida = porUid(series, 'dwi-2')!;
    expect(primera.seriesUIDs).toEqual(['dwi-1']);
    expect(repetida.seriesUIDs).toEqual(['dwi-2']);
    expect(primera.adcEquipo?.seriesUID).toBe('adc-1');
    expect(repetida.adcEquipo?.seriesUID).toBe('adc-2');

    const preparada = prepararConjunto(cortes, series, repetida);
    for (const grupo of preparada.diffusion.values()) expect(grupo.count).toBe(1);
    const { porCorte } = emparejarAdcEquipo(preparada.matched, preparada.adcEquipo!.cortes);
    preparada.matched.forEach((m, i) => {
      expect(mediaEnTejido(porCorte[i]!.pixelData)).toBeCloseTo(segunda(m.position), 9);
    });
  });

  it('cuando hay dos adquisiciones en distinta orientación', () => {
    const ge = { fabricante: 'GE MEDICAL SYSTEMS' };
    const coronal = { ...ge, orientacion: CORONAL, hora: '100000', tr: 9537, te: 70.4 };
    const axial = { ...ge, orientacion: AXIAL, hora: '101000', tr: 4947, te: 73.8 };
    const cortes = [
      ...difusion({ ...coronal, uid: 'dwi-cor', descripcion: 'Cor FOCUS ALL B-1000', numero: 9 }, [0, 1000], etiquetasGE),
      ...adcGE({ ...coronal, uid: 'adc-cor', descripcion: 'ADC (10^-6 mm²/s)', numero: 950 }),
      ...difusion({ ...axial, uid: 'dwi-ax', descripcion: 'Ax DWI ALL B800', numero: 16 }, [0, 800], etiquetasGE),
      ...adcGE({ ...axial, uid: 'adc-ax', descripcion: 'ADC (10^-6 mm²/s)', numero: 1650 }),
    ];
    const series = inventariarSeries(cortes);

    expect(porUid(series, 'dwi-cor')).toMatchObject({ seriesUIDs: ['dwi-cor'], valoresB: [0, 1000] });
    expect(porUid(series, 'dwi-cor')?.adcEquipo?.seriesUID).toBe('adc-cor');
    expect(porUid(series, 'dwi-ax')).toMatchObject({ seriesUIDs: ['dwi-ax'], valoresB: [0, 800] });
    expect(porUid(series, 'dwi-ax')?.adcEquipo?.seriesUID).toBe('adc-ax');
  });

  it('cuando el equipo guarda el ADC dentro de la serie de la DWI', () => {
    const mismo = { fabricante: 'Philips', uid: 'dwi', descripcion: 'DWI', numero: 5, hora: '101010', tr: 3000, te: 80 };
    const cortes = [
      ...difusion({ ...mismo, tipo: ['ORIGINAL', 'PRIMARY', 'DIFFUSION', 'NONE'] }, [0, 1000], b => ({ bEstandar: b })),
      ...adcSiemens({ ...mismo, tipo: ['DERIVED', 'PRIMARY', 'ADC', 'ADC'] }),
    ];
    const { elegida, preparado, mapas, adcEquipo, matched } = abrirComoLaApp(cortes);

    expect(elegida.seriesUIDs).toEqual(['dwi']);
    expect(elegida.adcEquipo?.seriesUID).toBe('dwi#adc');
    expect(preparado.bValues).toEqual([0, 1000]);
    expect(adcEquipo.sinPareja).toBe(0);
    matched.forEach((m, i) => {
      expect(mediaEnTejido(mapas[i].adc)).toBeCloseTo(adcA(m.position), 6);
      expect(mediaEnTejido(adcEquipo.porCorte[i]!.pixelData)).toBeCloseTo(adcA(m.position), 9);
    });
  });

  it('elige por defecto la difusión que trae el ADC del equipo', () => {
    const avanto = { fabricante: 'SIEMENS', tipo: ['ORIGINAL', 'PRIMARY', 'DIFFUSION', 'NONE'] };
    const cortes = [
      ...difusion({ ...avanto, uid: 'pelvis', descripcion: 'ep2d_diff_orth', numero: 16, tr: 6300, te: 109, espaciado: [2, 2] }, [0, 400, 1000, 1400], etiquetasSiemens),
      ...difusion({ ...avanto, uid: 'abdomen', descripcion: 'ep2d_diff_orth', numero: 8, tr: 7200, te: 109, hora: '090000' }, [0, 1000], etiquetasSiemens),
      ...adcSiemens({ fabricante: 'SIEMENS', uid: 'adc', descripcion: 'ADC_S8_1', numero: 100, tr: 7200, te: 109, hora: '090000' }),
    ];
    const series = inventariarSeries(cortes);
    expect(serieInicial(series)?.seriesUIDs).toEqual(['abdomen']);
    expect(porUid(series, 'pelvis')?.esDifusion).toBe(true);
  });
});

describe('cálculo por defecto como el equipo y las guías', () => {
  /** Tejido de cuerpo con perfusión: biexponencial IVIM, así que el modelo no es exacto. */
  const ivim = (b: number, d: number) => S0 * (0.85 * Math.exp(-b * d) + 0.15 * Math.exp(-b * 0.02));

  /** ADC de una recta de mínimos cuadrados sin ponderar de ln S frente a b. */
  function adcSinPonderar(bValores: number[], senales: number[]): number {
    const y = senales.map(Math.log);
    const bMedia = bValores.reduce((a, b) => a + b, 0) / bValores.length;
    const yMedia = y.reduce((a, b) => a + b, 0) / y.length;
    let sxy = 0;
    let sxx = 0;
    bValores.forEach((b, j) => {
      sxy += (b - bMedia) * (y[j] - yMedia);
      sxx += (b - bMedia) ** 2;
    });
    return -sxy / sxx;
  }

  it('con dos valores b calcula entre ambos', () => {
    const cortes = difusion({ uid: 'dwi', descripcion: 'Ax DWI', numero: 4, fabricante: 'GE MEDICAL SYSTEMS' }, [0, 1000], etiquetasGE);
    const { preparado } = abrirComoLaApp(cortes);
    expect(preparado).toMatchObject({ bLow: 0, bHigh: 1000, multiB: false });
  });

  it('con tres o más valores b ajusta todas sin ponderar y reproduce el ADC del equipo', () => {
    // Protocolo de cuerpo de Siemens: b 50/400/800, y el ADC del equipo es la recta
    // sin ponderar sobre las tres. Con la b baja por defecto de la versión 1.2
    // (400) salía un −8 %; con la ponderación S², un +2 %.
    const bValores = [50, 400, 800];
    const cuerpo = { fabricante: 'SIEMENS', hora: '114500', tr: 5400, te: 70, tipo: ['DERIVED', 'PRIMARY', 'DIFFUSION', 'TRACEW', 'NORM', 'DIS2D'] };
    const adcDelEquipo = (z: number) => adcSinPonderar(bValores, bValores.map(b => Math.round(ivim(b, adcA(z)))));
    const cortes = [
      ...bValores.flatMap(b =>
        serie({ ...cuerpo, uid: 'traza', descripcion: 'ep2d_diff_b50_400_800_TRACEW', numero: 3 },
          z => imagen(FILAS, COLUMNAS, () => ivim(b, adcA(z))), () => etiquetasSiemens(b))
      ),
      ...adcSiemens({ ...cuerpo, uid: 'adc', descripcion: 'ep2d_diff_b50_400_800_ADC', numero: 4 }, adcDelEquipo),
    ];
    const { preparado, matched, mapas, adcEquipo } = abrirComoLaApp(cortes);

    expect(preparado).toMatchObject({ bLow: 50, bHigh: 800, multiB: true });
    matched.forEach((_, i) => {
      const calculado = mediaEnTejido(mapas[i].adc);
      const delEquipo = mediaEnTejido(adcEquipo.porCorte[i]!.pixelData);
      expect(Math.abs(calculado / delEquipo - 1)).toBeLessThan(0.002);
    });
    const pares = paresDeValidacion(matched, mapas, adcEquipo.porCorte);
    expect(computeLinCCC(pares.map(p => p.vendMean), pares.map(p => p.calcMean)).ccc).toBeGreaterThan(0.999);
  });

  it('con b = 0 y b = 50 en el protocolo, la b baja por defecto es la menor', () => {
    const cortes = difusion({ uid: 'dwi', descripcion: 'ep2d_diff', numero: 5, fabricante: 'SIEMENS', tipo: ['ORIGINAL', 'PRIMARY', 'DIFFUSION', 'NONE'] }, [0, 50, 400, 800], etiquetasSiemens);
    const { preparado } = abrirComoLaApp(cortes);
    expect(preparado).toMatchObject({ bLow: 0, bHigh: 800, multiB: true, bValues: [0, 50, 400, 800] });
  });
});

describe('unidades del ADC del equipo', () => {
  const corte = (valor: number, metadata: { rescaleType?: string; seriesDescription?: string } = {}) => {
    const [c] = adcSiemens({ uid: 'x', descripcion: metadata.seriesDescription ?? 'ADC', numero: 1, alturas: [0] });
    c.metadata.rescaleType = metadata.rescaleType;
    c.pixelData = new Float32Array(c.pixelData.length).fill(valor);
    return c;
  };

  it('lee la unidad declarada en RescaleType o en la descripción de GE', () => {
    expect(unidadDeclarada({ rescaleType: '10-6 mm2/s', seriesDescription: '' })).toMatchObject({ factor: 1e-6, origen: 'rescale-type' });
    expect(unidadDeclarada({ rescaleType: 'US', seriesDescription: 'ADC (10^-6 mm²/s)' })).toMatchObject({ factor: 1e-6, origen: 'descripcion' });
    expect(unidadDeclarada({ rescaleType: undefined, seriesDescription: 'ADC (10 -6 mm²-s)' })).toMatchObject({ factor: 1e-6 });
    expect(unidadDeclarada({ rescaleType: '10-3 mm2/s', seriesDescription: '' })).toMatchObject({ factor: 1e-3 });
    expect(unidadDeclarada({ rescaleType: 'mm2/s', seriesDescription: '' })).toMatchObject({ factor: 1 });
    expect(unidadDeclarada({ rescaleType: undefined, seriesDescription: 'ep2d_diff_ADC' })).toBeUndefined();
  });

  it('deduce la unidad de la magnitud de los valores cuando no está declarada', () => {
    expect(unidadPorMagnitud([corte(800)]).factor).toBe(1e-6);
    expect(unidadPorMagnitud([corte(0.8)]).factor).toBe(1e-3);
    expect(unidadPorMagnitud([corte(0.0008)]).factor).toBe(1);
  });

  it('se queda con la magnitud si la declaración no cuadra, y lo dice', () => {
    const unidad = resolverUnidadAdc([corte(0.8, { rescaleType: '10-6 mm2/s' })]);
    expect(unidad).toMatchObject({ factor: 1e-3, origen: 'magnitud', declaradaDescartada: '10⁻⁶ mm²/s' });
  });

  it('convierte a mm²/s un mapa guardado con pendiente de reescalado', () => {
    const ge = { fabricante: 'GE MEDICAL SYSTEMS', hora: '091236', tr: 4567, te: 94.2 };
    const cortes = [
      ...difusion({ ...ge, uid: 'dwi', descripcion: 'Ax DWI', numero: 4 }, [0, 1000], etiquetasGE),
      // Guardado en 10⁻⁶ con pendiente 10⁻⁶: tras el reescalado ya está en mm²/s.
      ...serie(
        { ...ge, uid: 'adc', descripcion: 'ADC', numero: 450, tipo: ['DERIVED', 'PRIMARY', 'DIFFUSION', 'ADC'] },
        z => imagen(FILAS, COLUMNAS, () => Math.round(adcA(z) * 1e6)),
        () => ({ pendiente: 1e-6 })
      ),
    ];
    const { preparado, adcEquipo, matched } = abrirComoLaApp(cortes);
    expect(preparado.adcEquipo?.unidad.factor).toBe(1);
    matched.forEach((m, i) => {
      expect(mediaEnTejido(adcEquipo.porCorte[i]!.pixelData)).toBeCloseTo(adcA(m.position), 9);
    });
  });
});

describe('motivoDerivada', () => {
  it('reconoce las imágenes derivadas por ImageType', () => {
    expect(motivoDerivada(['DERIVED', 'PRIMARY', 'DIFFUSION', 'EADC'], 'eADC')).toBe('eadc');
    expect(motivoDerivada(['DERIVED', 'PRIMARY', 'DIFFUSION', 'CALC_BVALUE', 'TRACEW'], 'x')).toBe('b-calculada');
    expect(motivoDerivada(['DERIVED', 'PRIMARY', 'DIFFUSION', 'FA', 'ND', 'RGB'], 'x')).toBe('mapa-derivado');
    expect(motivoDerivada(['DERIVED', 'PRIMARY', 'DIFFUSION', 'EXP'], 'x')).toBe('mapa-derivado');
    expect(motivoDerivada(['DERIVED', 'PRIMARY', 'DIFFUSION', 'TENSOR'], 'x')).toBe('mapa-derivado');
  });

  it('reconoce las derivadas por la descripción cuando ImageType no lo dice', () => {
    expect(motivoDerivada([], 'eADC[No-Q]')).toBe('eadc');
    expect(motivoDerivada([], 'ep2d_diff_4scan_trace_p2_CALC_BVAL')).toBe('b-calculada');
    expect(motivoDerivada([], 'DW_Synthetic: Ax DWI B-800')).toBe('sintetica');
    expect(motivoDerivada([], 'ep2d_diff_mddw_12_p2_ColFA')).toBe('mapa-derivado');
    expect(motivoDerivada([], 'ep2d_diff_mddw_12_p2_FA')).toBe('mapa-derivado');
  });

  it('deja pasar la traza, la b = 0 del tensor, el ADC y las series de grasa', () => {
    expect(motivoDerivada(['DERIVED', 'PRIMARY', 'DIFFUSION', 'TRACEW'], 'ep2d_diff_TRACEW')).toBeUndefined();
    expect(motivoDerivada(['DERIVED', 'PRIMARY', 'DIFFUSION', 'TENSOR_B0'], 'ep2d_diff_mddw_12_p2_TENSOR_B0')).toBeUndefined();
    expect(motivoDerivada(['DERIVED', 'PRIMARY', 'DIFFUSION', 'ADC'], 'ADC (10^-6 mm²/s)')).toBeUndefined();
    expect(motivoDerivada(['DERIVED', 'PRIMARY', 'DIXON', 'FAT'], 'FAT: Ax T1 Flex')).toBeUndefined();
    expect(motivoDerivada(['ORIGINAL', 'PRIMARY', 'OTHER'], 'Ax DWI ALL b1000')).toBeUndefined();
  });

  it('no aparta por el nombre una serie adquirida', () => {
    expect(motivoDerivada(['ORIGINAL', 'PRIMARY', 'DIFFUSION', 'NONE'], 'ep2d_diff_FA_sat')).toBeUndefined();
    expect(motivoDerivada(['DERIVED', 'PRIMARY', 'DIFFUSION'], 'ep2d_diff_FA_sat')).toBe('mapa-derivado');
  });
});
