import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

// Instalable y utilizable sin conexión: una vez cargada, la aplicación funciona
// aunque el equipo esté sin red. Las actualizaciones se aplican al recargar.
registerSW({ immediate: true });

// El manual de uso se sirve en /manual desde esta misma aplicación, así que
// también funciona sin conexión. Se carga aparte para no engordar la herramienta.
const Manual = lazy(() => import('./manual/Manual'));
const esManual = /^\/manual\/?$/.test(window.location.pathname);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {esManual ? (
      <Suspense fallback={null}>
        <Manual />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);
