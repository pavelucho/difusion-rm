# Registro de cambios

Formato basado en [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/).

## [No publicado]

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
