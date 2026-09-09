# Registro de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

## [No publicado]

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
