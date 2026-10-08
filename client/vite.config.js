import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // доступ с других устройств в локальной сети
    port: 5173,
  },
})
