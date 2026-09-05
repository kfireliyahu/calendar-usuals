import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { cpSync, mkdirSync } from 'fs';

// manifest.json and icons/ used to be copied into dist/ by hand, which meant a
// fresh `npm run build` produced a dist that Chrome would not load. Copy them as
// part of the build instead.
function copyStatic(): Plugin {
  return {
    name: 'wlp-copy-static',
    apply: 'build',
    closeBundle() {
      const dist = resolve(__dirname, 'dist');
      mkdirSync(dist, { recursive: true });
      cpSync(resolve(__dirname, 'manifest.json'), resolve(dist, 'manifest.json'));
      cpSync(resolve(__dirname, 'icons'), resolve(dist, 'icons'), { recursive: true });
    },
  };
}

export default defineConfig({
  plugins: [tailwindcss(), react(), copyStatic()],
  build: {
    // Content scripts are minified onto one line, so an uncaught error reports
    // as content.js:9 with no useful frames. Source maps make DevTools resolve
    // stack traces back to the .tsx that threw.
    sourcemap: true,
    rollupOptions: {
      input: {
        content: resolve(__dirname, 'src/content.tsx'),
        background: resolve(__dirname, 'src/background.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
        dir: resolve(__dirname, 'dist'),
      },
    },
  },
});
