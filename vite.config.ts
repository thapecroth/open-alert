import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const clientFile = (name: string) => fileURLToPath(new URL(`./src/client/${name}`, import.meta.url));

export default defineConfig({
  root: "src/client",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: clientFile("index.html"),
        units: clientFile("units.html"),
      },
    },
  },
  server: { port: 5173 },
});
