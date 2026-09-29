import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseDicom } from '../dicom-reader';
import { cortesDelConjunto, inventariarSeries, serieInicial } from '../series-builder';
import { calcularMapas, prepararConjunto } from '../estudio';
import { emparejarAdcEquipo, TOLERANCIA_POSICION_MM } from '../adc-equipo';
import { createDerivedDicom } from '../dicom-writer';
import { DicomNoSoportadoError } from '../pixel-data';
import type { DicomSlice } from '../types';

/**
 * Verificación contra estudios DICOM reales.
 *
 * No hay ningún estudio en el repositorio: estos archivos contienen datos de
 * paciente y no deben versionarse. Apunte ESTUDIOS_DICOM a una carpeta local con
 * subcarpetas, una por estudio, y estas pruebas se ejecutarán sobre ellas:
 *
 *   ESTUDIOS_DICOM=/ruta/a/estudios npm test
 *
 * Sin esa variable, la suite se salta y el resto de pruebas sigue corriendo.
 */
const RAIZ = process.env.ESTUDIOS_DICOM;
const hayEstudios = Boolean(RAIZ && fs.existsSync(RAIZ));

function archivosDicom(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entrada => {
    const ruta = path.join(dir, entrada.name);
    if (entrada.isDirectory()) return archivosDicom(ruta);
    return entrada.name.toLowerCase().endsWith('.dcm') ? [ruta] : [];
  });
}

function estudios(): { nombre: string; ruta: string }[] {
  if (!RAIZ) return [];
  return fs
    .readdirSync(RAIZ, { withFileTypes: true })
    .filter(e => e.isDirectory())
    .map(e => ({ nombre: e.name, ruta: path.join(RAIZ, e.name) }));
}

/**
 * Como la aplicación: un objeto DICOM que no es imagen (informe estructurado,
 * espectroscopía) se ignora; una imagen que no se sabe decodificar se cuenta.
 */
function leerEstudio(ruta: string): { cortes: DicomSlice[]; noSoportadas: string[] } {
  const cortes: DicomSlice[] = [];
  const noSoportadas: string[] = [];
  for (const archivo of archivosDicom(ruta)) {
    const contenido = fs.readFileSync(archivo);
    const buffer = contenido.buffer.slice(
      contenido.byteOffset,
      contenido.byteOffset + contenido.byteLength
    ) as ArrayBuffer;
    try {
      cortes.push(parseDicom(buffer));
    } catch (error) {
      const sinImagen = error instanceof Error && error.message.startsWith('El archivo no contiene datos de imagen');
      if (error instanceof DicomNoSoportadoError && !sinImagen) noSoportadas.push(`${archivo}: ${error.message}`);
    }
  }
  return { cortes, noSoportadas };
}

describe.skipIf(!hayEstudios)('estudios DICOM reales', () => {
  for (const estudio of estudios()) {
    describe(estudio.nombre, () => {
      const { cortes: todos, noSoportadas } = leerEstudio(estudio.ruta);

      // Igual que hace la aplicación al arrastrar el estudio entero: se inventaría,
      // se elige el conjunto de difusión por defecto y se prepara con los valores
      // por defecto.
      const series = inventariarSeries(todos);
      const elegida = serieInicial(series);
      const cortes = elegida ? cortesDelConjunto(todos, elegida).difusion : [];

      /** El cálculo del primer COMPUTE de la aplicación, con su corregistro por defecto. */
      const calcularComoLaApp = () => {
        const p = prepararConjunto(todos, series, elegida!);
        return calcularMapas(p.diffusion, p.bValues, {
          bLow: p.bLow,
          bHigh: p.bHigh,
          bTarget: 2000,
          threshold: p.threshold,
          useMultiB: p.multiB,
          registrationMode: 'translation',
        });
      };

      it('lee todas las imágenes sin fallar', () => {
        expect(todos.length).toBeGreaterThan(0);
        expect(noSoportadas).toEqual([]);
      });

      it('identifica una serie de difusión entre todas las del estudio', () => {
        expect(elegida, 'ninguna serie de difusión detectada').toBeDefined();
        expect(cortes.length).toBeGreaterThan(0);
        // El conjunto elegido no puede arrastrar imágenes de otras secuencias ni
        // de otra orientación.
        const geometrias = new Set(
          cortes.map(c => `${c.metadata.rows}x${c.metadata.columns}|${JSON.stringify(c.metadata.imageOrientationPatient)}`)
        );
        expect(geometrias.size, `el conjunto mezcla geometrías: ${[...geometrias]}`).toBe(1);
      });

      it('no calcula con imágenes derivadas o sintéticas del equipo', () => {
        for (const corte of cortes) {
          const tipo = corte.metadata.imageType;
          expect(tipo, corte.metadata.seriesDescription).not.toContain('EADC');
          expect(tipo, corte.metadata.seriesDescription).not.toContain('CALC_BVALUE');
          expect(corte.metadata.seriesDescription).not.toMatch(/synthetic/i);
        }
      });

      it('obtiene el valor b de un tag de valor b, no por inferencia', () => {
        const inferidos = cortes.filter(c => c.metadata.bValueInferred);
        expect(inferidos, `${inferidos.length} imágenes sin valor b legible`).toHaveLength(0);
      });

      it('encuentra al menos dos valores b distintos', () => {
        const valores = new Set(cortes.map(c => c.metadata.bValue));
        expect(valores.size).toBeGreaterThanOrEqual(2);
      });

      it('decodifica píxeles con rango plausible', () => {
        for (const corte of cortes) {
          const { columns, rows } = corte.metadata;
          expect(corte.pixelData.length).toBe(columns * rows);

          let max = -Infinity;
          let negativos = 0;
          for (let i = 0; i < corte.pixelData.length; i++) {
            const v = corte.pixelData[i];
            if (v > max) max = v;
            if (v < 0) negativos++;
          }

          // Un flujo comprimido leído como píxeles da ruido saturado en todo el
          // rango de 16 bits; una imagen de RM real no llega ahí.
          expect(max).toBeGreaterThan(0);
          expect(max).toBeLessThan(60000);
          expect(negativos).toBe(0);
        }
      });

      it('empareja los cortes y calcula un ADC plausible con los valores por defecto', () => {
        const { matched, resultados, discardedCount } = calcularComoLaApp();
        expect(matched.length).toBeGreaterThan(0);
        expect(discardedCount).toBe(0);

        const mapas = resultados[Math.floor(resultados.length / 2)].maps;

        let dentroDeMascara = 0;
        let sumaAdc = 0;
        for (let i = 0; i < mapas.mask.length; i++) {
          if (mapas.mask[i] === 1) {
            dentroDeMascara++;
            sumaAdc += mapas.adc[i];
          }
        }

        // Con una máscara de fondo razonable, el tejido ocupa buena parte del corte.
        expect(dentroDeMascara / mapas.mask.length).toBeGreaterThan(0.05);

        // ADC medio de tejido: del orden de 1e-3 mm²/s.
        const adcMedio = sumaAdc / dentroDeMascara;
        expect(adcMedio).toBeGreaterThan(0.0001);
        expect(adcMedio).toBeLessThan(0.0035);
      });

      it('lee el ADC del equipo en mm²/s y lo empareja por posición', () => {
        const { adcEquipo } = prepararConjunto(todos, series, elegida!);
        if (!adcEquipo) return; // el estudio no lo trae
        const { matched } = calcularComoLaApp();

        const { porCorte } = emparejarAdcEquipo(matched, adcEquipo.cortes);
        const emparejados = matched.filter((_, i) => porCorte[i]);
        expect(emparejados.length, 'ningún corte del equipo a la altura de los calculados').toBeGreaterThan(0);
        matched.forEach((corte, i) => {
          const delEquipo = porCorte[i];
          if (!delEquipo) return;
          expect(Math.abs(delEquipo.metadata.canonicalPosition - corte.position)).toBeLessThanOrEqual(TOLERANCIA_POSICION_MM);
        });

        // Mediana del ADC del equipo dentro del tejido: tiene que estar en mm²/s.
        const valores: number[] = [];
        for (const corte of porCorte) {
          if (!corte) continue;
          for (let i = 0; i < corte.pixelData.length; i += 7) {
            if (corte.pixelData[i] > 0) valores.push(corte.pixelData[i]);
          }
        }
        valores.sort((a, b) => a - b);
        const mediana = valores[Math.floor(valores.length / 2)];
        expect(mediana).toBeGreaterThan(0.0001);
        expect(mediana).toBeLessThan(0.004);
      });

      it('exporta un mapa ADC que se vuelve a leer correctamente', async () => {
        const { bLow, bHigh, bValues, multiB, threshold } = prepararConjunto(todos, series, elegida!);
        const { matched, resultados } = calcularComoLaApp();
        const centro = Math.floor(matched.length / 2);
        const sBaja = matched[centro].slicesByBValue.get(bLow)!;
        const mapas = resultados[centro].maps;

        const seriesUID = '1.2.826.0.1.3680043.10.1338.1';
        const sopUID = '1.2.826.0.1.3680043.10.1338.2';
        const { buffer, saturatedCount } = await createDerivedDicom(
          sBaja,
          mapas.adc,
          'ADC',
          { bLow, bHigh, bValues: multiB ? bValues : undefined, bTarget: 2000, threshold, registration: 'translation' },
          seriesUID,
          sopUID
        );

        // El original de GE viene comprimido; el derivado se escribe en claro y el
        // meta-encabezado tiene que decirlo, o el receptor intentará descomprimirlo.
        const releido = parseDicom(buffer);
        expect(releido.metadata.transferSyntax).toBe('VR explícito little endian');
        expect(releido.metadata.seriesInstanceUID).toBe(seriesUID);
        expect(releido.metadata.columns).toBe(sBaja.metadata.columns);
        expect(releido.metadata.rows).toBe(sBaja.metadata.rows);

        // Convención de escalado del ADC: pixel = round(ADC · 1e6).
        expect(saturatedCount).toBe(0);
        for (let i = 0; i < mapas.adc.length; i++) {
          expect(releido.pixelData[i]).toBe(Math.round(mapas.adc[i] * 1e6));
        }
      });
    });
  }
});
