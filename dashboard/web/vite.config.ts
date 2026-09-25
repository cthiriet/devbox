import { existsSync } from "node:fs"
import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/**
 * Where the bundle goes, and why it is not `dist/`.
 *
 * The deployment manifest, `deploy.json`, declares `publicDir: "public"`, and it is Caddy
 * that serves that directory in production, without going through Bun. The application
 * rsync even excludes it explicitly (see scripts/simulate-deploy.sh): the static files
 * travel by the other half of the deployment. Building into `dashboard/public/` is
 * therefore the only output the hosting platform ever looks at - a `dist/` would be a
 * directory nobody serves.
 *
 * `emptyOutDir` has to be explicit: Vite refuses to empty a directory outside its own root
 * unless asked, and `public/` is now a build artefact whole (the .gitignore says so too),
 * not a place where anyone deposits a file by hand.
 */
/**
 * The slots a private extension fills (src/extension/none.tsx): its own when a deployment deposited
 * them in src/extension/deposited/, the empty stub otherwise. Inside src/ and not beside the
 * extension's server half, because a file outside web/ resolves `react` from no node_modules at all.
 * tsconfig.app.json lists the same two paths, in the same order.
 */
const deposited = path.resolve(import.meta.dirname, "./src/extension/deposited/index.tsx")
const slots = existsSync(deposited)
  ? deposited
  : path.resolve(import.meta.dirname, "./src/extension/none.tsx")

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@extension": slots,
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  build: {
    outDir: path.resolve(import.meta.dirname, "../public"),
    emptyOutDir: true,
  },
  server: {
    port: 3022,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3021",
        changeOrigin: true,
        /**
         * The terminal is a WebSocket under /api/, and http-proxy does not upgrade one
         * unless it is told to. Without this line the handshake is answered by Vite's own
         * dev server, which knows nothing about it, and the card fails with close code 1006
         * in development alone - the one place the failure looks like a bug in the server.
         */
        ws: true,
        /**
         * The Origin is rewritten, and that is not a way around the anti-CSRF protection:
         * it is what makes it exercisable in development instead of turned off.
         *
         * src/guard.ts compares the Origin it receives against PUBLIC_URL character for
         * character. In development the page lives on :3022 and the server believes itself
         * to be on :3021, so every POST would arrive with the wrong origin and be refused -
         * and the temptation would then be to loosen the check on the server, which is to
         * say never to exercise, in development, the one path that matters in production.
         * The lie is here, in the proxy, and it does not cross the workstation's edge.
         */
        configure: (proxy) => {
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("origin", "http://localhost:3021")
          })
          // The same lie, on the other kind of request. `proxyReq` never fires for an
          // upgrade - http-proxy emits `proxyReqWs` instead - so without this the terminal's
          // handshake would arrive with the :3022 origin and be refused by the very check
          // this rewriting exists to keep exercisable.
          proxy.on("proxyReqWs", (proxyReq) => {
            proxyReq.setHeader("origin", "http://localhost:3021")
          })
        },
      },
    },
  },
})
