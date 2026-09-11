import { useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink, X } from 'lucide-react';
import { es } from '../i18n/es';
import { CITA, citaApa, citaBibtex, doiDeVersion, urlDoi } from '../lib/cita';

interface CitaProps {
  onClose: () => void;
}

/** Bloque de texto citable con botón de copia. */
function BloqueCopiable({ etiqueta, texto, monoespaciado, copiado, onCopiar }: {
  etiqueta: string;
  texto: string;
  monoespaciado?: boolean;
  copiado: boolean;
  onCopiar: () => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          {etiqueta}
        </span>
        <button
          type="button"
          onClick={onCopiar}
          className="flex items-center gap-1.5 text-[11px] text-gray-300 hover:text-[#F27D26] transition-colors"
        >
          {copiado
            ? <Check size={13} aria-hidden="true" className="text-[#F27D26]" />
            : <Copy size={13} aria-hidden="true" />}
          {copiado ? es.citaCopiado : es.citaCopiar}
        </button>
      </div>
      <pre
        className={'bg-[#1A1614] border border-[#3a3028] rounded p-3 text-xs text-gray-200 ' +
          'whitespace-pre-wrap break-words select-all ' +
          (monoespaciado ? 'font-mono leading-relaxed' : 'font-sans leading-snug')}
      >{texto}</pre>
    </div>
  );
}

/** Fila de un DOI: enlace y para qué sirve. */
function FilaDoi({ etiqueta, doi, ayuda }: { etiqueta: string; doi: string; ayuda: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">
          {etiqueta}
        </span>
        <a
          href={urlDoi(doi)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-xs text-[#F27D26] hover:underline font-mono"
        >
          {doi}
        </a>
      </div>
      <p className="text-[11px] text-gray-500 leading-snug">{ayuda}</p>
    </div>
  );
}

export function Cita({ onClose }: CitaProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [copiado, setCopiado] = useState<'apa' | 'bibtex' | null>(null);
  const [errorCopia, setErrorCopia] = useState(false);

  const version = __APP_VERSION__;
  const apa = citaApa(version);
  const bibtex = citaBibtex(version);
  const doiVersion = doiDeVersion(version);

  // showModal() da foco atrapado y pone el diálogo en la capa superior.
  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (!d.open) d.showModal();
    // El navegador cierra un <dialog> modal con Escape por su cuenta, pero esa
    // gestión no llega en algunos contextos embebidos. Un modal que no se puede
    // cerrar con el teclado deja fuera a quien no usa ratón, así que se maneja
    // de forma explícita; si el navegador ya lo cerró, close() no hace nada.
    const alPulsarTecla = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        d.close();
      }
    };
    d.addEventListener('keydown', alPulsarTecla);
    return () => d.removeEventListener('keydown', alPulsarTecla);
  }, []);

  useEffect(() => {
    if (!copiado) return;
    const t = window.setTimeout(() => setCopiado(null), 2000);
    return () => window.clearTimeout(t);
  }, [copiado]);

  async function copiar(texto: string, cual: 'apa' | 'bibtex') {
    try {
      await navigator.clipboard.writeText(texto);
      setErrorCopia(false);
      setCopiado(cual);
    } catch {
      // Sin permiso de portapapeles o contexto no seguro: el texto es
      // seleccionable, así que se puede copiar a mano.
      setErrorCopia(true);
    }
  }

  return (
    <dialog
      ref={dialogRef}
      onClose={onClose}
      onClick={e => { if (e.target === dialogRef.current) dialogRef.current?.close(); }}
      aria-labelledby="cita-titulo"
      className="bg-transparent p-0 m-auto backdrop:bg-black/70 max-w-none max-h-none"
    >
      <div className="bg-[#2B221C] text-gray-300 border border-[#3a3028] rounded-lg shadow-2xl w-[min(34rem,calc(100vw-2rem))] max-h-[85vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-4 p-4 border-b border-[#3a3028]">
          <h2 id="cita-titulo" className="text-base font-semibold text-gray-100">
            {es.citaTitulo}
          </h2>
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            aria-label={es.citaCerrar}
            className="text-gray-500 hover:text-[#F27D26] transition-colors shrink-0"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-4">
          <p className="text-xs text-gray-400 leading-relaxed">{es.citaIntro}</p>

          <BloqueCopiable
            etiqueta={es.citaApaEtiqueta}
            texto={apa}
            copiado={copiado === 'apa'}
            onCopiar={() => copiar(apa, 'apa')}
          />

          <BloqueCopiable
            etiqueta={es.citaBibtexEtiqueta}
            texto={bibtex}
            monoespaciado
            copiado={copiado === 'bibtex'}
            onCopiar={() => copiar(bibtex, 'bibtex')}
          />

          {errorCopia && (
            <p className="text-[11px] text-amber-500 leading-snug">{es.citaCopiarError}</p>
          )}

          <div className="flex flex-col gap-3 border-t border-[#3a3028] pt-4">
            {doiVersion
              ? <FilaDoi
                  etiqueta={es.citaDoiVersion}
                  doi={doiVersion}
                  ayuda={es.citaDoiVersionAyuda}
                />
              : <p className="text-[11px] text-amber-500 leading-snug">
                  {es.citaVersionSinArchivar}
                </p>}
            <FilaDoi
              etiqueta={es.citaDoiConcepto}
              doi={CITA.doiConcepto}
              ayuda={es.citaDoiConceptoAyuda}
            />
          </div>

          <a
            href={CITA.repositorio}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-gray-400 hover:text-[#F27D26] transition-colors border-t border-[#3a3028] pt-4"
          >
            <ExternalLink size={13} aria-hidden="true" />
            {es.citaRepositorio}
          </a>
        </div>
      </div>
    </dialog>
  );
}
