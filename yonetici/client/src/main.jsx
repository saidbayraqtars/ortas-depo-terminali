import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { HataSiniri, hataBildir } from './lib.jsx';
import './styles.css';

// Çizim dışındaki hatalar (olay işleyici, söz) da sunucu günlüğüne düşsün.
window.addEventListener('error', (e) => hataBildir(e.message, e.error && e.error.stack));
window.addEventListener('unhandledrejection', (e) => hataBildir(`Söz hatası: ${(e.reason && e.reason.message) || e.reason}`, e.reason && e.reason.stack));

createRoot(document.getElementById('root')).render(
  <HataSiniri anahtar="kok">
    <App />
  </HataSiniri>,
);
