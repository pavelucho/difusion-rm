# Procesador de difusión — ADC · eADC · cDWI

Aplicación web para post-procesado de resonancia magnética de difusión. Calcula mapas
ADC, eADC y DWI computada (cDWI) a partir de una serie DICOM de difusión.

**Todo el procesamiento ocurre en el navegador.** Las imágenes no se suben a ningún
servidor: se leen, se calculan y se exportan en el equipo del usuario.

> Herramienta de investigación clínica. **No es un dispositivo médico certificado.**
> Los mapas derivados deben interpretarse junto con las imágenes adquiridas originales.

## Puesta en marcha

```bash
npm ci
npm run dev
```

La aplicación queda en `http://localhost:3000`.

| Comando          | Qué hace                                          |
| ---------------- | ------------------------------------------------- |
| `npm run dev`    | Servidor de desarrollo                            |
| `npm run build`  | Compilación de producción en `dist/`              |
| `npm test`       | Pruebas unitarias                                 |
| `npm run lint`   | Verificación de tipos (`tsc --noEmit`, modo estricto) |
| `npm run check`  | Tipos + pruebas + compilación, lo mismo que la CI  |

## Publicación en la web

La aplicación es un sitio estático: `npm run build` deja en `dist/` todo lo necesario,
sin backend. Como el procesamiento ocurre en el navegador, no hay datos de paciente en
tránsito ni almacenados en el servidor, y alojarla es un problema de hosting corriente.

El despliegue completo son 14 archivos y 1,2 MB, muy por debajo de los límites del
plan gratuito de Cloudflare Pages (20 000 archivos y 25 MiB por archivo, con ancho de
banda ilimitado y 500 compilaciones al mes). El plan gratuito basta y sobra.

### Publicar desde el equipo

```bash
npx wrangler login   # abre el navegador y autoriza la sesión
npm run deploy
```

La primera ejecución crea el proyecto; las siguientes lo actualizan. Queda publicado en
`https://difusion-rm.pages.dev`, y desde el panel de Cloudflare se le puede añadir un
dominio propio sin coste.

Para publicar una versión de prueba sin tocar la de producción: `npm run deploy:preview`.

### Publicar automáticamente desde Git

Si el repositorio está en GitHub o GitLab, en *Workers y Pages → Crear → Pages →
Conectar a Git*:

- Comando de compilación: `npm ci && npm run build`
- Directorio de salida: `dist`
- Variable de entorno: `NODE_VERSION` = `22`

### Sobre credenciales

`wrangler login` autoriza por navegador y guarda la sesión en el equipo. No hace falta
ningún token de API, y no debe guardarse ninguno en el repositorio. Si en algún momento
un token llega a compartirse por chat, correo o captura, dese por comprometido y
revóquese desde *Mi perfil → Tokens de API*.

Con otro proveedor (Netlify o equivalente), la configuración es la misma: compilar con
`npm ci && npm run build` y publicar `dist` con Node 22.

`public/_headers` y `public/_redirects` ya traen las cabeceras de seguridad —incluida
una política de contenido que solo permite conexiones al propio origen— y el
enrutamiento de aplicación de página única, en el formato que entienden Cloudflare
Pages y Netlify. Con otro proveedor, tradúzcalas a su configuración.

### Instalación como aplicación

El sitio es una PWA: el navegador ofrece instalarla, y una vez cargada funciona sin
conexión. Es lo que permite usarla en una sala sin red o desde cualquier equipo sin
instalar nada. Las actualizaciones se descargan solas y se aplican al recargar.

## Flujo de uso

1. **Cargar el ZIP** con la serie DICOM de difusión original.
2. **Configurar los parámetros**: b baja de referencia, b alta, b objetivo para la cDWI,
   umbral de ruido, corregistro y, si hay tres o más valores b, ajuste multi-b.
3. **Revisar los mapas** en los paneles sincronizados (ADC, eADC, cDWI, R²).
4. **Exportar** los mapas como serie DICOM en un ZIP, o descargar el registro de
   procesamiento en JSON para trazabilidad.

## Fórmulas (ajuste de dos puntos)

**ADC** — coeficiente de difusión aparente:

```
ADC = ln(S1 / S2) / (b2 − b1)
```

donde `S1` es la señal en `b1` (b baja) y `S2` la señal en `b2` (b alta).

**eADC** — ADC exponencial:

```
eADC = exp(−b2 · ADC)
```

Realza la difusión restringida real y suprime el brillo T2 (*T2 shine-through*). Se
calcula estrictamente a partir del mapa ADC, no como `S2/S1`, para mantener la exactitud
con cualquier b baja.

**cDWI** — DWI computada:

```
cDWI = S1 · exp((b1 − bObjetivo) · ADC)
```

Estima la señal a una b objetivo sintética, sin necesidad de una adquisición larga
adicional.

Con tres o más valores b se puede usar regresión lineal ponderada sobre `ln(S)` frente a
`b`, que además produce un mapa de bondad de ajuste (R²).

## Escalado del DICOM exportado

Los mapas derivados siguen las convenciones habituales de fabricante:

| Mapa | Píxel almacenado          | Rescale Type   | Ventana (centro / ancho) |
| ---- | ------------------------- | -------------- | ------------------------ |
| ADC  | `round(ADC_mm2s · 1e6)`   | `10-6 mm2/s`   | 1500 / 3000              |
| eADC | `round(eADC · 1000)`      | `Ratio x1000`  | 500 / 1000               |
| cDWI | `round(cDWI)`             | —              | percentiles 1 y 99       |

## Limitaciones declaradas

- **Validez del modelo monoexponencial.** Es razonable hasta b ≈ 2000 s/mm². Por encima,
  el ruido se amplifica y la señal se aparta del modelo.
- **Sesgo por microperfusión (IVIM).** Usar una b muy baja (p. ej. b = 0) como referencia
  sobreestima el ADC. Se recomienda b = 100–150 s/mm² para anular ese efecto.
- **Suelo de ruido rectificado.** En zonas de señal muy baja el ruido queda rectificado por
  la reconstrucción en magnitud. El enmascarado de fondo lo mitiga, pero no puede
  revertir el suelo ya presente en las imágenes adquiridas.
- **No apto para decisión clínica.** Herramienta de investigación, no dispositivo médico
  certificado.

## Estructura

```
src/
  lib/diffusion/    lectura y escritura DICOM, mapas, corregistro, estadística
  lib/roi.ts        regiones de interés y rasterizado
  components/       paneles de visualización
  i18n/es.ts        todo el texto de la interfaz
  App.tsx           composición de la interfaz
```

El cálculo pesado vive en un Web Worker (`src/lib/diffusion/worker.ts`), de modo que la
interfaz no se bloquea con series grandes.

## Verificación con estudios reales

Las pruebas incluyen una suite que se ejecuta contra estudios DICOM de verdad. No hay
ninguno en el repositorio —contienen datos de paciente y no deben versionarse—, así que
se le indica dónde están:

```bash
ESTUDIOS_DICOM=/ruta/a/estudios npm test
```

La carpeta debe contener una subcarpeta por estudio. Sin esa variable, esa suite se
salta y el resto de pruebas se ejecuta igual.

Comprueba, para cada estudio: que todas las imágenes se leen, que el valor b sale de un
tag de valor b y no de una inferencia, que hay al menos dos valores b, que los píxeles
tienen rango plausible, que los cortes emparejan sin descartes y que el ADC medio cae en
rango fisiológico. Además exporta un mapa ADC y lo vuelve a leer con el propio lector
para verificar la transfer syntax, el UID de serie y el escalado.

## Trazabilidad

Cada DICOM derivado lleva en su descripción de derivación (0008,2111) la fórmula
aplicada, el umbral de enmascarado, el modo de corregistro y la versión de la
aplicación que lo calculó, que también aparece en el pie de la interfaz.
