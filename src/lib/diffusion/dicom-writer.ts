// @ts-ignore
import dcmjs from 'dcmjs';
import JSZip from 'jszip';
import type { DicomSlice, AveragedSlice } from './types';

// Extract the original dataset to clone
export async function createDerivedDicom(
  originalSlice: DicomSlice | AveragedSlice,
  pixelData: Float32Array,
  mapType: 'ADC' | 'EADC' | 'CDWI',
  params: {
    bLow?: number;
    bHigh?: number;
    bTarget?: number;
    bValues?: number[];
    threshold: number;
    registration: "none" | "translation" | "rigid";
  },
  seriesInstanceUID: string,
  sopInstanceUID: string
): Promise<{ buffer: ArrayBuffer, saturatedCount: number }> {
  // Use dcmjs to clone and write
  // We need to pass the original ArrayBuffer to dcmjs.data.DicomMessage.readFile
  // Since we parsed with dicom-parser before, we parse again with dcmjs here.
  const dicomDict = dcmjs.data.DicomMessage.readFile(originalSlice.metadata.buffer, { ignoreErrors: true });
  const dataset = dicomDict.dict;

  let outPixels = new Uint16Array(pixelData.length);
  let saturatedCount = 0;
  
  let windowCenter, windowWidth, rescaleType;
  const numPixels = pixelData.length;
  
  if (mapType === 'ADC') {
    windowCenter = 1500;
    windowWidth = 3000;
    rescaleType = "10-6 mm2/s";
    
    for (let i = 0; i < numPixels; i++) {
      let val = Math.round(pixelData[i] * 1e6);
      if (val < 0) val = 0;
      if (val > 65535) { val = 65535; saturatedCount++; }
      outPixels[i] = val;
    }
  } else if (mapType === 'EADC') {
    windowCenter = 500;
    windowWidth = 1000;
    rescaleType = "Ratio x1000";
    
    for (let i = 0; i < numPixels; i++) {
      let val = Math.round(pixelData[i] * 1000);
      if (val < 0) val = 0;
      if (val > 65535) { val = 65535; saturatedCount++; }
      outPixels[i] = val;
    }
  } else if (mapType === 'CDWI') {
    let unmasked: number[] = [];
    for (let i = 0; i < numPixels; i++) {
      if (pixelData[i] > 0) unmasked.push(pixelData[i]);
    }
    unmasked.sort((a, b) => a - b);
    
    let p1 = 0;
    let p99 = 1;
    if (unmasked.length > 0) {
      p1 = unmasked[Math.floor(unmasked.length * 0.01)];
      p99 = unmasked[Math.floor(unmasked.length * 0.99)];
    }
    windowCenter = Math.round((p1 + p99) / 2);
    windowWidth = Math.round(Math.max(1, p99 - p1));
    
    for (let i = 0; i < numPixels; i++) {
      let val = Math.round(pixelData[i]);
      if (val < 0) val = 0;
      if (val > 65535) { val = 65535; saturatedCount++; }
      outPixels[i] = val;
    }
    
    if (params.bTarget !== undefined) {
      dataset['00189087'] = { vr: 'FD', Value: [params.bTarget] };
    }
  }

  // Common overrides
  dataset['00080016'] = { vr: 'UI', Value: [dataset['00080016']?.Value?.[0] || '1.2.840.10008.5.1.4.1.1.4'] }; // SOP Class UID
  dataset['00080018'] = { vr: 'UI', Value: [sopInstanceUID] };

  // El meta-encabezado tiene que describir el archivo que se está escribiendo, no
  // el original: si conserva el SOP Instance UID de origen, algunos PACS rechazan
  // el envío o deduplican mal; y si conserva la transfer syntax comprimida del
  // original, el receptor intenta descomprimir píxeles que ya están en claro.
  const meta = dicomDict.meta as Record<string, { vr: string; Value: unknown[] }>;
  meta['00020002'] = { vr: 'UI', Value: [dataset['00080016'].Value[0]] };
  meta['00020003'] = { vr: 'UI', Value: [sopInstanceUID] };
  meta['00020010'] = { vr: 'UI', Value: ['1.2.840.10008.1.2.1'] }; // Explicit VR Little Endian
  dataset['0020000E'] = { vr: 'UI', Value: [seriesInstanceUID] };
  dataset['00080060'] = { vr: 'CS', Value: ["MR"] };
  dataset['00080008'] = { vr: 'CS', Value: ["DERIVED", "SECONDARY", mapType] };
  
  if (mapType === 'ADC') {
    dataset['00200011'] = { vr: 'IS', Value: [1001] };
    const desc = params.bValues ? `ADC calc multi-b` : `ADC calc (b=${params.bLow},${params.bHigh})`;
    dataset['0008103E'] = { vr: 'LO', Value: [desc] };
  } else if (mapType === 'EADC') {
    dataset['00200011'] = { vr: 'IS', Value: [1002] };
    const desc = params.bValues ? `eADC calc multi-b` : `eADC calc (b=${params.bLow},${params.bHigh})`;
    dataset['0008103E'] = { vr: 'LO', Value: [desc] };
  } else if (mapType === 'CDWI') {
    dataset['00200011'] = { vr: 'IS', Value: [1003] };
    dataset['0008103E'] = { vr: 'LO', Value: [`cDWI b=${params.bTarget} (calc)`] };
  }
  
  // Solo se avisa cuando hay una b baja conocida y realmente por debajo de 150 s/mm².
  // En ajuste multi-b no hay una única b de referencia, así que no se estampa el aviso.
  if (params.bLow !== undefined && params.bLow < 150) {
    dataset['0008103E'].Value[0] += " [LOW-B<150]";
  }
  
  let derivationFormula = "";
  if (mapType === 'ADC' && !params.bValues) derivationFormula = `ADC = ln(S(b=${params.bLow})/S(b=${params.bHigh}))/(${params.bHigh}-${params.bLow})`;
  else if (mapType === 'EADC' && !params.bValues) derivationFormula = `eADC = exp(-${params.bHigh} * ADC)`;
  else if (mapType === 'CDWI' && !params.bValues) derivationFormula = `cDWI = S(b=${params.bLow}) * exp((${params.bLow}-${params.bTarget}) * ADC)`;
  else derivationFormula = `Multi-b fit`;
  
  // La descripción de derivación es el rastro que queda dentro del archivo: quien
  // reciba el mapa tiene que poder saber con qué se calculó y con qué versión.
  const derivationDesc =
    `${derivationFormula}; mask bg+3SD=${params.threshold.toFixed(1)}; ` +
    `range 0-4e-3 mm2/s; registration ${params.registration}; ` +
    `difusion-rm ${__APP_VERSION__} (${__BUILD_DATE__})`;

  dataset['00082111'] = { vr: 'ST', Value: [derivationDesc] };
  dataset['00081090'] = { vr: 'LO', Value: ['difusion-rm'] };  // Manufacturer's Model Name
  dataset['00181020'] = { vr: 'LO', Value: [`difusion-rm ${__APP_VERSION__}`] }; // Software Versions
  
  dataset['00281052'] = { vr: 'DS', Value: [0] };
  dataset['00281053'] = { vr: 'DS', Value: [1] };
  if (rescaleType) {
    dataset['00281054'] = { vr: 'LO', Value: [rescaleType] };
  }
  
  dataset['00281050'] = { vr: 'DS', Value: [windowCenter] };
  dataset['00281051'] = { vr: 'DS', Value: [windowWidth] };
  
  // Set pixel data
  dataset['7FE00010'] = { vr: 'OW', Value: [outPixels.buffer] };
  dataset['00280100'] = { vr: 'US', Value: [16] }; // Bits allocated
  dataset['00280101'] = { vr: 'US', Value: [16] }; // Bits stored
  dataset['00280102'] = { vr: 'US', Value: [15] }; // High bit
  dataset['00280103'] = { vr: 'US', Value: [0] };  // Pixel representation (unsigned)
  
  const buffer = dicomDict.write();
  return { buffer, saturatedCount };
}

export async function exportZip(filesToExport: { buffer: ArrayBuffer, mapType: string, index: number }[]): Promise<Blob> {
  const zip = new JSZip();
  
  for (const file of filesToExport) {
    zip.file(`${file.mapType}_slice_${file.index.toString().padStart(4, '0')}.dcm`, file.buffer);
  }
  
  return zip.generateAsync({ type: 'blob' });
}
