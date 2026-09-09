import dicomParser from 'dicom-parser';
import type { DicomSlice, Point3D } from './types';
import { readBValue } from './b-value';
import {
  DicomNoSoportadoError,
  describeTransferSyntax,
  readFrameCount,
  readPixelSamples,
} from './pixel-data';

function crossProduct(a: Point3D, b: Point3D): Point3D {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dotProduct(a: Point3D, b: Point3D): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function parsePoint3D(val: string | undefined): Point3D | undefined {
  if (!val) return undefined;
  const parts = val.split('\\').map(parseFloat);
  if (parts.length >= 3) return { x: parts[0], y: parts[1], z: parts[2] };
  return undefined;
}

function parseVectors(val: string | undefined): [Point3D, Point3D] | undefined {
  if (!val) return undefined;
  const parts = val.split('\\').map(parseFloat);
  if (parts.length >= 6) {
    return [
      { x: parts[0], y: parts[1], z: parts[2] },
      { x: parts[3], y: parts[4], z: parts[5] },
    ];
  }
  return undefined;
}

/**
 * ¿Es un mapa de ADC ya calculado por el equipo?
 *
 * Antes bastaba con que la descripción de serie contuviera «adc» en cualquier
 * posición, lo que también acierta con «eADC» o «ADC_calc» y hacía desaparecer
 * series que sí eran de difusión. Ahora se exige ADC como palabra propia, o bien
 * una señal inequívoca: el tipo de imagen o el tipo de rescale.
 */
function detectVendorADC(
  seriesDescription: string,
  imageType: string,
  rescaleType: string | undefined
): boolean {
  if (rescaleType === '10-6 mm2/s') return true;

  const componentesTipo = imageType.split('\\').map(c => c.trim().toUpperCase());
  if (componentesTipo.includes('ADC')) return true;

  // «ADC» delimitado: acierta con "DWI ADC" y "ADC_map", no con "eADC".
  return /(^|[^a-z])adc([^a-z]|$)/i.test(seriesDescription);
}

export function parseDicom(buffer: ArrayBuffer): DicomSlice {
  const byteArray = new Uint8Array(buffer);
  const dataset = dicomParser.parseDicom(byteArray);
  
  const columns = dataset.uint16('x00280011') ?? 0;
  const rows = dataset.uint16('x00280010') ?? 0;
  
  const pixelSpacingStr = dataset.string('x00280030');
  let pixelSpacing: [number, number] = [1, 1];
  if (pixelSpacingStr) {
    const parts = pixelSpacingStr.split('\\').map(parseFloat);
    if (parts.length >= 2) pixelSpacing = [parts[0], parts[1]];
  }
  
  const sliceThicknessStr = dataset.string('x00180050');
  const sliceThickness = sliceThicknessStr ? parseFloat(sliceThicknessStr) : undefined;
  
  const ippStr = dataset.string('x00200032');
  const imagePositionPatient = parsePoint3D(ippStr);
  
  const iopStr = dataset.string('x00200037');
  const imageOrientationPatient = parseVectors(iopStr);
  
  const sliceLocationStr = dataset.string('x00201041');
  const sliceLocation = sliceLocationStr ? parseFloat(sliceLocationStr) : undefined;
  
  let canonicalPosition = 0;
  if (imagePositionPatient && imageOrientationPatient) {
    const normal = crossProduct(imageOrientationPatient[0], imageOrientationPatient[1]);
    canonicalPosition = dotProduct(imagePositionPatient, normal);
  } else if (sliceLocation !== undefined) {
    canonicalPosition = sliceLocation;
  }
  
  const seriesInstanceUID = dataset.string('x0020000e') ?? '';
  const studyInstanceUID = dataset.string('x0020000d') ?? '';
  const frameOfReferenceUID = dataset.string('x00200052') ?? '';
  const seriesDescription = dataset.string('x0008103e') ?? '';
  const instanceNumberStr = dataset.string('x00200013');
  const instanceNumber = instanceNumberStr ? parseInt(instanceNumberStr, 10) : 0;
  
  const echoTimeStr = dataset.string('x00180081');
  const echoTime = echoTimeStr ? parseFloat(echoTimeStr) : undefined;

  const { value: bValue, source: bValueSource, inferred: bValueInferred } = readBValue(dataset);

  const rescaleType = dataset.string('x00281054');
  const imageType = dataset.string('x00080008') ?? '';
  const isVendorADC = detectVendorADC(seriesDescription, imageType, rescaleType);

  const rescaleInterceptStr = dataset.string('x00281052');
  const rescaleSlopeStr = dataset.string('x00281053');
  const rescaleIntercept = rescaleInterceptStr ? parseFloat(rescaleInterceptStr) : 0;
  const rescaleSlope = rescaleSlopeStr ? parseFloat(rescaleSlopeStr) : 1;

  const windowCenterStr = dataset.string('x00281050');
  const windowWidthStr = dataset.string('x00281051');
  let windowCenter: number | undefined;
  let windowWidth: number | undefined;
  if (windowCenterStr !== undefined && windowWidthStr !== undefined) {
    const wc = parseFloat(windowCenterStr.split('\\')[0]);
    const ww = parseFloat(windowWidthStr.split('\\')[0]);
    if (!isNaN(wc) && !isNaN(ww)) {
      windowCenter = wc;
      windowWidth = ww;
    }
  }

  const frameCount = readFrameCount(dataset);
  if (frameCount > 1) {
    throw new DicomNoSoportadoError(
      `Imagen multifotograma (${frameCount} fotogramas) todavía no soportada. ` +
        'Exporte la serie como DICOM de un fotograma por archivo.'
    );
  }

  const pixels = readPixelSamples(dataset);

  const floatPixels = new Float32Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    floatPixels[i] = pixels[i] * rescaleSlope + rescaleIntercept;
  }

  return {
    metadata: {
      columns,
      rows,
      pixelSpacing,
      sliceThickness,
      imagePositionPatient,
      imageOrientationPatient,
      sliceLocation,
      seriesInstanceUID,
      studyInstanceUID,
      frameOfReferenceUID,
      seriesDescription,
      instanceNumber,
      echoTime,
      bValue,
      bValueInferred,
      bValueSource,
      isVendorADC,
      transferSyntax: describeTransferSyntax(dataset.string('x00020010')),
      photometricInterpretation: dataset.string('x00280004') ?? 'MONOCHROME2',
      canonicalPosition,
      rescaleIntercept,
      rescaleSlope,
      windowCenter,
      windowWidth,
      dataset,
      buffer,
      patientName: dataset.string('x00100010'),
      patientID: dataset.string('x00100020'),
      patientBirthDate: dataset.string('x00100030'),
      patientSex: dataset.string('x00100040'),
      studyDate: dataset.string('x00080020'),
      studyDescription: dataset.string('x00081030'),
      accessionNumber: dataset.string('x00080050'),
    },
    pixelData: floatPixels,
  };
}
