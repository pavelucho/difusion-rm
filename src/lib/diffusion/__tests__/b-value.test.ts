import { describe, it, expect } from 'vitest';
import type { DataSet } from 'dicom-parser';
import { readBValue, readNumericTag } from '../b-value';

/**
 * Construye un DataSet mínimo con el comportamiento que importa aquí: cada tag
 * tiene bytes reales, y los accesores los interpretan como lo haría dicom-parser
 * —incluido `string()` sobre un tag binario, que devuelve texto sin sentido.
 */
function crearDataSet(
  tags: Record<string, { vr?: string; bytes: Uint8Array }>
): DataSet {
  const partes: number[] = [];
  const elements: Record<string, { tag: string; vr?: string; length: number; dataOffset: number }> = {};

  for (const [tag, { vr, bytes }] of Object.entries(tags)) {
    elements[tag] = { tag, vr, length: bytes.length, dataOffset: partes.length };
    partes.push(...bytes);
  }

  const byteArray = new Uint8Array(partes);
  const vista = new DataView(byteArray.buffer);

  const dataSet = {
    byteArray,
    elements,
    string(tag: string) {
      const el = elements[tag];
      if (!el) return undefined;
      let texto = '';
      for (let i = el.dataOffset; i < el.dataOffset + el.length; i++) {
        texto += String.fromCharCode(byteArray[i]);
      }
      return texto.replace(/\0+$/, '').trim();
    },
    double(tag: string) {
      const el = elements[tag];
      return el ? vista.getFloat64(el.dataOffset, true) : undefined;
    },
    float(tag: string) {
      const el = elements[tag];
      return el ? vista.getFloat32(el.dataOffset, true) : undefined;
    },
    uint16(tag: string) {
      const el = elements[tag];
      return el ? vista.getUint16(el.dataOffset, true) : undefined;
    },
    int16(tag: string) {
      const el = elements[tag];
      return el ? vista.getInt16(el.dataOffset, true) : undefined;
    },
    uint32(tag: string) {
      const el = elements[tag];
      return el ? vista.getUint32(el.dataOffset, true) : undefined;
    },
    int32(tag: string) {
      const el = elements[tag];
      return el ? vista.getInt32(el.dataOffset, true) : undefined;
    },
  };

  return dataSet as unknown as DataSet;
}

function fd(valor: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, valor, true);
  return bytes;
}

function fl(valor: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, valor, true);
  return bytes;
}

function texto(valor: string): Uint8Array {
  const relleno = valor.length % 2 === 0 ? valor : valor + ' ';
  return new Uint8Array([...relleno].map(c => c.charCodeAt(0)));
}

describe('readNumericTag', () => {
  it('lee un tag FD como número, no como texto', () => {
    const ds = crearDataSet({ x00189087: { vr: 'FD', bytes: fd(800) } });
    expect(ds.string('x00189087')).not.toBe('800'); // así lo leía el código anterior
    expect(readNumericTag(ds, 'x00189087')).toBe(800);
  });

  it('lee un tag FL como número', () => {
    const ds = crearDataSet({ x20011003: { vr: 'FL', bytes: fl(1400) } });
    expect(readNumericTag(ds, 'x20011003')).toBe(1400);
  });

  it('lee un tag de texto DS', () => {
    const ds = crearDataSet({ x0019100c: { vr: 'IS', bytes: texto('1000') } });
    expect(readNumericTag(ds, 'x0019100c')).toBe(1000);
  });

  it('distingue texto de binario cuando el VR no está declarado', () => {
    // "1000" en VR implícito ocupa los mismos 4 bytes que un float.
    const comoTexto = crearDataSet({ x0019100c: { bytes: texto('1000') } });
    expect(readNumericTag(comoTexto, 'x0019100c')).toBe(1000);

    const comoFloat = crearDataSet({ x20011003: { bytes: fl(1000) } });
    expect(readNumericTag(comoFloat, 'x20011003')).toBe(1000);
  });

  it('devuelve undefined para un tag ausente o vacío', () => {
    const ds = crearDataSet({ x0019100c: { vr: 'IS', bytes: new Uint8Array(0) } });
    expect(readNumericTag(ds, 'x0019100c')).toBeUndefined();
    expect(readNumericTag(ds, 'x00189087')).toBeUndefined();
  });
});

describe('readBValue', () => {
  it('prefiere el tag estándar (0018,9087)', () => {
    const ds = crearDataSet({
      x00189087: { vr: 'FD', bytes: fd(800) },
      x0019100c: { vr: 'IS', bytes: texto('50') },
    });
    expect(readBValue(ds)).toEqual({ value: 800, source: 'estandar', inferred: false });
  });

  it('cae al tag de Siemens cuando no hay tag estándar', () => {
    const ds = crearDataSet({ x0019100c: { vr: 'IS', bytes: texto('1000') } });
    expect(readBValue(ds)).toEqual({ value: 1000, source: 'siemens', inferred: false });
  });

  it('recorta el desplazamiento de 1e9 del tag de GE', () => {
    const ds = crearDataSet({ x00431039: { vr: 'IS', bytes: texto('1000000800\\8\\0\\0') } });
    expect(readBValue(ds)).toEqual({ value: 800, source: 'ge', inferred: false });
  });

  it('lee el tag de GE sin desplazamiento', () => {
    const ds = crearDataSet({ x00431039: { vr: 'IS', bytes: texto('800\\8\\0\\0') } });
    expect(readBValue(ds)).toEqual({ value: 800, source: 'ge', inferred: false });
  });

  it('deduce del nombre de secuencia de Siemens y lo marca como inferido', () => {
    const ds = crearDataSet({ x00180024: { vr: 'SH', bytes: texto('*ep_b1000') } });
    expect(readBValue(ds)).toEqual({ value: 1000, source: 'nombre-secuencia', inferred: true });
  });

  it('deduce de la descripción de serie como último recurso', () => {
    const ds = crearDataSet({ x0008103e: { vr: 'LO', bytes: texto('DWI tra b=1400') } });
    expect(readBValue(ds)).toEqual({ value: 1400, source: 'descripcion', inferred: true });
  });

  it('sigue buscando cuando el tag estándar es ilegible en lugar de darlo por leído', () => {
    // Un (0018,9087) vacío es justo lo que rompía antes: parseFloat("") daba NaN,
    // que no es undefined, y los respaldos de fabricante nunca se probaban.
    const ds = crearDataSet({
      x00189087: { vr: 'FD', bytes: new Uint8Array(0) },
      x0019100c: { vr: 'IS', bytes: texto('1000') },
    });
    expect(readBValue(ds).value).toBe(1000);
  });

  it('descarta valores fuera de rango y avisa de que no hay valor b', () => {
    const ds = crearDataSet({ x00189087: { vr: 'FD', bytes: fd(999999) } });
    expect(readBValue(ds)).toEqual({ value: 0, source: 'ausente', inferred: true });
  });

  it('acepta b = 0 como valor legítimo', () => {
    const ds = crearDataSet({ x0019100c: { vr: 'IS', bytes: texto('0') } });
    expect(readBValue(ds)).toEqual({ value: 0, source: 'siemens', inferred: false });
  });
});
