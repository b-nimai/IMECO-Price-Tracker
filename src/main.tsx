import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App';
import './index.css';

// No ThemeProvider by design. Dark is pinned on <html> in index.html: this runs unattended on
// a wall display, so a theme toggle is a hazard rather than a feature — one stray keypress and
// the screen is wrong until someone walks over to it.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
