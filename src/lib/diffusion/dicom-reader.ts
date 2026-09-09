import dicomParser from 'dicom-parser';
import type { DicomSlice, Point3D } from './types';

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

  let bValue: number | undefined = undefined;
  let bValueInferred = false;

  const bValueStr = dataset.string('x00189087');
  if (bValueStr !== undefined) {
    bValue = parseFloat(bValueStr);
  }

  if (bValue === undefined) {
    const diffusionSeq = dataset.elements.x00189117;
    if (diffusionSeq && diffusionSeq.items && diffusionSeq.items.length > 0) {
      for (const item of diffusionSeq.items) {
        const itemDataset = item.dataSet;
        if (itemDataset) {
          const itemBValueStr = itemDataset.string('x00189087');
          if (itemBValueStr !== undefined) {
            bValue = parseFloat(itemBValueStr);
            break;
          }
        }
      }
    }
  }

  if (bValue === undefined) {
    const siemensBStr = dataset.string('x0019100c');
    if (siemensBStr !== undefined) {
      bValue = parseFloat(siemensBStr);
    }
  }

  if (bValue === undefined) {
    const geBStr = dataset.string('x00431039');
    if (geBStr !== undefined) {
      const firstVal = parseFloat(geBStr.split('\\')[0]);
      if (!isNaN(firstVal)) {
        bValue = firstVal % 1000000000;
      }
    }
  }

  if (bValue === undefined) {
    const philipsB = dataset.float('x20011003');
    if (philipsB !== undefined) {
      bValue = philipsB;
    }
  }

  if (bValue === undefined || isNaN(bValue)) {
    bValue = 0;
    bValueInferred = true;
  }

  const rescaleType = dataset.string('x00281054');
  const isVendorADC = seriesDescription.toLowerCase().includes('adc') || rescaleType === '10-6 mm2/s';

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

  const bitsAllocated = dataset.uint16('x00280100') ?? 16;
  const pixelRepresentation = dataset.uint16('x00280103') ?? 0;

  const pixelDataElement = dataset.elements.x7fe00010;
  const pixelDataLength = pixelDataElement.length;
  const pixelDataOffset = pixelDataElement.dataOffset;
  
  const rawPixelData = new Uint8Array(dataset.byteArray.buffer, dataset.byteArray.byteOffset + pixelDataOffset, pixelDataLength);
  const alignedBuffer = new ArrayBuffer(pixelDataLength);
  new Uint8Array(alignedBuffer).set(rawPixelData);

  let pixels: Int8Array | Uint8Array | Int16Array | Uint16Array;
  
  if (bitsAllocated <= 8) {
    pixels = pixelRepresentation === 1 ? new Int8Array(alignedBuffer) : new Uint8Array(alignedBuffer);
  } else {
    pixels = pixelRepresentation === 1 ? new Int16Array(alignedBuffer) : new Uint16Array(alignedBuffer);
  }

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
      isVendorADC,
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
