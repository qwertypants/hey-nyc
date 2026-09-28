import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { stubPrefersReducedMotion } from './helpers/reducedMotion';

// jsdom has no WebGL, no ResizeObserver and no matchMedia. MapLibre cannot be constructed in
// this environment, so component tests render against a `MapController` double (see
// tests/helpers/fakeController.ts) and the camera tests against a `Map` double (see
// tests/helpers/fakeMap.ts). These stubs exist so that merely importing maplibre-gl does not
// explode.

beforeEach(() => {
  // Motion allowed is the default every other test was written against; a test that needs the
  // other answer calls `stubPrefersReducedMotion(true)` itself, and `unstubAllGlobals` below
  // restores this one.
  stubPrefersReducedMotion(false);

  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  vi.stubGlobal('IntersectionObserver', ResizeObserverStub);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
