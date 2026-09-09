import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

// Instalable y utilizable sin conexión: una vez cargada, la aplicación funciona
// aunque el equipo esté sin red. Las actualizaciones se aplican al recargar.
registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
