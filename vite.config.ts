import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// BASE_PATH is set by the deploy workflow for GitHub Pages (/<repo>/); local runs use '/'.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1600,
    rollupOptions: {
      output: {
        manualChunks: {
          ol: ['ol'],
          supabase: ['@supabase/supabase-js'],
          exporters: ['xlsx', 'jspdf', 'jspdf-autotable'],
        },
      },
    },
  },
  server: { host: '127.0.0.1', port: 5173 },
});
