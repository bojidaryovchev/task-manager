import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Widget } from './widget/Widget.js';
import './styles.css';

/**
 * Entry point for the desktop widget window.
 *
 * A separate HTML entry rather than a route inside the main app, so the widget
 * ships its own small bundle and cannot accidentally pull the whole UI into a
 * window that is 210 pixels wide.
 */
const container = document.getElementById('root');
if (!container) throw new Error('Root element missing');

createRoot(container).render(
  <StrictMode>
    <Widget />
  </StrictMode>,
);
