import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { leerEntradaZip, leerIndiceZip, ZipNoLegibleError } from '../zip-lectura';

/**
 * El ZIP se lee entrada por entrada desde el archivo, sin cargarlo entero. Lo
 * que se lee tiene que ser byte a byte lo que se guardó, con o sin compresión.
 */

function contenido(semilla: number, largo: number): Uint8Array {
  const bytes = new Uint8Array(largo);
  let x = semilla;
  for (let i = 0; i < largo; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    // Mitad repetitiva y mitad aleatoria, para que deflate tenga algo que hacer.
    bytes[i] = i % 2 === 0 ? (i >> 4) & 0xff : x >>> 24;
  }
  return bytes;
}

async function leerTodo(zip: Blob): Promise<Map<string, Uint8Array>> {
  const salida = new Map<string, Uint8Array>();
  for (const entrada of await leerIndiceZip(zip)) {
    salida.set(entrada.nombre, new Uint8Array(await leerEntradaZip(zip, entrada)));
  }
  return salida;
}

describe('lectura de ZIP desde el archivo', () => {
  it.each(['DEFLATE', 'STORE'] as const)('devuelve las entradas intactas (%s)', async compresion => {
    const zip = new JSZip();
    const originales = new Map([
      ['DICOM/IM0001', contenido(1, 5000)],
      ['DICOM/S0001/IM0002.dcm', contenido(2, 70000)],
      ['DICOM/Ñandú/año 2026', contenido(3, 10)],
      ['vacío', new Uint8Array(0)],
    ]);
    for (const [nombre, datos] of originales) zip.file(nombre, datos);
    zip.folder('VISOR');
    const blob = await zip.generateAsync({ type: 'blob', compression: compresion, comment: 'Exportado del PACS' });

    const leidas = await leerTodo(blob);

    // Las carpetas no son entradas.
    expect([...leidas.keys()].sort()).toEqual([...originales.keys()].sort());
    for (const [nombre, datos] of originales) expect(leidas.get(nombre)).toEqual(datos);
  });

  it('lee ZIP64, el formato de los archivos de más de 4 GB o de 65 535 entradas', async () => {
    const datos = contenido(4, 3000);
    const leidas = await leerTodo(zip64SinComprimir('DICOM/IM0001', datos));
    expect(leidas.get('DICOM/IM0001')).toEqual(datos);
  });

  it('rechaza lo que no es un ZIP, para que se pueda recurrir a JSZip', async () => {
    await expect(leerIndiceZip(new Blob([contenido(5, 1000)]))).rejects.toBeInstanceOf(ZipNoLegibleError);
  });

  it('rechaza un ZIP truncado', async () => {
    const zip = new JSZip();
    zip.file('IM0001', contenido(6, 4000));
    const completo = new Uint8Array(await zip.generateAsync({ type: 'uint8array' }));
    // Se conserva el registro final, pero el directorio queda fuera del archivo.
    const truncado = new Blob([completo.slice(completo.length - 22)]);
    await expect(leerIndiceZip(truncado)).rejects.toBeInstanceOf(ZipNoLegibleError);
  });
});

/**
 * Un ZIP64 de una sola entrada sin comprimir, con los tamaños y el desplazamiento
 * en el campo extra y el registro final ZIP64, como lo escriben 7-Zip o Windows
 * con archivos grandes. JSZip no sabe escribirlos.
 */
function zip64SinComprimir(nombre: string, datos: Uint8Array): Blob {
  const n = new TextEncoder().encode(nombre);
  const partes: Uint8Array[] = [];
  let posicion = 0;
  const poner = (bytes: Uint8Array) => {
    partes.push(bytes);
    posicion += bytes.length;
  };
  const registro = (largo: number, escribir: (v: DataView) => void) => {
    const bytes = new Uint8Array(largo);
    escribir(new DataView(bytes.buffer));
    return bytes;
  };
  const extra64 = (campos: number[]) =>
    registro(4 + campos.length * 8, v => {
      v.setUint16(0, 0x0001, true);
      v.setUint16(2, campos.length * 8, true);
      campos.forEach((c, i) => v.setBigUint64(4 + i * 8, BigInt(c), true));
    });

  const desplazamientoLocal = posicion;
  const extraLocal = extra64([datos.length, datos.length]);
  poner(registro(30, v => {
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 45, true);
    v.setUint32(18, 0xffffffff, true);
    v.setUint32(22, 0xffffffff, true);
    v.setUint16(26, n.length, true);
    v.setUint16(28, extraLocal.length, true);
  }));
  poner(n);
  poner(extraLocal);
  poner(datos);

  const inicioDirectorio = posicion;
  const extraCentral = extra64([datos.length, datos.length, desplazamientoLocal]);
  poner(registro(46, v => {
    v.setUint32(0, 0x02014b50, true);
    v.setUint16(4, 45, true);
    v.setUint16(6, 45, true);
    v.setUint32(20, 0xffffffff, true);
    v.setUint32(24, 0xffffffff, true);
    v.setUint16(28, n.length, true);
    v.setUint16(30, extraCentral.length, true);
    v.setUint32(42, 0xffffffff, true);
  }));
  poner(n);
  poner(extraCentral);
  const tamanoDirectorio = posicion - inicioDirectorio;

  const inicioFin64 = posicion;
  poner(registro(56, v => {
    v.setUint32(0, 0x06064b50, true);
    v.setBigUint64(4, 44n, true);
    v.setUint16(12, 45, true);
    v.setUint16(14, 45, true);
    v.setBigUint64(24, 1n, true);
    v.setBigUint64(32, 1n, true);
    v.setBigUint64(40, BigInt(tamanoDirectorio), true);
    v.setBigUint64(48, BigInt(inicioDirectorio), true);
  }));
  poner(registro(20, v => {
    v.setUint32(0, 0x07064b50, true);
    v.setBigUint64(8, BigInt(inicioFin64), true);
    v.setUint32(16, 1, true);
  }));
  poner(registro(22, v => {
    v.setUint32(0, 0x06054b50, true);
    v.setUint16(8, 0xffff, true);
    v.setUint16(10, 0xffff, true);
    v.setUint32(12, 0xffffffff, true);
    v.setUint32(16, 0xffffffff, true);
  }));

  return new Blob(partes);
}
