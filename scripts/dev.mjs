// dev.mjs — launch the desktop shell in development mode.
//
// Development mode drives the checked-out repo's built harness
// (apps/cli/lib/bin.js --profile web) with the system Node, so the repo's
// existing node_modules and native addons are used unchanged. The shell's
// main.mjs spawns the harness and opens the window.

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktop = path.resolve(__dirname, '..')
const repoRoot = path.resolve(desktop, '..')
const require = createRequire(import.meta.url)

// Locate the electron binary from this project's node_modules.
const electronEntry = require(path.join(desktop, 'node_modules', 'electron'))
const electronBin = typeof electronEntry === 'string'
  ? electronEntry
  : electronEntry.default

if (!electronBin || !require('node:fs').existsSync(electronBin)) {
  console.error(
    'Electron not installed. Run `pnpm --dir desktop install` (or `npm install` in desktop/) first.',
  )
  process.exit(1)
}

for (const rel of ['apps/cli/lib/bin.js', 'apps/web/dist/index.html']) {
  if (!require('node:fs').existsSync(path.join(repoRoot, rel))) {
    console.error(`Harness build missing (${rel}). Run \`pnpm build\` at the repo root.`)
    process.exit(1)
  }
}

console.log('[dsh-desktop:dev] launching electron (dev mode) ...')
const child = spawn(electronBin, [desktop], {
  stdio: 'inherit',
  env: { ...process.env, DSH_DEV: '1' },
})
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
