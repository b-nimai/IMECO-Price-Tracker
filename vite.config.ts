import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      // import.meta.dirname rather than __dirname — the latter is unavailable under Vite's
      // native config loader, which is due to become the default.
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
})
