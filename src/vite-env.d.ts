/// <reference types="vite/client" />

// Replaced at build time by the `define` block in vite.config.ts.
declare const __BUILD_SHA__: string;
declare const __BUILD_TIME__: string;

declare module '*.mdx' { const Component: React.ComponentType; export default Component; }
declare module '*.md' { const Component: React.ComponentType; export default Component; }
