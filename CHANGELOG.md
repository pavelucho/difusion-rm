# Registro de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

## [No publicado]

### Corregido — estudios completos del PACS
- **Un estudio exportado entero no se podía procesar.** La aplicación daba por hecho
  que solo había la serie de difusión; con las 21 series de un examen real (T1, T2,
  STIR, dinámicos) trataba como b = 0 todo lo que no lleva valor b y lo promediaba
  junto a la difusión, mezclando además matrices de 256, 512 y 1024 px.
- Ahora se inventaría el estudio por series, se detecta la de difusión y el cálculo
  se hace solo sobre ella. Si hay más de una candidata, se puede cambiar desde un
  desplegable, y la aplicación dice qué serie está usando.
- Las imágenes de distinta matriz ya no se promedian entre sí aunque coincidan en
  posición y valor b: no son repeticiones, son secuencias distintas.
- Los archivos que no pueden ser imágenes se descartan por el nombre antes de
  descomprimirlos. Un export de PACS trae dentro el visor de escritorio, su
  instalador y PDFs; se estaban descomprimiendo cientos de megas para nada.

### Publicado
- Primera publicación en https://difusion-rm.pages.dev (Cloudflare Pages, plan
  gratuito). Acceso libre, sin restricciones. Verificado en producción: HTTPS,
  cabeceras de seguridad aplicadas, service worker activo con 10 recursos en caché
  y manifiesto instalable.

### Añadido — usable sin preparar nada
- El estudio se abre arrastrándolo a la ventana: carpeta, CD, ZIP o archivos DICOM
  sueltos, incluidos los que vienen sin extensión. Antes solo se aceptaba un ZIP.
- Botón para abrir la carpeta del estudio directamente, sin comprimir nada.
- Pantalla inicial que explica en tres pasos qué hace la herramienta y recuerda que
  el cálculo ocurre en el propio equipo.
- `npm run empaquetar` genera el ZIP listo para subir desde el panel de Cloudflare,
  para publicar sin usar la terminal.

### Añadido — despliegue
- Publicación en Cloudflare Pages con `npm run deploy`, autenticando por navegador
  con `wrangler login`: el proyecto no guarda ni necesita ningún token de API.
- `wrangler.toml` y script de despliegue de vista previa.

### Cambiado — despliegue
- Los mapas de origen dejan de generarse en la compilación de producción: publicaban
  el código fuente completo y triplicaban el peso del despliegue (4,7 MB a 1,2 MB).

### Corregido — fase 2
- **La b baja y la b alta salían iguales en series de dos valores b.** La regla de
  preferir una referencia >= 150 s/mm² elegía el único valor alto disponible, y el
  cálculo se detenía con «valores b idénticos». Ahora la referencia se busca solo
  entre los valores por debajo de la b alta. Detectado ejecutando la aplicación
  sobre un estudio real de dos valores b, el caso clínico habitual.
- **El ADC del equipo nunca llegaba a la interfaz.** `groupAndAverageSlices` lo
  descartaba y el worker lo buscaba después en ese mismo resultado. Ahora la
  función devuelve las series de difusión y los mapas del equipo por separado.
- **El meta-encabezado del DICOM exportado describía el archivo original.**
  Conservaba su SOP Instance UID y, en estudios comprimidos, su transfer syntax,
  de modo que el receptor intentaría descomprimir píxeles ya en claro. Ahora se
  reescriben los tres tags del meta.
- El emparejamiento de cortes exigía correspondencia en todos los valores b aunque
  el modo de dos puntos solo use dos; ahora depende del modo de cálculo.
- El mensaje «Identical b-values» aparecía en inglés desde el núcleo de cálculo.

### Añadido — fase 2
- Los avisos del worker (archivos ilegibles, valores b deducidos de texto) se
  muestran en la interfaz; antes se enviaban y nadie los pintaba.
- Prueba de ida y vuelta: se exporta un mapa ADC y se vuelve a leer con el propio
  lector, comprobando transfer syntax, UID de serie y el escalado ADC · 1e6.

### Añadido
- Lectura de DICOM comprimido en JPEG sin pérdida (1.2.840.10008.1.2.4.57 y .4.70),
  incluida la reconstrucción de la Basic Offset Table cuando el equipo la deja vacía.
- Módulo `b-value.ts`: lectura del valor b por orden de fiabilidad (tag estándar,
  secuencia de difusión, tags de Siemens, GE y Philips, nombre de secuencia y
  descripción de serie), con registro de la procedencia de cada valor.
- Módulo `pixel-data.ts`: lectura de píxeles según transfer syntax, con big endian,
  detección de multifotograma y error explícito para lo que no se sabe decodificar.
- Aviso al usuario cuando hay archivos DICOM ilegibles o valores b deducidos de texto.
- Pruebas del lector de valor b (14) y verificación opcional contra estudios reales
  mediante la variable `ESTUDIOS_DICOM`.

### Corregido
- **El valor b del tag estándar (0018,9087) se leía como texto.** Ese tag es FD
  (binario), así que `dataset.string()` devolvía cadena vacía y `parseFloat` daba
  NaN — que no es `undefined`, de modo que los respaldos de fabricante nunca se
  probaban y toda la serie acababa con b = 0. Verificado sobre un estudio real de
  GE: antes b = 0, ahora b = 800.
- **Los archivos comprimidos se leían como si no lo estuvieran.** Los bytes del
  flujo JPEG se interpretaban como píxeles. En el mismo estudio de GE eso daba
  20 787 muestras en el rango completo de 16 bits con un 48,6 % de valores
  negativos; ahora da los 65 536 píxeles reales en el rango 0–1938.
- La detección del ADC de fabricante exigía solo que «adc» apareciera en la
  descripción de serie, lo que también acierta con «eADC». Ahora se apoya en
  ImageType, RescaleType y ADC como palabra delimitada.
- Los archivos que fallaban al leerse desaparecían en silencio; ahora se cuentan
  por motivo y se informan.

## [Fase 0]

### Añadido
- Repositorio propio con verificación de tipos, pruebas y compilación en integración continua.
- Declaraciones de tipos para `dcmjs`, que antes entraba como `any` implícito.

### Cambiado
- TypeScript en modo estricto (`strict`, `noUnusedLocals`, `noUnusedParameters`).
- El cálculo de contraste (CR/CNR) de la interfaz pasa a usar `computeContrast`, en lugar
  de repetir la fórmula en línea.
- Interfaz declarada en español (`lang="es"`) y con título propio.

### Corregido
- El aviso `[LOW-B<150]` se estampaba en todas las series exportadas en modo multi-b,
  porque `params.bLow` llegaba sin definir y se comparaba contra 0.

### Eliminado
- 25 scripts `fix_*.cjs` de parcheo automático heredados de la generación inicial.
- Dependencias declaradas y nunca usadas: `motion`, `@radix-ui/*` (5 paquetes),
  `tailwind-merge`, `class-variance-authority`, `clsx`, `esbuild`, `tsx`, `autoprefixer`.
- Plantilla de AI Studio: `.env.example` con `GEMINI_API_KEY`, `metadata.json`, y el
  `package-lock.json` heredado, que impedía `npm ci` fuera de la plataforma original.
