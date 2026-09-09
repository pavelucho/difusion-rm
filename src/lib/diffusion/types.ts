import type { BValueSource } from './b-value';

export interface Point3D {
  x: number;
  y: number;
  z: number;
}

export interface DicomMetadata {
  columns: number;
  rows: number;
  pixelSpacing: [number, number];
  sliceThickness?: number;
  imagePositionPatient?: Point3D;
  imageOrientationPatient?: [Point3D, Point3D];
  sliceLocation?: number;
  seriesInstanceUID: string;
  studyInstanceUID: string;
  frameOfReferenceUID: string;
  seriesDescription: string;
  instanceNumber: number;
  echoTime?: number;
  bValue: number;
  bValueInferred: boolean;
  /** Tag del que salió el valor b. Se conserva para el registro de procesamiento. */
  bValueSource: BValueSource;
  isVendorADC: boolean;
  /** Nombre legible de la transfer syntax con la que venía el archivo. */
  transferSyntax: string;
  photometricInterpretation: string;
  patientName?: string;
  patientID?: string;
  patientBirthDate?: string;
  patientSex?: string;
  studyDate?: string;
  studyDescription?: string;
  accessionNumber?: string;
  canonicalPosition: number;
  rescaleIntercept: number;
  rescaleSlope: number;
  windowCenter?: number;
  windowWidth?: number;
  dataset: any; // dicom-parser dataset
  buffer: ArrayBuffer; // original buffer to pass to WebWorker or for extraction
}

export interface DicomSlice {
  metadata: DicomMetadata;
  pixelData: Float32Array;
}

export interface AveragedSlice {
  metadata: DicomMetadata;
  pixelData: Float32Array;
  count: number;
}

export interface MapResult {
  adc: Float32Array;
  eadc: Float32Array;
  cdwi: Float32Array;
  r2?: Float32Array;
  mask: Uint8Array;
  bTarget: number;
  bLow: number;
  bHigh: number;
}
