// Custom Vercel Build Output API v3 Lambda entrypoint for our Next.js
// standalone build.
//
// WHY THIS EXISTS: Vercel's own build orchestration (both `vercel build`
// locally AND a real `vercel --prod` remote build) reproducibly kills
// `next build` with zero error output, right between "Skipping validation
// of types" and "Collecting page data" — every single time, regardless of
// env vars, worker-thread config, Node/Vercel CLI version, or memory
// limits (all individually ruled out as the cause). A plain `next build` /
// `npm run build` run OUTSIDE that orchestration layer always succeeds,
// with identical code/env/node_modules. This matches a known Vercel
// platform bug around their "Applying modifyConfig from Vercel" step for
// this Next.js version.
//
// THE FIX: build normally with `output: 'standalone'` in next.config.ts
// (proven reliable), then hand-assemble the Vercel Build Output API v3
// deployment ourselves — this file is the Lambda entrypoint, copied into
// place by scripts/build-vercel-output.sh, which points straight at
// NextServer's own request handler (the same pattern @vercel/next's own
// builder generates internally per-route, just done once here for a
// single function) instead of going through the standalone server.js's
// `startServer()` / `http.createServer().listen()` path — that path is
// meant for a long-running process on a normal Node host, not a
// per-invocation Lambda.
//
// See DEPLOY.md "Step 4 — Deploy to Vercel" for the full deploy command,
// and scripts/build-vercel-output.sh for how this file gets copied next to
// the standalone build and wired up in .vercel/output.
process.env.NODE_ENV = 'production'
process.chdir(__dirname)

const path = require('path')
const dir = path.join(__dirname)

// nextConfig blob mirrors what standalone's own server.js embeds — written
// alongside this file at packaging time (see build-vercel-output.sh) so we
// don't have to re-derive Next's config-resolution logic here.
const nextConfig = require('./vercel-launcher.config.json')

const NextServer = require('next/dist/server/next-server').default

const server = new NextServer({
  dir,
  dev: false,
  conf: nextConfig,
  customServer: false,
})

const handler = server.getRequestHandler()

let prepared = null
module.exports = async (req, res) => {
  if (!prepared) {
    prepared = server.prepare ? server.prepare() : Promise.resolve()
  }
  await prepared
  return handler(req, res)
}
