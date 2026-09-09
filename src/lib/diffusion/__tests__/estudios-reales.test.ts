import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseDicom } from '../dicom-reader';
import {
  filtrarPorSerie,
  groupAndAverageSlices,
  inventariarSeries,
  matchSlices,
} from '../series-builder';
import { computeTwoPointMaps, estimateNoiseThreshold } from '../maps';
import { createDerivedDicom } from '../dicom-writer';
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

function leerEstudio(ruta: string): DicomSlice[] {
  return archivosDicom(ruta).map(archivo => {
    const contenido = fs.readFileSync(archivo);
    const buffer = contenido.buffer.slice(
      contenido.byteOffset,
      contenido.byteOffset + contenido.byteLength
    ) as ArrayBuffer;
    return parseDicom(buffer);
  });
}

describe.skipIf(!hayEstudios)('estudios DICOM reales', () => {
  for (const estudio of estudios()) {
    describe(estudio.nombre, () => {
      const todos = leerEstudio(estudio.ruta);

      // Igual que hace la aplicación: se inventaría el estudio y se trabaja solo
      // sobre la serie de difusión. Un export completo del PACS trae además T1,
      // T2, STIR y dinámicos, que no tienen nada que ver con el cálculo.
      const series = inventariarSeries(todos);
      const seriesDifusion = series.filter(s => s.esDifusion);
      const cortes = seriesDifusion.length
        ? filtrarPorSerie(todos, seriesDifusion[0].seriesUIDs)
        : [];

      it('lee todas las imágenes sin fallar', () => {
        expect(todos.length).toBeGreaterThan(0);
      });

      it('identifica una serie de difusión entre todas las del estudio', () => {
        expect(seriesDifusion.length, 'ninguna serie de difusión detectada').toBeGreaterThan(0);
        expect(cortes.length).toBeGreaterThan(0);
        // La serie elegida no puede arrastrar imágenes de otras secuencias.
        const matrices = new Set(cortes.map(c => `${c.metadata.rows}x${c.metadata.columns}`));
        expect(matrices.size, `la serie mezcla matrices: ${[...matrices]}`).toBe(1);
      });

      it('obtiene el valor b de un tag de valor b, no por inferencia', () => {
        const inferidos = cortes.filter(c => c.metadata.bValueInferred);
        expect(inferidos, `${inferidos.length} imágenes sin valor b legible`).toHaveLength(0);
      });

      it('encuentra al menos dos valores b distintos', () => {
        const valores = new Set(cortes.map(c => c.metadata.bValue));
        expect([...valores].sort((a, b) => a - b).length).toBeGreaterThanOrEqual(2);
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

      it('empareja cortes entre las dos series y calcula un ADC plausible', () => {
        const { diffusion } = groupAndAverageSlices(cortes);
        const valoresB = [...new Set(
          [...diffusion.values()].map(g => g.metadata.bValue)
        )].sort((a, b) => a - b);

        const bBaja = valoresB[0];
        const bAlta = valoresB[valoresB.length - 1];

        const { matched, discardedCount } = matchSlices(diffusion, [bBaja, bAlta]);
        expect(matched.length).toBeGreaterThan(0);
        expect(discardedCount).toBe(0);

        const central = matched[Math.floor(matched.length / 2)];
        const sBaja = central.slicesByBValue.get(bBaja)!;
        const sAlta = central.slicesByBValue.get(bAlta)!;
        const { threshold } = estimateNoiseThreshold(sBaja);

        const mapas = computeTwoPointMaps(sBaja, sAlta, bBaja, bAlta, 2000, threshold);

        let dentroDeMascara = 0;
        let sumaAdc = 0;
        for (let i = 0; i < mapas.mask.length; i++) {
          if (mapas.mask[i] === 1) {
            dentroDeMascara++;
            sumaAdc += mapas.adc[i];
          }
        }

        // Con una máscara de fondo razonable, el tejido ocupa buena parte del corte.
        const fraccion = dentroDeMascara / mapas.mask.length;
        expect(fraccion).toBeGreaterThan(0.05);

        // ADC medio de tejido: del orden de 1e-3 mm²/s.
        const adcMedio = sumaAdc / dentroDeMascara;
        expect(adcMedio).toBeGreaterThan(0.0001);
        expect(adcMedio).toBeLessThan(0.0035);
      });

      it('exporta un mapa ADC que se vuelve a leer correctamente', async () => {
        const { diffusion } = groupAndAverageSlices(cortes);
        const valoresB = [...new Set([...diffusion.values()].map(g => g.metadata.bValue))]
          .sort((a, b) => a - b);
        const bBaja = valoresB[0];
        const bAlta = valoresB[valoresB.length - 1];

        const { matched } = matchSlices(diffusion, [bBaja, bAlta]);
        const central = matched[Math.floor(matched.length / 2)];
        const sBaja = central.slicesByBValue.get(bBaja)!;
        const sAlta = central.slicesByBValue.get(bAlta)!;
        const { threshold } = estimateNoiseThreshold(sBaja);
        const mapas = computeTwoPointMaps(sBaja, sAlta, bBaja, bAlta, 2000, threshold);

        const seriesUID = '1.2.826.0.1.3680043.10.1338.1';
        const sopUID = '1.2.826.0.1.3680043.10.1338.2';
        const { buffer, saturatedCount } = await createDerivedDicom(
          sBaja,
          mapas.adc,
          'ADC',
          { bLow: bBaja, bHigh: bAlta, bTarget: 2000, threshold, registration: 'translation' },
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
