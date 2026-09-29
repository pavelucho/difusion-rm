/**
 * DICOM sintéticos para las pruebas: archivos Part 10 reales, en VR explícito
 * little endian, que pasan por el mismo lector que los del equipo. Llevan solo
 * los tags que la aplicación usa, con el VR y la forma en que los escriben GE y
 * Siemens, incluidos los tags privados de valor b.
 */

export interface CorteSintetico {
  serieUID: string;
  descripcion: string;
  numeroSerie?: number;
  instancia?: number;
  /** Componentes de (0008,0008), p. ej. ['ORIGINAL', 'PRIMARY', 'OTHER']. */
  tipoImagen?: string[];
  fabricante?: string;
  horaAdquisicion?: string;
  tr?: number;
  te?: number;
  /** (0018,9087) DiffusionBValue, FD. */
  bEstandar?: number;
  /** (0019,100C) de Siemens, IS. */
  bSiemens?: number;
  /** (0043,1039) de GE, IS multivalor: «1000\8\0\0». */
  bGE?: string;
  nombreSecuencia?: string;
  marcoReferencia: string;
  /** (0020,0037): fila y columna. */
  orientacion: number[];
  /** (0020,0032). */
  posicion: number[];
  filas: number;
  columnas: number;
  espaciado?: [number, number];
  /** Valores almacenados, antes de aplicar pendiente e intercepto. */
  pixeles: Uint16Array;
  pendiente?: number;
  intercepto?: number;
  tipoReescalado?: string;
}

export const AXIAL = [1, 0, 0, 0, 1, 0];
export const SAGITAL = [0, 1, 0, 0, 0, -1];
export const CORONAL = [1, 0, 0, 0, 0, -1];

/** Posición de un corte a la altura `z` en una orientación dada. */
export function posicionEn(orientacion: number[], z: number): number[] {
  const [rx, ry, rz, cx, cy, cz] = orientacion;
  const normal = [ry * cz - rz * cy, rz * cx - rx * cz, rx * cy - ry * cx];
  return normal.map(n => n * z);
}

const LARGOS = new Set(['OB', 'OW', 'OF', 'SQ', 'UT', 'UN']);

interface Elemento {
  grupo: number;
  elemento: number;
  vr: string;
  datos: Uint8Array;
}

function texto(valor: string, relleno = ' '): Uint8Array {
  const par = valor.length % 2 === 0 ? valor : valor + relleno;
  return new Uint8Array([...par].map(c => c.charCodeAt(0)));
}

function us(valor: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, valor, true);
  return bytes;
}

function ul(valor: number): Uint8Array {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, valor, true);
  return bytes;
}

function fd(valor: number): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setFloat64(0, valor, true);
  return bytes;
}

function codificar({ grupo, elemento, vr, datos }: Elemento): Uint8Array {
  const largo = LARGOS.has(vr);
  const cabecera = new Uint8Array(largo ? 12 : 8);
  const vista = new DataView(cabecera.buffer);
  vista.setUint16(0, grupo, true);
  vista.setUint16(2, elemento, true);
  cabecera[4] = vr.charCodeAt(0);
  cabecera[5] = vr.charCodeAt(1);
  if (largo) vista.setUint32(8, datos.length, true);
  else vista.setUint16(6, datos.length, true);
  return concatenar([cabecera, datos]);
}

function concatenar(partes: Uint8Array[]): Uint8Array {
  const total = partes.reduce((suma, p) => suma + p.length, 0);
  const salida = new Uint8Array(total);
  let desplazamiento = 0;
  for (const parte of partes) {
    salida.set(parte, desplazamiento);
    desplazamiento += parte.length;
  }
  return salida;
}

const numero = (v: number) => String(Number(v.toFixed(6)));

let contadorSop = 0;

export function dicomSintetico(c: CorteSintetico): ArrayBuffer {
  const sop = `1.2.826.0.1.3680043.10.1338.9.${++contadorSop}`;
  const elementos: Elemento[] = [
    { grupo: 0x0008, elemento: 0x0008, vr: 'CS', datos: texto((c.tipoImagen ?? ['ORIGINAL', 'PRIMARY', 'OTHER']).join('\\')) },
    { grupo: 0x0008, elemento: 0x0016, vr: 'UI', datos: texto('1.2.840.10008.5.1.4.1.1.4', '\0') },
    { grupo: 0x0008, elemento: 0x0018, vr: 'UI', datos: texto(sop, '\0') },
    { grupo: 0x0008, elemento: 0x0060, vr: 'CS', datos: texto('MR') },
    { grupo: 0x0008, elemento: 0x0070, vr: 'LO', datos: texto(c.fabricante ?? 'SIEMENS') },
    { grupo: 0x0008, elemento: 0x103e, vr: 'LO', datos: texto(c.descripcion) },
    { grupo: 0x0020, elemento: 0x000d, vr: 'UI', datos: texto('1.2.826.0.1.3680043.10.1338.7', '\0') },
    { grupo: 0x0020, elemento: 0x000e, vr: 'UI', datos: texto(c.serieUID, '\0') },
    { grupo: 0x0020, elemento: 0x0011, vr: 'IS', datos: texto(String(c.numeroSerie ?? 1)) },
    { grupo: 0x0020, elemento: 0x0013, vr: 'IS', datos: texto(String(c.instancia ?? 1)) },
    { grupo: 0x0020, elemento: 0x0032, vr: 'DS', datos: texto(c.posicion.map(numero).join('\\')) },
    { grupo: 0x0020, elemento: 0x0037, vr: 'DS', datos: texto(c.orientacion.map(numero).join('\\')) },
    { grupo: 0x0020, elemento: 0x0052, vr: 'UI', datos: texto(c.marcoReferencia, '\0') },
    { grupo: 0x0028, elemento: 0x0002, vr: 'US', datos: us(1) },
    { grupo: 0x0028, elemento: 0x0004, vr: 'CS', datos: texto('MONOCHROME2') },
    { grupo: 0x0028, elemento: 0x0010, vr: 'US', datos: us(c.filas) },
    { grupo: 0x0028, elemento: 0x0011, vr: 'US', datos: us(c.columnas) },
    { grupo: 0x0028, elemento: 0x0030, vr: 'DS', datos: texto((c.espaciado ?? [1, 1]).map(numero).join('\\')) },
    { grupo: 0x0028, elemento: 0x0100, vr: 'US', datos: us(16) },
    { grupo: 0x0028, elemento: 0x0101, vr: 'US', datos: us(16) },
    { grupo: 0x0028, elemento: 0x0102, vr: 'US', datos: us(15) },
    { grupo: 0x0028, elemento: 0x0103, vr: 'US', datos: us(0) },
    { grupo: 0x0028, elemento: 0x1052, vr: 'DS', datos: texto(numero(c.intercepto ?? 0)) },
    { grupo: 0x0028, elemento: 0x1053, vr: 'DS', datos: texto(numero(c.pendiente ?? 1)) },
    { grupo: 0x7fe0, elemento: 0x0010, vr: 'OW', datos: new Uint8Array(c.pixeles.buffer, c.pixeles.byteOffset, c.pixeles.byteLength) },
  ];

  if (c.horaAdquisicion) elementos.push({ grupo: 0x0008, elemento: 0x0032, vr: 'TM', datos: texto(c.horaAdquisicion) });
  if (c.nombreSecuencia) elementos.push({ grupo: 0x0018, elemento: 0x0024, vr: 'SH', datos: texto(c.nombreSecuencia) });
  if (c.tr !== undefined) elementos.push({ grupo: 0x0018, elemento: 0x0080, vr: 'DS', datos: texto(numero(c.tr)) });
  if (c.te !== undefined) elementos.push({ grupo: 0x0018, elemento: 0x0081, vr: 'DS', datos: texto(numero(c.te)) });
  if (c.bEstandar !== undefined) elementos.push({ grupo: 0x0018, elemento: 0x9087, vr: 'FD', datos: fd(c.bEstandar) });
  if (c.bSiemens !== undefined) {
    elementos.push({ grupo: 0x0019, elemento: 0x0010, vr: 'LO', datos: texto('SIEMENS MR HEADER') });
    elementos.push({ grupo: 0x0019, elemento: 0x100c, vr: 'IS', datos: texto(String(c.bSiemens)) });
  }
  if (c.bGE !== undefined) {
    elementos.push({ grupo: 0x0043, elemento: 0x0010, vr: 'LO', datos: texto('GEMS_PARM_01') });
    elementos.push({ grupo: 0x0043, elemento: 0x1039, vr: 'IS', datos: texto(c.bGE) });
  }
  if (c.tipoReescalado) elementos.push({ grupo: 0x0028, elemento: 0x1054, vr: 'LO', datos: texto(c.tipoReescalado) });

  elementos.sort((a, b) => a.grupo - b.grupo || a.elemento - b.elemento);

  const meta = concatenar([
    codificar({ grupo: 0x0002, elemento: 0x0001, vr: 'OB', datos: new Uint8Array([0, 1]) }),
    codificar({ grupo: 0x0002, elemento: 0x0002, vr: 'UI', datos: texto('1.2.840.10008.5.1.4.1.1.4', '\0') }),
    codificar({ grupo: 0x0002, elemento: 0x0003, vr: 'UI', datos: texto(sop, '\0') }),
    codificar({ grupo: 0x0002, elemento: 0x0010, vr: 'UI', datos: texto('1.2.840.10008.1.2.1', '\0') }),
  ]);
  const longitudMeta = codificar({ grupo: 0x0002, elemento: 0x0000, vr: 'UL', datos: ul(meta.length) });

  const preambulo = new Uint8Array(132);
  preambulo.set([0x44, 0x49, 0x43, 0x4d], 128); // «DICM»

  const archivo = concatenar([preambulo, longitudMeta, meta, ...elementos.map(codificar)]);
  return archivo.buffer.slice(archivo.byteOffset, archivo.byteOffset + archivo.byteLength) as ArrayBuffer;
}

/**
 * Imagen de prueba: un disco de «tejido» centrado y fondo con un ruido pequeño y
 * determinista, para que el umbral de ruido se estime como en una imagen real.
 */
export function imagen(
  filas: number,
  columnas: number,
  senal: (x: number, y: number) => number
): Uint16Array {
  const pixeles = new Uint16Array(filas * columnas);
  const radio = Math.min(filas, columnas) * 0.3;
  for (let y = 0; y < filas; y++) {
    for (let x = 0; x < columnas; x++) {
      const dentro = Math.hypot(x - columnas / 2, y - filas / 2) < radio;
      const valor = dentro ? senal(x, y) : 10 + ((x * 7 + y * 13) % 5);
      pixeles[y * columnas + x] = Math.max(0, Math.min(65535, Math.round(valor)));
    }
  }
  return pixeles;
}

/** ¿Está el píxel dentro del disco de tejido de `imagen`? */
export function enTejido(indice: number, filas: number, columnas: number): boolean {
  const x = indice % columnas;
  const y = Math.floor(indice / columnas);
  return Math.hypot(x - columnas / 2, y - filas / 2) < Math.min(filas, columnas) * 0.3 - 1;
}
