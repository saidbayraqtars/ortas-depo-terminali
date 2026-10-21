const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');

module.exports = defineConfig({
  root: 'client',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1500 },
  server: {
    port: 5173,
    proxy: { '/yonetim/api': 'http://127.0.0.1:5480', '/apk': 'http://127.0.0.1:5480', '/kur': 'http://127.0.0.1:5480' },
  },
});
