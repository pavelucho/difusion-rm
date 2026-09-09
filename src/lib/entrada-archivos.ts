/**
 * Entrada de archivos pensada para cómo llega un estudio en la práctica: una
 * carpeta copiada del PACS, el contenido de un CD, un ZIP, o los archivos sueltos
 * arrastrados a la ventana. Quien usa la herramienta no tiene por qué comprimir
 * nada antes.
 */

/** Extensiones que no son imágenes y aparecen en los CD de estudios. */
const DESCARTABLES =
  /\.(zip|7z|rar|gz|tar|txt|pdf|rtf|docx?|html?|xml|json|css|js|ini|inf|cfg|log|exe|msi|dmg|pkg|app|dll|so|dylib|bat|sh|jpe?g|png|gif|bmp|tiff?|mp4|avi|mov|db|sqlite|ds_store)$/i;

export function esZip(archivo: File): boolean {
  return /\.zip$/i.test(archivo.name) || archivo.type === 'application/zip';
}

/**
 * Filtro por nombre, aplicable antes de leer el contenido.
 *
 * Los estudios exportados de un PACS traen dentro el visor de escritorio, sus
 * instaladores, informes en PDF y fotos sueltas. Descomprimir un instalador de
 * cientos de megas para descubrir que no es una imagen es tiempo y memoria
 * tirados, así que se descarta por el nombre antes de tocarlo.
 */
export function nombrePuedeSerDicom(ruta: string): boolean {
  const nombre = ruta.split('/').pop() ?? ruta;
  if (!nombre || nombre.startsWith('.')) return false;
  if (nombre.toUpperCase() === 'DICOMDIR') return false;
  return !DESCARTABLES.test(nombre);
}

/**
 * Los DICOM de un CD suelen no tener extensión (IM_0001, 00000001) o usar .dcm.
 * Se descarta lo que claramente no es imagen y se deja pasar el resto: quien
 * decide de verdad es el lector, que rechaza lo que no puede interpretar.
 */
export function puedeSerDicom(archivo: File): boolean {
  if (!nombrePuedeSerDicom(archivo.name)) return false;
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
