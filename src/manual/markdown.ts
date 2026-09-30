/**
 * Conversión del manual de uso de Markdown a HTML, en tiempo de compilación.
 *
 * El manual se escribe en docs/manual-usuario.md: es lo que se edita y lo que se
 * lee en GitHub. El complemento de vite.config.ts lo convierte al compilar, de
 * modo que el navegador recibe HTML ya hecho y no carga ningún intérprete de
 * Markdown. Solo importan este módulo vite.config.ts y las pruebas; la
 * aplicación nunca lo incluye.
 */
import { Marked, Renderer, TextRenderer, type Tokens } from 'marked';

export interface EntradaIndice {
  id: string;
  titulo: string;
}

export interface ManualConvertido {
  html: string;
  /** Secciones de segundo nivel, en orden, para el índice lateral. */
  indice: EntradaIndice[];
  /** Imágenes con ruta relativa al .md, en orden; el complemento las importa. */
  imagenes: string[];
  /** Identificadores de todos los títulos. */
  ids: string[];
  /** Destinos de los enlaces internos (sin «#»), para poder comprobarlos. */
  enlacesInternos: string[];
}

/** Marcador que el complemento sustituye por la URL definitiva de cada imagen. */
export const marcadorImagen = (indice: number) => `__IMAGEN_MANUAL_${indice}__`;

/**
 * Identificador de un título, igual al que genera GitHub: minúsculas, sin signos
 * de puntuación y con un guion por cada espacio. Así un enlace como
 * `#configurar-el-cálculo` funciona igual en GitHub que en la aplicación.
 */
export function idDeTitulo(texto: string): string {
  return texto
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Los avisos de GitHub (`> [!NOTE]`…), con su título en español. */
const AVISOS: Record<string, { clase: string; titulo: string }> = {
  NOTE: { clase: 'nota', titulo: 'Nota' },
  TIP: { clase: 'consejo', titulo: 'Consejo' },
  IMPORTANT: { clase: 'importante', titulo: 'Importante' },
  WARNING: { clase: 'advertencia', titulo: 'Advertencia' },
  CAUTION: { clase: 'precaucion', titulo: 'Precaución' },
};

const esRutaRelativa = (ruta: string) => !/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(ruta);

export function convertirManual(fuente: string): ManualConvertido {
  const indice: EntradaIndice[] = [];
  const imagenes: string[] = [];
  const ids: string[] = [];
  const enlacesInternos: string[] = [];
  const repeticiones = new Map<string, number>();
  const textoPlano = new TextRenderer();

  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }: Tokens.Heading) {
        const titulo = this.parser.parseInline(tokens, textoPlano);
        // GitHub numera los títulos repetidos: «uso», «uso-1», «uso-2»…
        const base = idDeTitulo(titulo);
        const vistas = repeticiones.get(base) ?? 0;
        repeticiones.set(base, vistas + 1);
        const id = vistas === 0 ? base : `${base}-${vistas}`;

        ids.push(id);
        if (depth === 2) indice.push({ id, titulo });
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },

      link(token: Tokens.Link) {
        const html = Renderer.prototype.link.call(this, token);
        if (token.href.startsWith('#')) {
          enlacesInternos.push(decodeURIComponent(token.href.slice(1)));
          return html;
        }
        if (!/^https?:/i.test(token.href)) return html;
        // Los enlaces externos se abren aparte para no perder el sitio en el manual.
        // Si el texto ya es la dirección, o el DOI al que lleva, la versión impresa
        // no la repite.
        const sinBarraFinal = (s: string) => s.replace(/\/$/, '');
        const esDoi = token.href === `https://doi.org/${token.text}`;
        const clase = esDoi || sinBarraFinal(token.text) === sinBarraFinal(token.href)
          ? 'class="url-a-la-vista" '
          : '';
        return html.replace('<a ', `<a ${clase}target="_blank" rel="noopener noreferrer" `);
      },

      image(token: Tokens.Image) {
        if (!esRutaRelativa(token.href)) return Renderer.prototype.image.call(this, token);
        imagenes.push(token.href);
        const html = Renderer.prototype.image.call(this, {
          ...token,
          href: marcadorImagen(imagenes.length - 1),
        });
        return html.replace('<img ', '<img loading="lazy" ');
      },

      // Las tablas anchas se desplazan dentro de su caja en pantallas estrechas.
      table(token: Tokens.Table) {
        return `<div class="tabla-desplazable">${Renderer.prototype.table.call(this, token)}</div>\n`;
      },

      blockquote({ tokens }: Tokens.Blockquote) {
        const cuerpo = this.parser.parse(tokens);
        const aviso = cuerpo.match(/^<p>\[!(\w+)\]\s*/);
        const tipo = aviso && AVISOS[aviso[1].toUpperCase()];
        if (!aviso || !tipo) return `<blockquote>\n${cuerpo}</blockquote>\n`;
        const resto = cuerpo.slice(aviso[0].length).replace(/^<\/p>\s*/, '');
        const contenido = resto.startsWith('<') ? resto : `<p>${resto}`;
        return (
          `<div class="aviso aviso-${tipo.clase}" role="note">` +
          `<p class="aviso-titulo">${tipo.titulo}</p>\n${contenido}</div>\n`
        );
      },
    },
  });

  const html = marked.parse(fuente, { async: false });
  return { html, indice, imagenes, ids, enlacesInternos };
}
