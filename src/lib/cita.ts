// Datos del archivo citable en Zenodo.
//
// Hay dos clases de DOI y no son intercambiables. El de concepto es permanente y
// resuelve siempre a la última versión publicada; el de versión fija el código
// exacto que produjo los mapas, y es el que debe citarse en la sección de métodos
// de un artículo.
//
// Los DOI de versión se emiten al publicar el release, de modo que una compilación
// recién hecha puede no tener el suyo todavía. Por eso se guardan indexados por
// versión en lugar de uno fijo: así la aplicación nunca puede citar un DOI que
// corresponde a otro código. Al publicar una versión, añada aquí su DOI —y
// actualice `version` y `date-released` en `.zenodo.json` y `CITATION.cff`.

export const CITA = {
  autorApa: 'Luna, P.',
  autorBibtex: 'Luna, Pavel',
  titulo: 'Procesador de difusión — ADC · eADC · cDWI',
  anio: 2026,
  doiConcepto: '10.5281/zenodo.22714640',
  repositorio: 'https://github.com/pavelucho/difusion-rm',
} as const;

const DOI_POR_VERSION: Record<string, string> = {
  '1.0.0': '10.5281/zenodo.22714641',
};

export const urlDoi = (doi: string) => `https://doi.org/${doi}`;

/** DOI de la versión indicada, o null si esa versión aún no está archivada. */
export function doiDeVersion(version: string): string | null {
  return DOI_POR_VERSION[version] ?? null;
}

/** DOI que debe usarse para citar esta compilación: el de su versión si existe. */
export function doiParaCitar(version: string): string {
  return doiDeVersion(version) ?? CITA.doiConcepto;
}

/** Referencia en APA 7.ª. */
export function citaApa(version: string): string {
  return `${CITA.autorApa} (${CITA.anio}). ${CITA.titulo} (versión ${version}) ` +
    `[Software]. Zenodo. ${urlDoi(doiParaCitar(version))}`;
}

/** Entrada BibTeX del tipo @software. */
export function citaBibtex(version: string): string {
  const doi = doiParaCitar(version);
  return [
    '@software{luna_difusion_rm_' + CITA.anio + ',',
    '  author    = {' + CITA.autorBibtex + '},',
    '  title     = {' + CITA.titulo + '},',
    '  version   = {' + version + '},',
    '  year      = {' + CITA.anio + '},',
    '  publisher = {Zenodo},',
    '  doi       = {' + doi + '},',
    '  url       = {' + urlDoi(doi) + '}',
    '}',
  ].join('\n');
}
