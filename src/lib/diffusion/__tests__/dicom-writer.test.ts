import { describe, it, expect } from 'vitest';
import { parseDicom } from '../dicom-reader';
import { createDerivedDicom } from '../dicom-writer';
import type { AveragedSlice } from '../types';
import { AXIAL, dicomSintetico, imagen, posicionEn } from './dicom-sintetico';

/**
 * Lo que declaran los mapas exportados. QIBA pide que un mapa ADC diga con qué
 * valores b y con qué algoritmo se generó, y que se pueda rastrear después.
 */
function corteDeOrigen(): AveragedSlice {
  const slice = parseDicom(
    dicomSintetico({
      serieUID: '1.2.826.0.1.3680043.10.1338.3',
      descripcion: 'ep2d_diff_TRACEW',
      marcoReferencia: '1.2.826.0.1.3680043.10.1338.5',
      orientacion: AXIAL,
      posicion: posicionEn(AXIAL, 0),
      filas: 16,
      columnas: 16,
      bSiemens: 50,
      pixeles: imagen(16, 16, () => 1000),
    })
  );
  return { ...slice, count: 1 };
}

async function exportar(
  mapa: 'ADC' | 'EADC' | 'CDWI',
  params: { bLow: number; bHigh: number; bValues?: number[] }
) {
  const { buffer } = await createDerivedDicom(
    corteDeOrigen(),
    new Float32Array(256).fill(0.001),
    mapa,
    { ...params, bTarget: 2000, threshold: 10, registration: 'none' },
    '1.2.826.0.1.3680043.10.1338.10',
    '1.2.826.0.1.3680043.10.1338.11'
  );
  const releido = parseDicom(buffer);
  return {
    descripcion: releido.metadata.seriesDescription,
    derivacion: releido.metadata.dataset.string('x00082111') as string,
  };
}

describe('descripción de los mapas exportados', () => {
  it('declara los valores b y el ajuste sin ponderar en el multi-b', async () => {
    const adc = await exportar('ADC', { bLow: 50, bHigh: 800, bValues: [50, 400, 800] });
    expect(adc.descripcion).toBe('ADC calc multi-b (b=50,400,800)');
    expect(adc.derivacion).toContain('unweighted least-squares fit of ln S vs b (b=50,400,800)');

    const eadc = await exportar('EADC', { bLow: 50, bHigh: 800, bValues: [50, 400, 800] });
    expect(eadc.descripcion).toBe('eADC calc multi-b (b=50,400,800)');
    expect(eadc.derivacion).toContain('eADC = exp(-800 * ADC)');
  });

  it('no marca como aviso una b baja por debajo de 150', async () => {
    const adc = await exportar('ADC', { bLow: 0, bHigh: 1000 });
    expect(adc.descripcion).toBe('ADC calc (b=0,1000)');
    expect(adc.derivacion).toContain('ADC = ln(S(b=0)/S(b=1000))/(1000-0)');
  });
});
