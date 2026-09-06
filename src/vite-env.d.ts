/// <reference types="vite/client" />

// Replaced at build time by the `define` block in vite.config.ts.
declare const __BUILD_SHA__: string;
declare const __BUILD_TIME__: string;

// Every docs page is `.mdx` (see src/pages/DocsContent/); nothing imports
// `.md` directly, so no declaration for it.
declare module '*.mdx' { const Component: React.ComponentType; export default Component; }
