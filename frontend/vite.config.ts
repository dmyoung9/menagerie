import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Fixture runs must not load an untracked developer .env file.
  envDir: process.env.MENAGERIE_FIXTURE_ENV_DIR,
  plugins: [tailwindcss()],
  resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
  build: {
    rollupOptions: {
      // Upstream UI sources also target RSC hosts; this application is a SPA.
      onwarn(warning, warn) {
        if (
          warning.code === 'MODULE_LEVEL_DIRECTIVE' &&
          warning.message.includes('use client')
        )
          return;
        warn(warning);
      },
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/@base-ui/')) return 'base-ui';
          if (id.includes('/node_modules/')) return 'vendor';
        },
      },
    },
  },
});
