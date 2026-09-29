/** Documentos Markdown, convertidos a HTML al compilar por vite.config.ts. */
declare module '*.md' {
  /** El documento en HTML, con las imágenes ya resueltas. */
  export const html: string;
  /** Títulos de segundo nivel, en orden, con su identificador de ancla. */
  export const indice: { id: string; titulo: string }[];
}
