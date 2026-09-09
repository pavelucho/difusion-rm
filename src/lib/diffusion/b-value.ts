import type { DataSet } from 'dicom-parser';

/**
 * De dónde salió el valor b de una imagen. Se conserva para el registro de
 * procesamiento: un ADC calculado sobre valores b inferidos no vale lo mismo que
 * uno calculado sobre el tag estándar.
 */
export type BValueSource =
  | 'estandar'          // (0018,9087) DiffusionBValue
  | 'secuencia-rm'      // (0018,9117) MRDiffusionSequence > (0018,9087)
  | 'siemens'           // (0019,100C)
  | 'ge'                // (0043,1039)
  | 'philips'           // (2001,1003)
  | 'nombre-secuencia'  // (0018,0024) SequenceName, p. ej. "*ep_b1000"
  | 'descripcion'       // (0008,103E) SeriesDescription, p. ej. "DWI b=1000"
  | 'ausente';          // no se encontró en ningún sitio

export interface BValueReading {
  value: number;
  source: BValueSource;
  /** Cierto cuando el valor no proviene de un tag numérico de valor b. */
  inferred: boolean;
}

/**
 * Lee un tag numérico respetando su representación real.
 *
 * `dataset.string()` sobre un tag binario devuelve los bytes interpretados como
 * texto, y `parseFloat` de eso da NaN — que no es `undefined`, así que las
 * comprobaciones posteriores lo dan por leído. Ese era el origen de que todas las
 * series acabaran con b = 0. Aquí se decide por VR cuando está declarado
 * (transfer syntax explícita) y por longitud del elemento cuando no lo está
 * (transfer syntax implícita, donde dicom-parser no conoce el VR).
 */
export function readNumericTag(dataset: DataSet, tag: string): number | undefined {
  const element = dataset.elements[tag];
  if (!element || element.length === 0) return undefined;

  const vr = element.vr;

  try {
    if (vr === 'FD') return finite(dataset.double(tag));
    if (vr === 'FL') return finite(dataset.float(tag));
    if (vr === 'US') return finite(dataset.uint16(tag));
    if (vr === 'SS') return finite(dataset.int16(tag));
    if (vr === 'UL') return finite(dataset.uint32(tag));
    if (vr === 'SL') return finite(dataset.int32(tag));
    if (vr === 'DS' || vr === 'IS' || vr === 'LO' || vr === 'SH' || vr === 'UN') {
      return finite(parseFirstNumber(dataset.string(tag)));
    }

    // VR desconocido (transfer syntax implícita): dicom-parser no puede decir el
    // tipo, y la longitud no basta para decidirlo — el texto "1000" ocupa los
    // mismos 4 bytes que un float binario. Se mira el contenido.
    if (looksNumericText(dataset, element.dataOffset, element.length)) {
      return finite(parseFirstNumber(dataset.string(tag)));
    }
    if (element.length === 8) return finite(dataset.double(tag));
    if (element.length === 4) return finite(dataset.float(tag));

    return finite(parseFirstNumber(dataset.string(tag)));
  } catch {
    return undefined;
  }
}

function finite(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

/**
 * ¿Los bytes del elemento son un número escrito en texto (VR de tipo DS o IS)?
 *
 * Solo se acepta lo que un DS/IS puede contener: dígitos, signo, punto decimal,
 * exponente, separador de multivalor y relleno. Cualquier otro byte delata una
 * representación binaria.
 */
function looksNumericText(dataset: DataSet, offset: number, length: number): boolean {
  if (length === 0) return false;

  const bytes = dataset.byteArray;
  let digits = 0;

  for (let i = offset; i < offset + length; i++) {
    const byte = bytes[i];
    const isDigit = byte >= 0x30 && byte <= 0x39;
    if (isDigit) {
      digits++;
      continue;
    }
    // + - . E e \ espacio y NUL de relleno
    const isAllowed =
      byte === 0x2b || byte === 0x2d || byte === 0x2e ||
      byte === 0x45 || byte === 0x65 ||
      byte === 0x5c || byte === 0x20 || byte === 0x00;
    if (!isAllowed) return false;
  }

  return digits > 0;
}

/** Primer valor de un tag de texto, que puede ser multivalor separado por «\». */
function parseFirstNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const parsed = parseFloat(raw.split('\\')[0]);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Un valor b plausible en la práctica clínica. Descarta centinelas y basura. */
function isPlausible(b: number | undefined): b is number {
  return b !== undefined && Number.isFinite(b) && b >= 0 && b <= 10000;
}

/**
 * GE guarda el valor b en (0043,1039) con un desplazamiento: el primer elemento
 * llega como 1000000000 + b (a veces 10^9 exacto, a veces con la dirección
 * codificada encima). Se recorta el desplazamiento antes de validar.
 */
function normalizeGe(raw: number): number {
  return raw >= 1e9 ? raw % 1e9 : raw;
}

/** Siemens nombra la secuencia como "*ep_b1000" o "ep_b700t"; Philips, "DwiSE_b0". */
function fromText(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.match(/b[\s=_-]*(\d{1,5})/i);
  if (!match) return undefined;
  const parsed = parseInt(match[1], 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Busca el valor b recorriendo, por orden de fiabilidad, el tag estándar, la
 * secuencia de difusión de RM, los tags privados de cada fabricante y, como
 * último recurso, el texto del nombre de secuencia o de la descripción de serie.
 *
 * Cada estrategia solo se salta si la anterior no dio un valor plausible, de modo
 * que un tag ilegible ya no impide llegar a los respaldos.
 */
export function readBValue(dataset: DataSet): BValueReading {
  const standard = readNumericTag(dataset, 'x00189087');
  if (isPlausible(standard)) return { value: standard, source: 'estandar', inferred: false };

  const fromSequence = readBValueFromDiffusionSequence(dataset);
  if (isPlausible(fromSequence)) {
    return { value: fromSequence, source: 'secuencia-rm', inferred: false };
  }

  const siemens = readNumericTag(dataset, 'x0019100c');
  if (isPlausible(siemens)) return { value: siemens, source: 'siemens', inferred: false };

  const geRaw = readNumericTag(dataset, 'x00431039');
  if (geRaw !== undefined) {
    const ge = normalizeGe(geRaw);
    if (isPlausible(ge)) return { value: ge, source: 'ge', inferred: false };
  }

  const philips = readNumericTag(dataset, 'x20011003');
  if (isPlausible(philips)) return { value: philips, source: 'philips', inferred: false };

  const sequenceName = fromText(dataset.string('x00180024'));
  if (isPlausible(sequenceName)) {
    return { value: sequenceName, source: 'nombre-secuencia', inferred: true };
  }

  const description = fromText(dataset.string('x0008103e'));
  if (isPlausible(description)) {
    return { value: description, source: 'descripcion', inferred: true };
  }

  return { value: 0, source: 'ausente', inferred: true };
}

/** (0018,9117) MRDiffusionSequence > (0018,9087) DiffusionBValue */
function readBValueFromDiffusionSequence(dataset: DataSet): number | undefined {
  const sequence = dataset.elements.x00189117;
  if (!sequence?.items) return undefined;

  for (const item of sequence.items) {
    if (!item.dataSet) continue;
    const value = readNumericTag(item.dataSet, 'x00189087');
    if (isPlausible(value)) return value;
  }

  return undefined;
}
