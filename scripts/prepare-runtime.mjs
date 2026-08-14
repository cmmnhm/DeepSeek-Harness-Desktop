// prepare-runtime.mjs — pre-install everything the packaged desktop client needs.
//
// Produces the self-contained payload under desktop/resources/ that
// electron-builder embeds as extraResources:
//
//   resources/runtime    the harness deploy closure: a real `node_modules`
//                        (all @deepseek-ai/* plugins + deps) plus the built
//                        @deepseek-ai/dsh bin and the built web frontend
//                        (dist resolves through node_modules, see
//                        packages/bundle/web-app/src/index.ts). Produced by
//                        `pnpm deploy` — "pre-installs all dependencies".
//   resources/node       (optional) a Node runtime so the end-user needs no
//                        Node installed. Requires a network fetch of a Node
//                        win-x64 portable archive; set DSH_VENDOR_NODE=1.
//   resources/python     (optional) a Python runtime for the Python SDK /
//                        code-runtime. Copy a Python install here (or point
//                        DSH_PYTHON_SOURCE at one) so the client works offline.
//
// The shell (desktop/main.mjs) spawns resources/runtime with resources/node
// and adds resources/python to PATH for the harness process.

import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path, { sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktop = path.resolve(__dirname, '..')
const repoRoot = path.resolve(desktop, '..')
const resources = path.join(desktop, 'resources')

const NODE_ARCHIVE = 'https://nodejs.org/dist/v22.20.0/node-v22.20.0-win-x64.zip'
const NODE_VERSION = 'v22.20.0'

function step(msg) {
  console.log(`\n==> ${msg}`)
}

function sh(cmd, args, cwd) {
  // On Windows, `cmd` is a .cmd shim (pnpm.cmd) and must be resolved through a
  // shell; execFileSync without a shell cannot find it.
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
}

// ---------------------------------------------------------------------------
// 1. Harness deploy closure (the "install all dependencies" step)
// ---------------------------------------------------------------------------
/**
 * Enumerate workspace packages under the repo's vendor, packages and apps
 * scopes that carry a package.json, returning { name, dir } entries. No
 * external deps: a manual walk mirrors the repo's pnpm-workspace.yaml globs.
 */
function findWorkspacePackages() {
  const out = []
  // vendor/* and apps/* are one level deep; packages/<scope>/<name> is two.
  const scopes = [
    { root: 'vendor', depth: 1 },
    { root: 'packages', depth: 2 },
    { root: 'apps', depth: 1 },
  ]
  for (const { root, depth } of scopes) {
    let dirs = [path.join(repoRoot, root)]
    for (let lvl = 0; lvl < depth; lvl++) {
      const next = []
      for (const d of dirs) {
        if (!existsSync(d) || !statSync(d).isDirectory()) continue
        for (const entry of readdirSync(d)) next.push(path.join(d, entry))
      }
      dirs = next
      for (const dir of dirs) {
        const manifestPath = path.join(dir, 'package.json')
        if (!existsSync(manifestPath)) continue
        try {
          const name = JSON.parse(readFileSync(manifestPath, 'utf8')).name
          if (typeof name === 'string' && name.startsWith('@deepseek-ai/')) {
            out.push({ name, dir })
          }
        } catch {
          /* not a package */
        }
      }
    }
  }
  return out
}

/**
 * pnpm's legacy deploy drops some @deepseek-ai workspace packages that are
 * only reachable as transitive or peer deps (e.g. the vendored
 * cordis-plugin-group on which dsh-app-boot depends). Restore any missing one
 * into the closure's node_modules from the repo's built output, dereferenced,
 * so the packaged harness resolves every plugin. Mirrors
 * scripts/build-exe-for-python-sdk.ts's restoreLegacyHoists, but for the whole
 * @deepseek-ai workspace set.
 */
function restoreWorkspacePackages(target) {
  const nmDir = path.join(target, 'node_modules', '@deepseek-ai')
  mkdirSync(nmDir, { recursive: true })
  const restored = []
  for (const { name, dir } of findWorkspacePackages()) {
    const base = name.slice('@deepseek-ai/'.length)
    const dest = path.join(nmDir, base)
    if (existsSync(dest)) continue
    // Copy only build/publish-relevant content, never node_modules.
    const copySet = []
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'src' || entry === 'tsconfig.json') continue
      copySet.push(entry)
    }
    mkdirSync(dest, { recursive: true })
    for (const entry of copySet) {
      const src = path.join(dir, entry)
      cpSync(src, path.join(dest, entry), { recursive: true, dereference: true })
    }
    restored.push(name)
  }
  if (restored.length > 0) {
    console.log(`    restored workspace packages omitted by deploy: ${restored.join(', ')}`)
  }
  return restored
}

/**
 * Remove a tree, tolerating transient Windows EBUSY (a stale handle on an
 * emptied folder): rename the old tree aside instead of rmdir'ing it, so the
 * deploy can proceed into a fresh directory.
 */
function removeTree(base, name) {
  const p = path.join(base, name)
  if (!existsSync(p)) return
  try {
    rmSync(p, { recursive: true, force: true })
  } catch (err) {
    if (err?.code === 'EBUSY' || err?.code === 'EPERM') {
      const stale = `${name}-stale-${process.pid}`
      console.log(`    (${err.code}) renaming ${name} -> ${stale}`)
      rmSync(path.join(base, stale), { recursive: true, force: true })
      renameSync(p, path.join(base, stale))
    } else {
      throw err
    }
  }
}

async function prepareRuntime() {
  const target = path.join(resources, 'runtime')
  step(`Materializing harness deploy closure -> ${target}`)
  removeTree(resources, 'runtime')
  mkdirSync(target, { recursive: true })

  // The repo's `apps/cli` (@deepseek-ai/dsh) is the web-profile deploy root:
  // its dependency closure is exactly what `dsh web` loads, and `pnpm deploy`
  // materializes a flat, self-contained node_modules (workspace packages
  // resolved to real copies) instead of symlinks.
  if (!existsSync(path.join(repoRoot, 'node_modules'))) {
    throw new Error(
      'Repo deps not installed. Run `pnpm install` at the repo root first.',
    )
  }
  if (!existsSync(path.join(repoRoot, 'apps', 'cli', 'package.json'))) {
    throw new Error(`Deploy root (apps/cli) not found under ${repoRoot}`)
  }
  // Flags mirror the repo's canonical closure builder
  // (scripts/build-exe-for-python-sdk.ts): a *hoisted, symlink-free* payload so
  // the packaged harness can resolve every dependency from a flat node_modules.
  sh(
    'pnpm',
    [
      '--dir', repoRoot,
      '--filter', '@deepseek-ai/dsh',
      '--prod',
      'deploy',
      '--legacy', // non-injected workspace: pnpm >=10 requires this flag
      '--config.node-linker=hoisted',
      '--config.auto-install-peers=false',
      '--config.link-workspace-packages=true',
      target,
    ],
    repoRoot,
  )

  // pnpm's legacy deploy drops some transitive/peer workspace packages; restore
  // any missing @deepseek-ai/* plugin from the repo's built output.
  restoreWorkspacePackages(target)

  // The web frontend is an *assembly fact* of the Web profile: it is consumed
  // solely via `require.resolve('@deepseek-ai/dsh-web-frontend/dist/index.html')`
  // and is not always carried into a --prod deploy closure. Ensure the built
  // dist lands in the deployed closure explicitly.
  const frontendPkg = path.join(target, 'node_modules', '@deepseek-ai', 'dsh-web-frontend')
  const distIndex = path.join(frontendPkg, 'dist', 'index.html')
  if (!existsSync(distIndex)) {
    const repoDist = path.join(repoRoot, 'apps', 'web', 'dist')
    if (!existsSync(path.join(repoDist, 'index.html'))) {
      throw new Error(
        'Web frontend not built at apps/web/dist. Run `pnpm --filter @deepseek-ai/dsh-web-frontend run build` first.',
      )
    }
    console.log(
      '    frontend dist absent from closure — copying apps/web/dist into deployment',
    )
    rmSync(frontendPkg, { recursive: true, force: true })
    mkdirSync(frontendPkg, { recursive: true })
    cpSync(repoDist, path.join(frontendPkg, 'dist'), { recursive: true })
    // Minimal manifest so `require.resolve('<pkg>/dist/index.html')` resolves.
    writeFileSync(
      path.join(frontendPkg, 'package.json'),
      JSON.stringify(
        {
          name: '@deepseek-ai/dsh-web-frontend',
          version: '0.1.0',
          private: true,
          type: 'module',
        },
        null,
        2,
      ),
    )
  }
  console.log(`    web frontend present: ${path.relative(desktop, distIndex)}`)

  // Node runtime (optional but recommended for a fully offline client).
  if (process.env.DSH_VENDOR_NODE === '1') {
    await vendorNode()
  } else {
    console.log(
      '\n    (skipping bundled Node runtime — set DSH_VENDOR_NODE=1 to fetch ' +
        `node ${NODE_VERSION} win-x64. Without it the build expects a system Node.)`,
    )
  }

  // Python runtime (optional, for the Python SDK / code-runtime offline use).
  await vendorPython()

  console.log('\nDone. Build the installer with:')
  console.log('    pnpm --dir desktop install && pnpm --dir desktop build:win')
}

// ---------------------------------------------------------------------------
// 2. Bundled Node runtime (optional)
// ---------------------------------------------------------------------------
async function vendorNode() {
  const targetDir = path.join(resources, 'node')
  step(`Fetching Node ${NODE_VERSION} portable into ${targetDir}`)
  const zipPath = path.join(resources, `node-${NODE_VERSION}.zip`)
  if (!existsSync(zipPath)) {
    const { pipeline } = await import('node:stream/promises')
    const { Readable } = await import('node:stream')
    const { createWriteStream } = await import('node:fs')
    const resp = await fetch(NODE_ARCHIVE)
    if (!resp.ok) throw new Error(`download failed: ${resp.status}`)
    await pipeline(Readable.fromWeb(resp.body), createWriteStream(zipPath))
  }
  const extract = path.join(resources, `_node-${NODE_VERSION}`)
  rmSync(extract, { recursive: true, force: true })
  mkdirSync(extract, { recursive: true })
  // PowerShell Expand-Archive handles the zip without extra deps.
  execFileSync(
    'powershell',
    ['-NoProfile', '-Command', `Expand-Archive -Force '${zipPath}' '${extract}'`],
    { stdio: 'inherit' },
  )
  rmSync(targetDir, { recursive: true, force: true })
  // Keep only the files a headless runtime needs (their names are stable).
  const inner = path.join(extract, `node-${NODE_VERSION}-win-x64`)
  mkdirSync(targetDir, { recursive: true })
  cpSync(path.join(inner, 'node.exe'), path.join(targetDir, 'node.exe'))
  mkdirSync(path.join(targetDir, 'node_modules'), { recursive: true })
  cpSync(
    path.join(inner, 'node_modules', 'npm'),
    path.join(targetDir, 'node_modules', 'npm'),
    { recursive: true },
  )
  rmSync(extract, { recursive: true, force: true })
  rmSync(zipPath, { force: true })
  console.log('    bundled Node runtime installed at resources/node')
}

// ---------------------------------------------------------------------------
// 3. Bundled Python runtime (optional but matches "pre-install the Python env")
// ---------------------------------------------------------------------------
/** Resolve a lightweight Python install to bundle, or null.
 *  Prefer DSH_PYTHON_SOURCE; else auto-detect the active interpreter, but never
 *  a conda/anaconda env (multi-GB shims that are not portable by copy). */
function resolvePythonSource() {
  if (process.env.DSH_PYTHON_SOURCE) return process.env.DSH_PYTHON_SOURCE
  for (const probe of ['python', 'python3']) {
    try {
      const { stdout } = execFileSync(probe, [
        '-c',
        "import sys,os;print(os.path.dirname(sys.executable))",
      ], { encoding: 'utf8' })
      const dir = stdout.trim().replace(/\r/g, '')
      if (dir && /(conda|anaconda|miniconda)/i.test(dir)) continue
      if (existsSync(path.join(dir, 'python.exe'))) return dir
    } catch {
      /* not on PATH */
    }
  }
  return null
}

async function vendorPython() {
  const target = path.join(resources, 'python')
  const source = resolvePythonSource()
  if (!source) {
    console.log(
      '\n    (no portable Python found to bundle — set DSH_PYTHON_SOURCE to a copy\n' +
        '     of a Python install, e.g. C:\\Python312, to embed it offline.)',
    )
    return
  }
  step(`Bundling Python runtime ${source} -> ${target}`)
  rmSync(target, { recursive: true, force: true })
  // Skip bytecode caches and the stdlib test suite to keep the embed small;
  // neither is needed at runtime.
  cpSync(source, target, {
    recursive: true,
    filter: (src) =>
      !src.includes(`${sep}__pycache__`) &&
      !src.includes(`${sep}Lib${sep}test`),
  })
  console.log('    Python runtime installed at resources/python')
  if (!existsSync(path.join(target, 'python.exe'))) {
    throw new Error(`Bundled python.exe missing — check DSH_PYTHON_SOURCE=${source}`)
  }
}

await prepareRuntime()
