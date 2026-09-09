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
