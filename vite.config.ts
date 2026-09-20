import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { resolve } from 'node:path'

export default defineConfig({
  root: 'src',
  base: './',
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: '../dist/ui',
    emptyOutDir: false,
    rollupOptions: { input: resolve(process.cwd(), 'src/git-workspace.html') },
  },
})
