// Bundles the ADMINISTRATION console Preact SPA → public/console/app.js
// JSX is compiled via the automatic runtime with preact's jsx-runtime.
import { build } from 'esbuild';

const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['admin-src/main.tsx'],
  outfile: 'public/console/app.js',
  bundle: true,
  minify: !watch,
  sourcemap: watch,
  format: 'iife',
  target: ['es2020'],
  jsx: 'automatic',
  jsxImportSource: 'preact',
  loader: { '.svg': 'text' },
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
};

if (watch) {
  const { context } = await import('esbuild');
  const ctx = await context(options);
  await ctx.watch();
  console.log('[esbuild] watching admin-src…');
} else {
  await build(options);
  console.log('[esbuild] admin bundle written → public/console/app.js');
}
