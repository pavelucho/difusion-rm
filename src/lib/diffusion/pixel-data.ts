import dicomParser, { type ByteArray, type DataSet, type Element } from 'dicom-parser';
import { Decoder as JpegLosslessDecoder } from 'jpeg-lossless-decoder-js';

/** Transfer syntaxes que esta aplicación sabe leer, con su nombre para los avisos. */
const SIN_COMPRIMIR: Record<string, string> = {
  '1.2.840.10008.1.2': 'VR implícito little endian',
  '1.2.840.10008.1.2.1': 'VR explícito little endian',
  '1.2.840.10008.1.2.2': 'VR explícito big endian',
};

const JPEG_SIN_PERDIDA: Record<string, string> = {
  '1.2.840.10008.1.2.4.57': 'JPEG sin pérdida',
  '1.2.840.10008.1.2.4.70': 'JPEG sin pérdida SV1',
};

/** Comprimidas que aún no se decodifican, nombradas para poder decirlo con precisión. */
const NO_SOPORTADAS: Record<string, string> = {
  '1.2.840.10008.1.2.1.99': 'Deflated',
  '1.2.840.10008.1.2.4.50': 'JPEG baseline',
  '1.2.840.10008.1.2.4.51': 'JPEG extendido',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS sin pérdida',
  '1.2.840.10008.1.2.4.81': 'JPEG-LS casi sin pérdida',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000 sin pérdida',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000',
  '1.2.840.10008.1.2.5': 'RLE',
};

export class DicomNoSoportadoError extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'DicomNoSoportadoError';
  }
}

export interface PixelReadOptions {
  /** Fotograma a extraer en imágenes multifotograma. Por defecto, el primero. */
  frameIndex?: number;
}

/**
 * Devuelve las muestras de un fotograma tal como las almacenó el equipo, sin
 * aplicar rescale: eso lo hace quien llama, que conoce pendiente y ordenada.
 *
 * Lanza `DicomNoSoportadoError` cuando el archivo usa una compresión que todavía
 * no se decodifica. Es deliberado: antes se leían los bytes del flujo comprimido
 * como si fueran píxeles, y el mapa de ADC salía de ruido sin que nada avisara.
 */
export function readPixelSamples(
  dataset: DataSet,
  options: PixelReadOptions = {}
): Int16Array | Uint16Array | Int8Array | Uint8Array {
  const transferSyntax = dataset.string('x00020010') ?? '1.2.840.10008.1.2';
  const frameIndex = options.frameIndex ?? 0;

  const element = dataset.elements.x7fe00010;
  if (!element) {
    throw new DicomNoSoportadoError('El archivo no contiene datos de imagen.');
  }

  if (JPEG_SIN_PERDIDA[transferSyntax]) {
    return decodeJpegLossless(dataset, frameIndex);
  }

  if (NO_SOPORTADAS[transferSyntax]) {
    throw new DicomNoSoportadoError(
      `Compresión ${NO_SOPORTADAS[transferSyntax]} todavía no soportada. ` +
        'Convierta la serie a DICOM sin comprimir antes de procesarla.'
    );
  }

  if (!SIN_COMPRIMIR[transferSyntax]) {
    throw new DicomNoSoportadoError(
      `Transfer syntax desconocida (${transferSyntax}). No se puede leer la imagen con seguridad.`
    );
  }

  return readNativeSamples(dataset, element, frameIndex, transferSyntax);
}

function decodeJpegLossless(
  dataset: DataSet,
  frameIndex: number
): Int16Array | Uint16Array | Uint8Array {
  const element = dataset.elements.x7fe00010;
  const encoded = readEncapsulatedFrame(dataset, element, frameIndex);

  const decoded = new JpegLosslessDecoder().decode(
    encoded.buffer,
    encoded.byteOffset,
    encoded.length
  );

  const expected = expectedSampleCount(dataset);
  if (decoded.length !== expected) {
    throw new DicomNoSoportadoError(
      `El fotograma decodificado tiene ${decoded.length} muestras y se esperaban ${expected}.`
    );
  }

  // El decodificador entrega siempre muestras sin signo; se reinterpretan cuando
  // el archivo declara representación con signo.
  if (dataset.uint16('x00280103') === 1 && decoded.BYTES_PER_ELEMENT === 2) {
    return new Int16Array(decoded.buffer, decoded.byteOffset, decoded.length);
  }

  return decoded;
}

/**
 * Extrae los bytes comprimidos de un fotograma encapsulado.
 *
 * Muchos equipos —el caso habitual en GE— dejan la Basic Offset Table vacía, y
 * entonces `readEncapsulatedImageFrame` no sabe dónde empieza cada fotograma. En
 * ese caso se reconstruye la tabla a partir de las marcas de inicio de imagen
 * JPEG, y si tampoco eso sirve se cae a leer los fragmentos por posición.
 */
function readEncapsulatedFrame(
  dataset: DataSet,
  element: Element,
  frameIndex: number
): ByteArray {
  if (element.basicOffsetTable && element.basicOffsetTable.length > 0) {
    return dicomParser.readEncapsulatedImageFrame(dataset, element, frameIndex);
  }

  const fragmentos = element.fragments ?? [];

  try {
    const tabla = dicomParser.createJPEGBasicOffsetTable(dataset, element);
    if (tabla.length > 0) {
      return dicomParser.readEncapsulatedImageFrame(dataset, element, frameIndex, tabla);
    }
  } catch {
    // Sin marcas JPEG reconocibles; se intenta por fragmentos.
  }

  if (fragmentos.length === 0) {
    throw new DicomNoSoportadoError('Los datos de imagen comprimidos están vacíos.');
  }

  // Un fragmento por fotograma es el reparto normal cuando no hay tabla.
  if (frameIndex < fragmentos.length) {
    return dicomParser.readEncapsulatedPixelDataFromFragments(dataset, element, frameIndex, 1);
  }

  throw new DicomNoSoportadoError(
    `No se puede localizar el fotograma ${frameIndex + 1} entre los datos comprimidos.`
  );
}

function readNativeSamples(
  dataset: DataSet,
  element: { dataOffset: number; length: number },
  frameIndex: number,
  transferSyntax: string
): Int16Array | Uint16Array | Int8Array | Uint8Array {
  const bitsAllocated = dataset.uint16('x00280100') ?? 16;
  const pixelRepresentation = dataset.uint16('x00280103') ?? 0;
  const bytesPerSample = bitsAllocated <= 8 ? 1 : 2;

  const samplesPerFrame = expectedSampleCount(dataset);
  const bytesPerFrame = samplesPerFrame * bytesPerSample;
  const frameOffset = element.dataOffset + frameIndex * bytesPerFrame;

  if (frameOffset + bytesPerFrame > element.dataOffset + element.length) {
    throw new DicomNoSoportadoError(
      `El fotograma ${frameIndex + 1} excede los datos de imagen disponibles.`
    );
  }

  // Se copia a un búfer propio: el original no está necesariamente alineado a 2
  // bytes, y una vista tipada sobre un desplazamiento impar lanza.
  const aligned = new ArrayBuffer(bytesPerFrame);
  new Uint8Array(aligned).set(
    new Uint8Array(dataset.byteArray.buffer, dataset.byteArray.byteOffset + frameOffset, bytesPerFrame)
  );

  if (bytesPerSample === 2 && transferSyntax === '1.2.840.10008.1.2.2') {
    swapBytes(new Uint8Array(aligned));
  }

  if (bytesPerSample === 1) {
    return pixelRepresentation === 1 ? new Int8Array(aligned) : new Uint8Array(aligned);
  }
  return pixelRepresentation === 1 ? new Int16Array(aligned) : new Uint16Array(aligned);
}

function expectedSampleCount(dataset: DataSet): number {
  const rows = dataset.uint16('x00280010') ?? 0;
  const columns = dataset.uint16('x00280011') ?? 0;
  const samplesPerPixel = dataset.uint16('x00280002') ?? 1;
  return rows * columns * samplesPerPixel;
}

function swapBytes(bytes: Uint8Array): void {
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const low = bytes[i];
    bytes[i] = bytes[i + 1];
    bytes[i + 1] = low;
  }
}

/** Número de fotogramas del archivo; 1 cuando el tag no está presente. */
export function readFrameCount(dataset: DataSet): number {
  const raw = dataset.string('x00280008');
  if (!raw) return 1;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

/** Nombre legible de la transfer syntax, para avisos y para el registro. */
export function describeTransferSyntax(uid: string | undefined): string {
  if (!uid) return 'no declarada';
  return SIN_COMPRIMIR[uid] ?? JPEG_SIN_PERDIDA[uid] ?? NO_SOPORTADAS[uid] ?? uid;
}
