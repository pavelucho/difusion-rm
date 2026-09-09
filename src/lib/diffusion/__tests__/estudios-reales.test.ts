import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseDicom } from '../dicom-reader';
import { groupAndAverageSlices, matchSlices } from '../series-builder';
import { computeTwoPointMaps, estimateNoiseThreshold } from '../maps';
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
      const cortes = leerEstudio(estudio.ruta);

      it('lee todas las imágenes sin fallar', () => {
        expect(cortes.length).toBeGreaterThan(0);
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
        const grupos = groupAndAverageSlices(cortes);
        const valoresB = [...new Set(
          [...grupos.values()].filter(g => !g.metadata.isVendorADC).map(g => g.metadata.bValue)
        )].sort((a, b) => a - b);

        const bBaja = valoresB[0];
        const bAlta = valoresB[valoresB.length - 1];

        const { matched, discardedCount } = matchSlices(grupos, [bBaja, bAlta]);
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
    });
  }
});
