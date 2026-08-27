/// <reference types="vite/client" />

// Static-asset import declarations. Vite resolves `import foo from './foo.svg'`
// to a URL string at build time; this ambient declaration informs TypeScript.
// `vite/client` already declares `*.svg`; this block is redundant-if-merged
// but kept explicit so SVG imports keep working even if the
// `vite/client` reference is ever removed.
declare module '*.svg' {
  const src: string;
  export default src;
}
