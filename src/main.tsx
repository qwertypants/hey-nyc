import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { createMapController } from './map/controller';
import './index.css';

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

createRoot(container).render(
  // StrictMode is kept: it double-invokes effects in development, which is exactly the
  // check that creating and destroying the map controller in an effect is correct.
  // `createMapController` returns the SAME controller for the same container, so the double
  // mount cannot produce a second WebGL context.
  //
  // This is also the ONLY file that binds the UI to the map engine. `App` takes the factory
  // as a prop precisely so the component tree can be rendered — and tested — without a WebGL
  // context, and so MapLibre is not in the UI layer's module graph at all.
  <StrictMode>
    <App createController={createMapController} />
  </StrictMode>,
);
