/**
 * dcmjs no publica tipos. Se declara aquí la superficie que usa esta aplicación
 * en lugar de dejar que el módulo entero caiga a `any` implícito.
 */
declare module 'dcmjs' {
  interface DicomDict {
    dict: Record<string, { vr: string; Value: unknown[] }>;
    meta: Record<string, { vr: string; Value: unknown[] }>;
    upsertTag(tag: string, vr: string, value: unknown): void;
    write(): ArrayBuffer;
  }

  export const data: {
    DicomMessage: {
      readFile(buffer: ArrayBuffer, options?: { ignoreErrors?: boolean }): DicomDict;
    };
    DicomMetaDictionary: {
      uid(): string;
      naturalizeDataset(dict: unknown): Record<string, unknown>;
      denaturalizeDataset(dataset: unknown): Record<string, unknown>;
    };
  };

  const dcmjs: { data: typeof data };
  export default dcmjs;
}
