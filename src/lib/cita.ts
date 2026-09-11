// Datos del archivo citable en Zenodo.
//
// Hay dos DOI y no son intercambiables. El de concepto es permanente y resuelve
// siempre a la última versión publicada; el de versión fija el código exacto que
// produjo los mapas, y es el que debe citarse en la sección de métodos de un
// artículo. Al publicar una versión nueva, `doiVersion` cambia: actualícelo aquí
// junto con `version` y `date-released` de `.zenodo.json` y `CITATION.cff`.

export const CITA = {
  autorApa: 'Luna, P.',
  autorBibtex: 'Luna, Pavel',
  titulo: 'Procesador de difusión — ADC · eADC · cDWI',
  anio: 2026,
  doiConcepto: '10.5281/zenodo.22714640',
  doiVersion: '10.5281/zenodo.22714641',
  repositorio: 'https://github.com/pavelucho/difusion-rm',
} as const;

export const urlDoi = (doi: string) => `https://doi.org/${doi}`;

/** Referencia en APA 7.ª, con el DOI de versión. */
export function citaApa(version: string): string {
  return `${CITA.autorApa} (${CITA.anio}). ${CITA.titulo} (versión ${version}) ` +
    `[Software]. Zenodo. ${urlDoi(CITA.doiVersion)}`;
}

/** Entrada BibTeX del tipo @software, con el DOI de versión. */
export function citaBibtex(version: string): string {
  return [
    '@software{luna_difusion_rm_' + CITA.anio + ',',
    '  author    = {' + CITA.autorBibtex + '},',
    '  title     = {' + CITA.titulo + '},',
    '  version   = {' + version + '},',
    '  year      = {' + CITA.anio + '},',
    '  publisher = {Zenodo},',
    '  doi       = {' + CITA.doiVersion + '},',
    '  url       = {' + urlDoi(CITA.doiVersion) + '}',
    '}',
  ].join('\n');
}
