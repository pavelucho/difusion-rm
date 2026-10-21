import { describe, it, expect, beforeAll } from 'vitest';
import JSZip from 'jszip';
import { leerCabecera, parseDicom } from '../dicom-reader';
import { inventariarSeries, serieInicial } from '../series-builder';
import { calcularMapas, prepararConjunto } from '../estudio';
import { es } from '../../../i18n/es';
import { AXIAL, SAGITAL, dicomSintetico, imagen, posicionEn, type CorteSintetico } from './dicom-sintetico';

/**
 * El worker abre el estudio completo leyendo solo las cabeceras y lee los
 * píxeles únicamente de la serie que calcula; hasta la versión 1.3 guardaba en
 * memoria todas las imágenes del estudio, dos veces, y dejaba sin RAM a equipos
 * con el visor y el dictado abiertos. Estas pruebas comprueban que el resultado
 * no ha cambiado y que la serie elegida es lo único que se relee.
 */

const MARCO = '1.2.826.0.1.3680043.10.1338.5';
const ALTURAS = [0, 5, 10, 15];
const LADO = 32;

function cortes(
  base: Omit<CorteSintetico, 'marcoReferencia' | 'orientacion' | 'posicion' | 'filas' | 'columnas' | 'pixeles'>,
  senal: (z: number, repeticion: number) => number,
  { orientacion = AXIAL, repeticiones = 1, lado = LADO } = {}
): ArrayBuffer[] {
  return Array.from({ length: repeticiones }, (_, r) =>
    ALTURAS.map((z, i) =>
      dicomSintetico({
        ...base,
        instancia: r * ALTURAS.length + i + 1,
        marcoReferencia: MARCO,
        orientacion,
        posicion: posicionEn(orientacion, z),
        filas: lado,
        columnas: lado,
        pixeles: imagen(lado, lado, (x, y) => senal(z, r) * (1 + 0.01 * ((x * 3 + y * 5 + r) % 7))),
      })
    )
  ).flat();
}

/** Un estudio completo en pequeño: la traza con dos repeticiones, su ADC y otras series. */
function estudio(): ArrayBuffer[] {
  const traza = { serieUID: '1.2.3.10', descripcion: 'ep2d_diff_trace', numeroSerie: 10, tr: 5000, te: 90 };
  return [
    ...cortes({ ...traza, bEstandar: 0, tipoImagen: ['ORIGINAL', 'PRIMARY', 'DIFFUSION', 'TRACEW'] }, (z, r) => 20000 - z * 10 + r * 50, { repeticiones: 2 }),
    ...cortes({ ...traza, bEstandar: 500, tipoImagen: ['ORIGINAL', 'PRIMARY', 'DIFFUSION', 'TRACEW'] }, (z, r) => 13000 - z * 10 + r * 40, { repeticiones: 2 }),
    ...cortes({ ...traza, bEstandar: 1000, tipoImagen: ['ORIGINAL', 'PRIMARY', 'DIFFUSION', 'TRACEW'] }, (z, r) => 8500 - z * 10 + r * 30, { repeticiones: 2 }),
    ...cortes(
      { serieUID: '1.2.3.11', descripcion: 'ep2d_diff_trace_ADC', numeroSerie: 11, tr: 5000, te: 90, tipoImagen: ['DERIVED', 'PRIMARY', 'DIFFUSION', 'ADC'] },
      () => 850
    ),
    ...cortes({ serieUID: '1.2.3.20', descripcion: 'ep2d_dti', numeroSerie: 20, tr: 6000, te: 95, bEstandar: 0, tipoImagen: ['ORIGINAL', 'PRIMARY', 'DIFFUSION', 'NONE'] }, () => 19000),
    ...cortes({ serieUID: '1.2.3.20', descripcion: 'ep2d_dti', numeroSerie: 20, tr: 6000, te: 95, bEstandar: 1000, tipoImagen: ['ORIGINAL', 'PRIMARY', 'DIFFUSION', 'NONE'] }, (_z, r) => 7000 + r * 100, { repeticiones: 6 }),
    ...cortes({ serieUID: '1.2.3.30', descripcion: 't2_tse_tra', numeroSerie: 30, tr: 4000, te: 100 }, () => 3000, { lado: 64 }),
    ...cortes({ serieUID: '1.2.3.31', descripcion: 't1_sag', numeroSerie: 31, tr: 500, te: 10 }, () => 2000, { orientacion: SAGITAL, lado: 64 }),
  ];
}

/** Un archivo como los que entrega el navegador, que cuenta cuántas veces se lee. */
class ArchivoContado {
  lecturas = 0;
  constructor(private datos: ArrayBuffer, private disponible = () => true) {}
  async arrayBuffer(): Promise<ArrayBuffer> {
    this.lecturas++;
    if (!this.disponible()) throw new DOMException('El archivo ya no está', 'NotReadableError');
    return this.datos.slice(0);
  }
}

let enviar: (data: unknown) => Promise<{ type: string; payload: any }>;

beforeAll(async () => {
  let esperando: ((m: any) => void) | null = null;
  (globalThis as any).self = {
    postMessage: (m: any) => {
      if (m.type !== 'PROGRESS') esperando?.(m);
    },
  };
  await import('../worker');
  enviar = data =>
    new Promise(resolver => {
      esperando = m => {
        esperando = null;
        resolver(m);
      };
      (globalThis as any).self.onmessage({ data });
    });
});

/** Lo que calcula el motor con todo el estudio en memoria, como antes. */
function referencia(archivos: ArrayBuffer[], parametros: (p: any) => any) {
  const todos = archivos.map(b => parseDicom(b));
  const series = inventariarSeries(todos);
  const conjunto = prepararConjunto(todos, series, serieInicial(series)!);
  return calcularMapas(conjunto.diffusion, conjunto.bValues, parametros(conjunto));
}

const porDefecto = (p: any) => ({
  bLow: p.bLow,
  bHigh: p.bHigh,
  bTarget: 2000,
  threshold: p.threshold,
  useMultiB: p.useMultiB ?? p.multiB,
  registrationMode: 'translation' as const,
});

describe('worker con el estudio completo', () => {
  it('lee solo la cabecera de cada archivo para el inventario', () => {
    const corte = leerCabecera(estudio()[0], 7);
    expect(corte.pixelData.length).toBe(0);
    expect(corte.metadata.buffer).toBeUndefined();
    expect(corte.metadata.dataset).toBeUndefined();
    expect(corte.metadata.origen).toBe(7);
  });

  it('calcula lo mismo que con todo el estudio en memoria, y solo relee la serie elegida', async () => {
    const buffers = estudio();
    const archivos = buffers.map(b => new ArchivoContado(b));

    const cargado = await enviar({ type: 'LOAD_FILES', payload: { files: archivos } });
    expect(cargado.type).toBe('LOADED');
    expect(cargado.payload.serieElegida).toBe('1.2.3.10');

    const calculado = await enviar({ type: 'COMPUTE', payload: porDefecto(cargado.payload) });
    expect(calculado.type).toBe('COMPUTED');

    const esperado = referencia(buffers, porDefecto);
    expect(calculado.payload.results.length).toBe(esperado.resultados.length);
    calculado.payload.results.forEach((r: any, i: number) => {
      expect(r.maps).toEqual(esperado.resultados[i].maps);
      expect(r.registeredSlices).toEqual(esperado.resultados[i].registeredSlices);
    });
    expect(calculado.payload.vendorAdcData.every((d: Float32Array | null) => d && d.length === LADO * LADO)).toBe(true);

    // La traza (24 imágenes) y su ADC (4) se leen dos veces; el resto, una.
    const releidos = archivos.filter(a => a.lecturas === 2).length;
    expect(releidos).toBe(28);
    expect(archivos.every(a => a.lecturas <= 2)).toBe(true);
  });

  it('da el mismo resultado al abrir el estudio como ZIP', async () => {
    const buffers = estudio();
    const zip = new JSZip();
    buffers.forEach((b, i) => zip.file(`DICOM/IM${String(i).padStart(4, '0')}`, b));
    zip.file('VISOR/LEEME.txt', 'visor de escritorio');
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });

    const cargado = await enviar({ type: 'LOAD_ZIP', payload: { file: blob } });
    expect(cargado.type).toBe('LOADED');
    const calculado = await enviar({ type: 'COMPUTE', payload: porDefecto(cargado.payload) });

    const esperado = referencia(buffers, porDefecto);
    calculado.payload.results.forEach((r: any, i: number) => expect(r.maps).toEqual(esperado.resultados[i].maps));
  });

  it('cambia de serie releyendo del disco y exporta con los archivos de referencia', async () => {
    const archivos = estudio().map(b => new ArchivoContado(b));
    const cargado = await enviar({ type: 'LOAD_FILES', payload: { files: archivos } });
    const dti = cargado.payload.series.find((s: any) => s.descripcion === 'ep2d_dti');
    expect(dti.esDifusion).toBe(true);

    const cambiado = await enviar({ type: 'SELECT_SERIES', payload: { id: dti.id } });
    expect(cambiado.type).toBe('LOADED');
    expect(cambiado.payload.bValues).toEqual([0, 1000]);
    expect(cambiado.payload.sliceCount).toBe(ALTURAS.length);

    const calculado = await enviar({ type: 'COMPUTE', payload: porDefecto(cambiado.payload) });
    const exportado = await enviar({
      type: 'EXPORT_DICOM',
      payload: { mapsData: calculado.payload.results.map((r: any) => ({ maps: r.maps })) },
    });
    expect(exportado.type).toBe('EXPORTED');
    const zip = await JSZip.loadAsync(await exportado.payload.zipBlob.arrayBuffer());
    expect(Object.keys(zip.files).length).toBe(ALTURAS.length * 3);
  });

  it('avisa con claridad si al cambiar de serie los archivos ya no están', async () => {
    let conectado = true;
    const archivos = estudio().map(b => new ArchivoContado(b, () => conectado));
    const cargado = await enviar({ type: 'LOAD_FILES', payload: { files: archivos } });
    const dti = cargado.payload.series.find((s: any) => s.descripcion === 'ep2d_dti');

    conectado = false; // se retiró el CD o la memoria USB
    const respuesta = await enviar({ type: 'SELECT_SERIES', payload: { id: dti.id } });
    expect(respuesta).toEqual({ type: 'ERROR', payload: es.errReleer });
  });
});
