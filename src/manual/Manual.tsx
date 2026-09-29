import { useEffect, useState } from 'react';
import { ArrowUpRight, Printer } from 'lucide-react';
import { html, indice } from '../../docs/manual-usuario.md';
import { es } from '../i18n/es';
import './manual.css';

/** Distancia al borde superior a partir de la cual una sección cuenta como la actual. */
const MARGEN_SECCION_ACTIVA = 96;

function Indice({ activa }: { activa?: string }) {
  return (
    <ol className="flex flex-col gap-0.5 text-sm">
      {indice.map(({ id, titulo }) => (
        <li key={id}>
          <a
            href={`#${id}`}
            aria-current={activa === id ? 'location' : undefined}
            className={
              'block py-1 pl-3 border-l-2 leading-snug transition-colors ' +
              (activa === id
                ? 'border-[#F27D26] text-[#F27D26]'
                : 'border-transparent text-gray-400 hover:text-gray-100')
            }
          >
            {titulo}
          </a>
        </li>
      ))}
    </ol>
  );
}

/**
 * Manual de uso, servido en /manual por la misma aplicación. Así se abre sin
 * conexión igual que la herramienta, se puede tener en otra pestaña mientras se
 * trabaja y se imprime como un documento normal.
 */
export default function Manual() {
  const [activa, setActiva] = useState(indice[0]?.id);

  useEffect(() => {
    document.title = es.manualTituloPagina;
    // El contenido llega después de que el navegador intentara saltar al ancla de
    // la dirección (/manual#exportar), así que el salto se repite aquí.
    const destino = decodeURIComponent(window.location.hash.slice(1));
    if (destino) document.getElementById(destino)?.scrollIntoView();
  }, []);

  // Resalta en el índice la sección que se está leyendo. Los títulos se buscan en
  // cada pasada, no una vez: si el contenido se vuelve a pintar, una referencia
  // guardada apuntaría a un nodo que ya no está en la página.
  useEffect(() => {
    let pendiente = false;

    const actualizar = () => {
      pendiente = false;
      let actual = indice[0]?.id;
      for (const { id } of indice) {
        const titulo = document.getElementById(id);
        if (!titulo || titulo.getBoundingClientRect().top > MARGEN_SECCION_ACTIVA) break;
        actual = id;
      }
      // La última sección es corta y su título nunca llega arriba: al final de la
      // página, la actual es ella.
      const alFinal =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
      setActiva(alFinal ? indice[indice.length - 1]?.id : actual);
    };
    const alDesplazar = () => {
      if (pendiente) return;
      pendiente = true;
      requestAnimationFrame(actualizar);
    };

    actualizar();
    window.addEventListener('scroll', alDesplazar, { passive: true });
    return () => window.removeEventListener('scroll', alDesplazar);
  }, []);

  const version = es.manualVersion
    .replace('{version}', __APP_VERSION__)
    .replace('{fecha}', __BUILD_DATE__);

  return (
    <div className="pagina-manual min-h-screen bg-[#1A1614] text-gray-300 font-sans">
      <header className="sticky top-0 z-20 bg-[#2B221C]/95 backdrop-blur border-b border-[#3a3028] print:hidden">
        <div className="max-w-6xl mx-auto px-4 h-12 flex items-center gap-4">
          <a href="/" className="text-[#F27D26] font-bold text-sm truncate hover:underline">
            {es.appTitle}
          </a>
          <span className="hidden md:inline text-xs text-gray-500 whitespace-nowrap">{version}</span>
          <div className="ml-auto flex items-center gap-4 shrink-0">
            <button
              type="button"
              onClick={() => window.print()}
              className="flex items-center gap-1.5 text-xs text-gray-300 hover:text-[#F27D26] transition-colors"
            >
              <Printer size={14} aria-hidden="true" />
              <span className="hidden sm:inline">{es.manualImprimir}</span>
              <span className="sm:hidden">{es.manualImprimirCorto}</span>
            </button>
            <a
              href="/"
              className="flex items-center gap-1 text-xs font-semibold text-[#1A1614] bg-[#F27D26] hover:bg-[#d96a1a] px-2.5 py-1.5 rounded transition-colors"
            >
              {es.manualAbrirApp}
              <ArrowUpRight size={13} aria-hidden="true" />
            </a>
          </div>
        </div>
      </header>

      {/* Portada del documento impreso, con su índice: la cabecera y el índice de
          pantalla no se imprimen. Los estilos están en manual.css. */}
      <div className="portada-impresa" aria-hidden="true">
        <p className="portada-app">{es.appTitle}</p>
        <p className="portada-titulo">{es.manualSubtitulo}</p>
        <p className="portada-version">{version}</p>
        <p className="portada-url">https://difusion-rm.pages.dev/manual</p>
        <p className="portada-indice">{es.manualIndice}</p>
        <ol>
          {indice.map(({ id, titulo }) => <li key={id}>{titulo}</li>)}
        </ol>
      </div>

      <div className="max-w-6xl mx-auto px-4 lg:grid lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-12">
        <nav
          aria-label={es.manualIndice}
          className="hidden lg:block sticky top-12 self-start max-h-[calc(100vh-3rem)] overflow-y-auto py-8 print:hidden"
        >
          <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-500 mb-3 pl-3">
            {es.manualIndice}
          </p>
          <Indice activa={activa} />
        </nav>

        <main className="min-w-0 pb-24">
          {/* En pantallas estrechas el índice va plegado al principio. No se pliega
              solo al elegir una sección: cerrarlo en el mismo clic anula el salto. */}
          <details className="lg:hidden mt-6 bg-[#2B221C] border border-[#3a3028] rounded print:hidden">
            <summary className="cursor-pointer px-4 py-2.5 text-sm font-semibold text-gray-200">
              {es.manualIndice}
            </summary>
            <div className="px-1 pb-3">
              <Indice activa={activa} />
            </div>
          </details>

          <article className="manual-contenido" dangerouslySetInnerHTML={{ __html: html }} />
        </main>
      </div>
    </div>
  );
}
