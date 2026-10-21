/**
 * Lectura de un ZIP entrada por entrada, directamente desde el archivo.
 *
 * JSZip carga el ZIP entero en memoria antes de dar acceso a nada, y lo mantiene
 * mientras se usa. Un estudio completo exportado del PACS puede pesar más de un
 * giga comprimido, y en un equipo con el visor y el dictado abiertos eso basta
 * para quedarse sin RAM. Aquí solo se lee el índice del final del archivo, y
 * cada imagen se lee y se descomprime cuando se pide; el archivo sigue en disco
 * y se puede volver a leer al cambiar de serie.
 *
 * Cubre lo que producen los PACS y los compresores habituales: entradas sin
 * comprimir o con deflate, y ZIP64 para archivos de más de 4 GB o de más de
 * 65 535 entradas. Lo que no reconoce lo rechaza con `ZipNoLegibleError`, y
 * quien llama puede recurrir a JSZip.
 */

export interface EntradaZip {
  nombre: string;
  /** 0: sin comprimir; 8: deflate. */
  metodo: number;
  tamanoComprimido: number;
  /** Desplazamiento de la cabecera local de la entrada dentro del archivo. */
  desplazamiento: number;
}

export class ZipNoLegibleError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ZipNoLegibleError';
  }
}

const FIN_DIRECTORIO = 0x06054b50;
const LOCALIZADOR_ZIP64 = 0x07064b50;
const FIN_DIRECTORIO_ZIP64 = 0x06064b50;
const ENTRADA_DIRECTORIO = 0x02014b50;
const CABECERA_LOCAL = 0x04034b50;
const EXTRA_ZIP64 = 0x0001;
/** 22 bytes del registro final más el comentario más largo posible. */
const COLA_MAXIMA = 22 + 0xffff;

async function bytes(archivo: Blob, desde: number, hasta: number): Promise<DataView> {
  return new DataView(await archivo.slice(desde, hasta).arrayBuffer());
}

function numero64(vista: DataView, posicion: number): number {
  const valor = vista.getBigUint64(posicion, true);
  if (valor > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipNoLegibleError('Desplazamiento ZIP64 fuera de rango.');
  return Number(valor);
}

/** El índice del ZIP: una entrada por archivo, sin las carpetas ni las cifradas. */
export async function leerIndiceZip(archivo: Blob): Promise<EntradaZip[]> {
  const inicioCola = Math.max(0, archivo.size - COLA_MAXIMA);
  const cola = await bytes(archivo, inicioCola, archivo.size);

  // El registro final se busca desde atrás: puede ir seguido de un comentario.
  let fin = -1;
  for (let i = cola.byteLength - 22; i >= 0; i--) {
    if (cola.getUint32(i, true) === FIN_DIRECTORIO) {
      fin = i;
      break;
    }
  }
  if (fin < 0) throw new ZipNoLegibleError('No es un ZIP: falta el registro final del directorio.');

  let total = cola.getUint16(fin + 10, true);
  let tamanoDirectorio = cola.getUint32(fin + 12, true);
  let inicioDirectorio = cola.getUint32(fin + 16, true);

  if (total === 0xffff || tamanoDirectorio === 0xffffffff || inicioDirectorio === 0xffffffff) {
    const localizador = fin - 20;
    if (localizador < 0 || cola.getUint32(localizador, true) !== LOCALIZADOR_ZIP64) {
      throw new ZipNoLegibleError('ZIP64 sin localizador del registro final.');
    }
    const posicionFin64 = numero64(cola, localizador + 8);
    const fin64 = await bytes(archivo, posicionFin64, posicionFin64 + 56);
    if (fin64.getUint32(0, true) !== FIN_DIRECTORIO_ZIP64) {
      throw new ZipNoLegibleError('ZIP64 con el registro final dañado.');
    }
    total = numero64(fin64, 32);
    tamanoDirectorio = numero64(fin64, 40);
    inicioDirectorio = numero64(fin64, 48);
  }

  if (inicioDirectorio + tamanoDirectorio > archivo.size) {
    throw new ZipNoLegibleError('El directorio del ZIP apunta fuera del archivo: está truncado.');
  }

  const directorio = await bytes(archivo, inicioDirectorio, inicioDirectorio + tamanoDirectorio);
  const decodificador = new TextDecoder('utf-8');
  const entradas: EntradaZip[] = [];
  let p = 0;

  for (let n = 0; n < total; n++) {
    if (p + 46 > directorio.byteLength || directorio.getUint32(p, true) !== ENTRADA_DIRECTORIO) {
      throw new ZipNoLegibleError('Directorio del ZIP dañado.');
    }
    const indicadores = directorio.getUint16(p + 8, true);
    const metodo = directorio.getUint16(p + 10, true);
    let tamanoComprimido = directorio.getUint32(p + 20, true);
    let tamanoOriginal = directorio.getUint32(p + 24, true);
    const largoNombre = directorio.getUint16(p + 28, true);
    const largoExtra = directorio.getUint16(p + 30, true);
    const largoComentario = directorio.getUint16(p + 32, true);
    let desplazamiento = directorio.getUint32(p + 42, true);

    const nombre = decodificador.decode(
      new Uint8Array(directorio.buffer, directorio.byteOffset + p + 46, largoNombre)
    );

    // En ZIP64 los campos que no caben valen 0xFFFFFFFF y el valor real va en el
    // campo extra, en este orden y solo los que faltan.
    let e = p + 46 + largoNombre;
    const finExtra = e + largoExtra;
    while (e + 4 <= finExtra) {
      const id = directorio.getUint16(e, true);
      const largo = directorio.getUint16(e + 2, true);
      if (id === EXTRA_ZIP64) {
        let q = e + 4;
        if (tamanoOriginal === 0xffffffff) { tamanoOriginal = numero64(directorio, q); q += 8; }
        if (tamanoComprimido === 0xffffffff) { tamanoComprimido = numero64(directorio, q); q += 8; }
        if (desplazamiento === 0xffffffff) { desplazamiento = numero64(directorio, q); }
      }
      e += 4 + largo;
    }

    p = finExtra + largoComentario;

    const esCarpeta = nombre.endsWith('/');
    const cifrada = (indicadores & 1) === 1;
    if (esCarpeta || cifrada) continue;
    entradas.push({ nombre, metodo, tamanoComprimido, desplazamiento });
  }

  return entradas;
}

/** Contenido descomprimido de una entrada. */
export async function leerEntradaZip(archivo: Blob, entrada: EntradaZip): Promise<ArrayBuffer> {
  const local = await bytes(archivo, entrada.desplazamiento, entrada.desplazamiento + 30);
  if (local.getUint32(0, true) !== CABECERA_LOCAL) {
    throw new ZipNoLegibleError(`Entrada «${entrada.nombre}» dañada.`);
  }
  // El nombre y el extra de la cabecera local pueden no coincidir con los del
  // directorio, así que el comienzo de los datos se calcula con los de aquí.
  const inicio = entrada.desplazamiento + 30 + local.getUint16(26, true) + local.getUint16(28, true);
  const datos = archivo.slice(inicio, inicio + entrada.tamanoComprimido);

  if (entrada.metodo === 0) return datos.arrayBuffer();
  if (entrada.metodo === 8) {
    const flujo = datos.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(flujo).arrayBuffer();
  }
  throw new ZipNoLegibleError(`Entrada «${entrada.nombre}» con un método de compresión no soportado (${entrada.metodo}).`);
}

/** ¿Puede este navegador descomprimir sin cargar el ZIP entero? */
export function hayDescompresionNativa(): boolean {
  // Chrome 80 a 102 tienen DecompressionStream pero no el formato sin cabecera.
  try {
    new DecompressionStream('deflate-raw');
    return true;
  } catch {
    return false;
  }
}
