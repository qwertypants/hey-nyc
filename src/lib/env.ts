/**
 * INTEGRATION NOTES (src/lib/env.ts)
 *
 * The only module that knows about Vite's `import.meta.env`. It exists so the rest of
 * `src/lib` and `src/data` can read build-time configuration without importing a Vite
 * type file, and so `tsconfig.json` needs no change to make `import.meta.env` typecheck
 * (the project's `types` array deliberately excludes `vite/client`).
 *
 * Adding `src/vite-env.d.ts` with `/// <reference types="vite/client" />` later is safe:
 * these declarations merge with Vite's rather than conflicting with them.
 *
 * No default value is invented here — each reader supplies its own fallback.
 */

declare global {
  interface ImportMetaEnv {
    readonly BASE_URL: string;
    readonly VITE_BASEMAP_STYLE_URL?: string;
    readonly VITE_GEOCODER_CONTACT?: string;
  }

  interface ImportMeta {
    readonly env: ImportMetaEnv;
  }
}

export {};
