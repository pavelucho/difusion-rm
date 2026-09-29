# Registro de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

## [Sin publicar]

### Corregido — comparación con el ADC del equipo
Al pasar el motor de la aplicación por los estudios reales guardados en Horos, simulando
que se arrastra el estudio completo con los valores por defecto, 74 de 94 daban un ADC
no comparable con el del equipo. Las causas:

- **Se promediaban con la DWI imágenes que el equipo deriva de ella.** GE guarda el eADC
  con el valor b de la DWI (b = 1000) y archiva además una copia sin procesar
  («ORIG: …»); las dos se promediaban con la DWI y el ADC salía entre −24 % y +80 % del
  equipo. Ahora se apartan del cálculo el eADC, la FA, el ADC exponencial y el tensor
  (salvo su b = 0), y la copia ORIG cuando el estudio trae también la serie procesada,
  que es de la que sale el ADC del equipo. Un aviso dice cuáles se han apartado.
- **Se tomaban como adquiridas imágenes de b calculada.** Siemens (*CALC_BVAL*) y GE
  (*DW_Synthetic*) sintetizan imágenes a b 1500–2000 a partir de su propio ADC; como la
  b alta por defecto es la mayor, la aplicación calculaba el ADC con ellas, en círculo.
  Con una b 1400 adquirida y otra calculada a 1400, las promediaba. Ya no entran.
- **Se metían como b = 0 series que no son de difusión** cuando compartían marco de
  referencia y matriz con la DWI, aunque tuvieran otra orientación (en el Avanto, una T1
  sagital, una T2 axial y una T1 coronal), y la aplicación llegaba a llamar a la serie de
  difusión «t1_se_sag_p2_cer». Un conjunto de difusión solo admite ahora imágenes con el
  valor b leído de un tag, con la misma orientación, matriz y tamaño de píxel, y no reúne
  series distintas salvo cuando el equipo reparte los valores b de una misma adquisición
  en varias (mismos TR y TE, mismos cortes y valores b que no se repiten). Dos
  adquisiciones, o una serie y su copia, quedan como opciones separadas del desplegable.
- **La pestaña Validación emparejaba el ADC del equipo por orden de corte.** Cuando el
  mapa del equipo tenía menos cortes que la DWI, venía duplicado o el estudio traía dos
  adquisiciones, cada ROI se comparaba con otra altura del paciente sin ningún aviso.
  Ahora se usa el mapa de la misma adquisición y se empareja por posición (±0,5 mm).
  Donde el equipo no tiene corte, la pestaña lo dice y no deja añadir el par, el panel
  *ADC del equipo* lo indica y la barra lateral avisa de cuántos cortes quedan sin pareja.
- **El ADC del equipo no se convertía a mm²/s.** Se comparaba 800 (10⁻⁶ mm²/s) con
  0,0008 (mm²/s), así que el coeficiente de Lin, el sesgo y el Bland-Altman no tenían
  sentido, y el panel *ADC del equipo* se veía en blanco con la ventana del ADC. Ahora se
  convierte al leerlo, con la unidad que declara el DICOM (el tipo de reescalado o, en
  GE, la descripción de la serie) o, si no la declara, como en Siemens, deducida de la
  magnitud de los valores. Si la declaración no cuadra con los valores, se avisa.
- Un panel sin imagen seguía mostrando la del corte anterior: el *ADC del equipo* donde
  el equipo no tiene corte, o el *R²* al volver del ajuste multi-b.

Con la corrección, en los 94 estudios el conjunto elegido es siempre la difusión
adquirida y trae asociado su ADC del equipo, leído en 10⁻⁶ mm²/s.

### Cambiado — cálculo del ADC según las guías
- **El ajuste multi-b es de mínimos cuadrados sin ponderar**, como el de los equipos y el
  del software de referencia de QIBA. Hasta ahora cada punto se ponderaba con el cuadrado
  de su señal medida, una ponderación que arrastra el ruido de la propia medida y sesga
  el ADC (Veraart et al., NeuroImage 2013).
- **Con tres o más valores b, el cálculo por defecto es ese ajuste con todos ellos**, y la
  b baja por defecto es la menor del protocolo. Antes era un cálculo de dos puntos con la
  primera b ≥ 150 s/mm², un criterio que no recoge ninguna guía: PI-RADS v2.1 y el perfil
  QIBA de difusión sitúan la b baja en 0–100 s/mm². El cálculo de dos puntos con otra b
  baja sigue disponible a mano.
- El aviso ámbar «b baja < 150 s/mm²», que recomendaba lo contrario que las guías, es
  ahora una nota gris que explica qué incluye el ADC, y solo aparece cuando la serie
  permite otra elección. Los DICOM exportados ya no llevan la marca *[LOW-B<150]*: su
  descripción de serie lista los valores b del cálculo y la de derivación declara el
  ajuste, como pide QIBA. El registro de procesamiento anota el algoritmo de ajuste.
- El aviso de cortes descartados cuenta imágenes y se refiere a todos los valores b del
  cálculo, no a «las dos series seleccionadas».
- El cálculo de los mapas pasa del worker a `calcularMapas` (`estudio.ts`), que usan
  también las pruebas: comprueban exactamente lo que calcula la aplicación.

En los 94 estudios de Horos, en el tejido con ADC del equipo entre 0,5 y 1,2 × 10⁻³ mm²/s,
el ADC calculado con los valores por defecto queda dentro de ±5 % del equipo en 82 (antes
71), entre −3,0 y +7,6 % (antes, de −32 a +28 %). En los 23 protocolos con tres o más
valores b queda dentro de ±5 % en 13 (antes 2), con mediana +5,0 % (antes −7,6 %). Queda
un sesgo positivo del orden del que un estudio multicéntrico del NCI atribuye a que
Siemens calcula su ADC con la b efectiva de la secuencia (Newitt et al., 2018).

### Cambiado
- Al abrir el estudio se elige la serie de difusión que trae el ADC del equipo; después,
  la de más valores b, la traza antes que las direcciones sueltas de un tensor y la de más
  cortes. Antes se elegía la de más valores b aunque no tuviera ADC del equipo.
- El desplegable de series solo deja elegir series de difusión. Las demás se ven en gris
  con el motivo (*sin valores b*, *eADC del equipo*, *copia sin procesar*…), y las que
  tienen ADC del equipo lo indican.
- Las imágenes de la serie de difusión sin valor b en ningún tag ya no se toman como
  b = 0: se dejan fuera del cálculo, con aviso.
- El registro de procesamiento anota la serie de difusión usada y, si hay ADC del equipo,
  su serie, la unidad en que venía, de dónde se sacó y los cortes sin pareja.

### Añadido
- Pruebas de regresión con DICOM sintéticos escritos como los guardan GE y Siemens: eADC
  y copia ORIG, DWI sintética, b calculadas, T1 y T2 en el mismo marco y matriz, b
  repartidas en series, tensor, ADC del equipo con menos cortes, duplicado o de dos
  adquisiciones, y unidades. Pasados por el motor de la versión 1.2.0, esos mismos casos
  reproducen los defectos.
- Pruebas del cálculo por defecto: con dos valores b, entre ambos; con tres o más y señal
  con perfusión, el ajuste sin ponderar reproduce el ADC del equipo (con la ponderación
  S² salía un +2 % y con la b baja antigua un −8 %); y la descripción de los mapas
  exportados declara los valores b y el ajuste.
- La verificación opcional contra estudios reales (`ESTUDIOS_DICOM`) sigue el camino de
  la aplicación con el estudio completo y comprueba además que no entren imágenes
  derivadas y que el ADC del equipo quede en mm²/s y emparejado por posición.

## [1.2.0] — 2026-09-28

### Añadido — manual de uso
- Manual de uso completo en la propia aplicación, en `/manual`: cómo abrir un estudio,
  qué hace cada parámetro, cómo leer y medir los mapas, cómo exportarlos y qué
  significa cada aviso, con un esquema numerado de la pantalla, solución de problemas,
  glosario y fórmulas. Quien usa la herramienta entra por la dirección web y no ve el
  README, igual que pasaba con la cita.
- Se abre desde la barra lateral, la pantalla de bienvenida y la barra inferior, en otra
  pestaña para consultarlo sin perder el estudio abierto, y funciona sin conexión como
  el resto de la aplicación.
- Se escribe en Markdown (`docs/manual-usuario.md`), que es también lo que se lee en
  GitHub, y se convierte a HTML al compilar: el navegador no carga ningún intérprete de
  Markdown. Una prueba comprueba que cada enlace interno lleva a un título que existe y
  que cada imagen está en su sitio.
- Versión para imprimir o guardar en PDF: portada con índice y versión, páginas
  numeradas en Chrome y Edge, y las direcciones de los enlaces escritas en el papel.

### Cambiado
- *Manual de uso* y *Cómo citar* son ahora botones con icono y borde, siempre a la vista
  en la barra inferior. *Cómo citar* era un texto pequeño junto al aviso legal y pasaba
  desapercibido. En la barra lateral, *Manual de uso* también es un botón.

### Corregido
- **Pulsar la pestaña Validación dejaba la aplicación en blanco** y se perdía el
  trabajo: la pestaña declaraba un hook de React solo mientras estaba abierta. Pasaba
  con todo estudio que trae el ADC del equipo, que es cuando esa pestaña aparece.
- **El porcentaje de vóxeles enmascarados de la tabla de ROI se quedaba corto**: una ROI
  con el 99 % de sus vóxeles excluidos mostraba un 50 %. Una ROI sin ningún vóxel válido
  daba media 0 en lugar de *No hay vóxeles válidos*, y así podía entrar en las tablas de
  contraste y de validación.
- Las presintonías de ventana del ADC (0-2000, 0-3000, 0-4000) quedaban debajo del
  selector de mapa del panel y no se podían pulsar.
- Tras cambiar de serie o abrir otro estudio, los controles seguían mostrando la b
  objetivo, el multi-b y el corregistro anteriores, aunque el cálculo se había hecho con
  los valores por defecto; y si el estudio nuevo tenía menos cortes que el que se estaba
  viendo, la aplicación se quedaba en blanco. Ahora los controles muestran lo calculado,
  la vista vuelve al primer corte y, al abrir otro estudio, se borran las ROI del
  anterior. Los pares de validación se conservan: acumularlos entre pacientes es su uso.
- Los mapas ADC del equipo, que no llevan valor b, disparaban el aviso «No se pudo leer
  el valor b» en todo estudio que los incluye.
- El registro de procesamiento declaraba siempre la versión «1.0»; ahora lleva la de la
  compilación.
- La ayuda de la pestaña Fidelidad no advertía que, con el ajuste de dos puntos, la DWI
  calculada coincide siempre con la adquirida por construcción.

## [1.1.0] — 2026-09-11

### Añadido — cómo citar, dentro de la aplicación
- El DOI estaba solo en el README, que no ve quien usa la herramienta: entra por la
  dirección web, calcula sus mapas y se va. Un enlace en el pie abre la referencia en
  APA y la entrada BibTeX ya formadas y copiables.
- La versión de la cita sale de la propia compilación, no escrita a mano, y el DOI se
  busca indexado por versión: si esa versión todavía no está archivada, se cita el de
  concepto y se avisa. Así la aplicación no puede citar un DOI que corresponde a otro
  código.
- Se distinguen los dos DOI con su explicación: citar el de concepto en la sección de
  métodos rompe la reproducibilidad, porque apunta a lo que se publique después.

### Añadido — archivo citable
- Publicación en Zenodo con DOI: `.zenodo.json` con la autoría y el ORCID, y
  `CITATION.cff` para el botón *Cite this repository* de GitHub.

## [1.0.0] — 2026-09-11

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
