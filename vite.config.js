import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs: dist/index.html references ./assets/... and the game
  // fetches ./media/... (src/core/assets.js mediaUrl), so the build runs from
  // any sub-path or static host, not only from a domain root.
  base: './',
  // public/ (media/tex, media/hdri, media/sfx, media/CREDITS.md) is copied to
  // dist/ as-is by Vite's default publicDir.
  publicDir: 'public',
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    // Keep every binary a real file, never a data: URI (hosting CSP).
    assetsInlineLimit: 0,
  },
});
