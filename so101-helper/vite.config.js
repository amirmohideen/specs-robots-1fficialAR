import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      input: {
        home: resolve(import.meta.dirname, 'index.html'),
        calibration: resolve(import.meta.dirname, 'calibration.html'),
        assembly: resolve(import.meta.dirname, 'assembly.html'),
      },
    },
  },
});
