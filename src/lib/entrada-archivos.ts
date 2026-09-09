/**
 * Entrada de archivos pensada para cómo llega un estudio en la práctica: una
 * carpeta copiada del PACS, el contenido de un CD, un ZIP, o los archivos sueltos
 * arrastrados a la ventana. Quien usa la herramienta no tiene por qué comprimir
 * nada antes.
 */

/** Extensiones que no son imágenes y aparecen en los CD de estudios. */
const DESCARTABLES = /\.(zip|txt|pdf|html?|xml|ini|inf|exe|dll|jpe?g|png|gif|db|ds_store)$/i;

export function esZip(archivo: File): boolean {
  return /\.zip$/i.test(archivo.name) || archivo.type === 'application/zip';
}

/**
 * Los DICOM de un CD suelen no tener extensión (IM_0001, 00000001) o usar .dcm.
 * Se descarta lo que claramente no es imagen y se deja pasar el resto: quien
 * decide de verdad es el lector, que rechaza lo que no puede interpretar.
 */
export function puedeSerDicom(archivo: File): boolean {
  if (archivo.name.startsWith('.')) return false;
  if (DESCARTABLES.test(archivo.name)) return false;
  return archivo.size > 132; // por debajo del preámbulo DICOM no cabe una imagen
}

/**
 * Extrae los archivos de un arrastre, entrando en las carpetas.
 *
 * `dataTransfer.files` solo trae las carpetas como entradas vacías, así que hay
 * que recorrer el árbol con la API de entradas para que arrastrar la carpeta del
 * estudio funcione igual que arrastrar los archivos.
 */
export async function archivosDesdeArrastre(dataTransfer: DataTransfer): Promise<File[]> {
  const entradas: FileSystemEntry[] = [];

  for (const item of Array.from(dataTransfer.items)) {
    if (item.kind !== 'file') continue;
    const entrada = item.webkitGetAsEntry?.();
    if (entrada) entradas.push(entrada);
  }

  if (entradas.length === 0) {
    return Array.from(dataTransfer.files);
  }

  const archivos: File[] = [];
  await Promise.all(entradas.map(entrada => recorrer(entrada, archivos)));
  return archivos;
}

async function recorrer(entrada: FileSystemEntry, destino: File[]): Promise<void> {
  if (entrada.isFile) {
    const archivo = await new Promise<File | null>(resolve => {
      (entrada as FileSystemFileEntry).file(
        f => resolve(f),
        () => resolve(null)
      );
    });
    if (archivo) destino.push(archivo);
    return;
  }

  if (!entrada.isDirectory) return;

  const lector = (entrada as FileSystemDirectoryEntry).createReader();
  // readEntries devuelve como mucho 100 entradas por llamada: hay que insistir
  // hasta que devuelva una tanda vacía, o los estudios grandes llegan truncados.
  for (;;) {
    const tanda = await new Promise<FileSystemEntry[]>(resolve => {
      lector.readEntries(
        e => resolve(e),
        () => resolve([])
      );
    });
    if (tanda.length === 0) break;
    await Promise.all(tanda.map(hija => recorrer(hija, destino)));
  }
}

export interface EntradaClasificada {
  tipo: 'zip' | 'archivos';
  zip?: File;
  archivos: File[];
}

/**
 * Decide qué hacer con lo que se ha soltado o elegido: un único ZIP se
 * descomprime, y en cualquier otro caso se leen los archivos directamente.
 */
export function clasificarEntrada(archivos: File[]): EntradaClasificada {
  const zips = archivos.filter(esZip);

  if (zips.length === 1 && archivos.length === 1) {
    return { tipo: 'zip', zip: zips[0], archivos: [] };
  }

  return { tipo: 'archivos', archivos: archivos.filter(puedeSerDicom) };
}
