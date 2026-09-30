import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { convertirManual, idDeTitulo, marcadorImagen } from '../markdown';

const DOCS = new URL('../../../docs/', import.meta.url);

describe('idDeTitulo', () => {
  it('genera el mismo identificador que GitHub', () => {
    expect(idDeTitulo('Configurar el cálculo')).toBe('configurar-el-cálculo');
    expect(idDeTitulo('Contraste: CR y CNR')).toBe('contraste-cr-y-cnr');
    expect(idDeTitulo('Paso 1 — Abrir')).toBe('paso-1--abrir');
    expect(idDeTitulo('Ajuste multi-b')).toBe('ajuste-multi-b');
  });
});

describe('convertirManual', () => {
  it('pone identificador a los títulos y recoge los de segundo nivel en el índice', () => {
    const { html, indice, ids } = convertirManual(
      '# Manual\n\n## Abrir el estudio\n\n### Formatos\n\n## Exportar\n\n## Exportar\n'
    );
    expect(html).toContain('<h2 id="abrir-el-estudio">Abrir el estudio</h2>');
    expect(indice).toEqual([
      { id: 'abrir-el-estudio', titulo: 'Abrir el estudio' },
      { id: 'exportar', titulo: 'Exportar' },
      { id: 'exportar-1', titulo: 'Exportar' },
    ]);
    expect(ids).toEqual(['manual', 'abrir-el-estudio', 'formatos', 'exportar', 'exportar-1']);
  });

  it('abre aparte los enlaces externos y registra los internos', () => {
    const { html, enlacesInternos } = convertirManual(
      'Vea [la cita](#cómo-citar) y [el DOI](https://doi.org/10.5281/zenodo.22714640).'
    );
    expect(enlacesInternos).toEqual(['cómo-citar']);
    expect(html).toContain('<a target="_blank" rel="noopener noreferrer" href="https://doi.org/');
    expect(html).not.toMatch(/<a [^>]*target="_blank"[^>]*href="#/);
  });

  it('marca los enlaces cuyo texto ya es la dirección, para no repetirla al imprimir', () => {
    const { html } = convertirManual('Abra https://difusion-rm.pages.dev o [la cita](https://doi.org/x).');
    expect(html).toContain('<a class="url-a-la-vista" target="_blank" rel="noopener noreferrer" href="https://difusion-rm.pages.dev"');
    expect(html).toContain('<a target="_blank" rel="noopener noreferrer" href="https://doi.org/x"');
  });

  it('marca también los enlaces cuyo texto es el DOI al que llevan', () => {
    const { html } = convertirManual('doi:[10.1148/radiol.11101919](https://doi.org/10.1148/radiol.11101919)');
    expect(html).toContain('<a class="url-a-la-vista" target="_blank" rel="noopener noreferrer" href="https://doi.org/10.1148/radiol.11101919"');
  });

  it('sustituye las imágenes relativas por un marcador y deja las absolutas', () => {
    const { html, imagenes } = convertirManual(
      '![Pantalla](img/pantalla.svg)\n\n![Logo](https://example.org/logo.png)'
    );
    expect(imagenes).toEqual(['img/pantalla.svg']);
    expect(html).toContain(`src="${marcadorImagen(0)}"`);
    expect(html).toContain('src="https://example.org/logo.png"');
  });

  it('convierte los avisos de GitHub en recuadros con título en español', () => {
    const { html } = convertirManual('> [!WARNING]\n> Mire la columna **Enmasc.**');
    expect(html).toContain('<div class="aviso aviso-advertencia" role="note">');
    expect(html).toContain('<p class="aviso-titulo">Advertencia</p>');
    expect(html).toContain('<p>Mire la columna <strong>Enmasc.</strong></p>');
    expect(html).not.toContain('[!WARNING]');
  });

  it('deja como cita normal un blockquote sin aviso', () => {
    const { html } = convertirManual('> Una cita cualquiera.');
    expect(html).toContain('<blockquote>');
  });

  it('envuelve las tablas para que se desplacen en pantallas estrechas', () => {
    const { html } = convertirManual('| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(html).toMatch(/^<div class="tabla-desplazable"><table>/);
  });
});

describe('docs/manual-usuario.md', () => {
  const manual = convertirManual(readFileSync(new URL('manual-usuario.md', DOCS), 'utf-8'));

  it('tiene secciones para el índice', () => {
    expect(manual.indice.length).toBeGreaterThan(5);
  });

  it('no tiene títulos repetidos, que cambiarían sus anclas', () => {
    expect(new Set(manual.ids).size).toBe(manual.ids.length);
  });

  it('cada enlace interno lleva a un título que existe', () => {
    const rotos = manual.enlacesInternos.filter(destino => !manual.ids.includes(destino));
    expect(rotos, `enlaces a anclas inexistentes: ${rotos.join(', ')}`).toEqual([]);
  });

  it('cita las referencias en orden de aparición y todas llevan DOI', () => {
    const fuente = readFileSync(new URL('manual-usuario.md', DOCS), 'utf-8');
    const [texto, lista] = fuente.split('\n## Referencias\n');
    const primeras: number[] = [];
    for (const [, cita] of texto.matchAll(/\[\[([\d–,]+)\]\]\(#referencias\)/g)) {
      for (const parte of cita.split(',')) {
        const [desde, hasta = desde] = parte.split('–').map(Number);
        for (let n = desde; n <= hasta; n++) if (!primeras.includes(n)) primeras.push(n);
      }
    }
    const entradas = lista.split('\n').filter(l => /^\d+\. /.test(l));
    expect(primeras).toEqual(entradas.map((_, i) => i + 1));
    for (const entrada of entradas) expect(entrada).toMatch(/ doi:\[10\.[^\]]+\]\(https:\/\/doi\.org\/10\./);
  });

  it('cada imagen existe junto al manual', () => {
    const faltan = manual.imagenes.filter(ruta => !existsSync(new URL(ruta, DOCS)));
    expect(faltan, `imágenes que no existen: ${faltan.join(', ')}`).toEqual([]);
  });
});
