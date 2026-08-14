// DeepSeek Harness — thin Electron shell.
//
// The harness is a Node process (`dsh web` — the `web` Cordis profile that
// boots the host runtime, webserver and built React frontend). The heavy
// lifting stays in that process; this shell only:
//   1. spawns the harness runtime
//   2. waits for its printed URL (default http://127.0.0.1:3080)
//   3. renders that URL in a native BrowserWindow
//
// Two modes:
//   * dev        — `app.isPackaged === false`: drive the checked-out repo's
//                  built harness (apps/cli/lib) with the system Node so the
//                  existing node_modules + native addons are used as-is.
//   * packaged   — app.isPackaged === true: drive the bundled deploy closure
//                  in resources/runtime with a bundled Node (resources/node),
//                  so the end-user needs neither Node nor anything else
//                  installed (everything is pre-installed by scripts/prepare-runtime.mjs).

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, dialog, shell } from 'electron'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const DEV_PORT = 3080
const BOOT_TIMEOUT_MS = 60_000
const STARTUP_POLL_MS = 700

let harness = null
let mainWindow = null

// ---------------------------------------------------------------------------
// Runtime resolution
// ---------------------------------------------------------------------------

/**
 * Decide what to spawn and with which working directory / env.
 * @returns {{ command: string, args: string[], cwd: string, env: Record<string,string> }}
 */
function resolveHarnessLaunch() {
  // Dev: drive the checked-out repo. `DSH_NODE` lets you pick a different
  // Node binary (defaults to the `node` on PATH).
  if (!app.isPackaged || process.env.DSH_DEV === '1') {
    const bin = path.join(repoRoot, 'apps', 'cli', 'lib', 'bin.js')
    if (!existsSync(bin)) {
      throw new Error(
        `Harness not built: expected ${bin}. Run \`pnpm build\` at the repo root first.`,
      )
    }
    return {
      command: process.env.DSH_NODE ?? 'node',
      args: [bin, '--profile', 'web'],
      cwd: repoRoot,
      env: { ...process.env },
    }
  }

  // Packaged: deployed closure + (preferred) bundled Node.
  // Deploy closure produced by scripts/prepare-runtime.mjs. `pnpm deploy`
  // materializes the filtered package (@deepseek-ai/dsh, the deploy root) at
  // the TOP of the target dir, so its bin lives at runtime/lib/bin.js.
  const bin = path.join(process.resourcesPath, 'runtime', 'lib', 'bin.js')
  if (!existsSync(bin)) {
    throw new Error(
      'Bundled runtime not found. Run `pnpm --dir desktop prepare:runtime` before building.',
    )
  }
  // Prefer the bundled Node runtime (fully offline). Fall back to the system
  // `node` when DSH_VENDOR_NODE was not used to vendor one — the closure is
  // self-contained either way; only the Node binary source differs.
  const bundledNode = path.join(process.resourcesPath, 'node', 'node.exe')
  const nodeExe = existsSync(bundledNode) ? bundledNode : 'node'
  const env = { ...process.env }
  // If a Python runtime was bundled, expose it to the harness (used by the
  // Python SDK / code-runtime) as long as it is not already earlier on PATH.
  const bundledPython = path.join(process.resourcesPath, 'python')
  if (existsSync(path.join(bundledPython, 'python.exe'))) {
    env.PATH = `${bundledPython}${path.delimiter}${env.PATH ?? ''}`
  }
  return {
    command: nodeExe,
    args: [bin, '--profile', 'web'],
    cwd: path.join(process.resourcesPath, 'runtime'),
    env,
  }
}

// ---------------------------------------------------------------------------
// Harness lifecycle
// ---------------------------------------------------------------------------

/**
 * Spawn the harness and resolve to its base URL once it prints
 * `dsh web: http://host:port`. Falls back to the default port after a short
 * grace period if the ready line is not observed.
 */
function startHarness() {
  const launch = resolveHarnessLaunch()
  console.log(`[dsh-desktop] spawning ${launch.command} ${launch.args.join(' ')}`)

  const child = spawn(launch.command, launch.args, {
    cwd: launch.cwd,
    env: launch.env,
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  harness = child

  return new Promise((resolve, reject) => {
    let settled = false
    let stdout = ''
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true
        // Be lenient: the ready line may be swallowed; probe the default port.
        console.warn('[dsh-desktop] boot line not observed, using default port')
        resolve(`http://127.0.0.1:${DEV_PORT}`)
      }
    }, BOOT_TIMEOUT_MS)

    const finish = (url, isError) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (isError) reject(new Error(url))
      else {
        console.log(`[dsh-desktop] harness ready at ${url}`)
        Object.assign(child, { readyUrl: url })
        resolve(url)
      }
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      const m = stdout.match(/dsh web:\s+(\S+)/)
      if (m) finish(m[1], false)
      // Stream recent output to the console for debuggability.
      const lines = chunk.toString().split('\n').filter(Boolean)
      for (const l of lines) console.log(`[harness] ${l}`)
    })
    child.stderr.on('data', (chunk) => {
      for (const l of chunk.toString().split('\n').filter(Boolean)) {
        console.error(`[harness:err] ${l}`)
      }
    })
    child.on('error', (err) => finish(`failed to spawn harness: ${err.message}`, true))
    child.on('exit', (code, signal) => {
      if (!settled) {
        finish(`harness exited before ready (code=${code}, signal=${signal})`, true)
      } else {
        console.log(`[dsh-desktop] harness exited (code=${code}, signal=${signal})`)
        if (app.isPackaged || !process.env.DSH_KEEP_OPEN) app.quit()
      }
    })
  })
}

function dialogError(message) {
  try {
    dialog.showErrorBox('DeepSeek Harness — startup failed', message)
  } catch {
    /* headless */
  }
}

function stopHarness() {
  if (!harness) return
  const child = harness
  harness = null
  try {
    child.kill()
    // On Windows, tree-kill the process-group so orphaned children (node-pty,
    // sandbox helpers) do not survive the shell.
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    }
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

async function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    autoHideMenuBar: true,
    webPreferences: {
      // The UI is served content over localhost; keep the renderer isolated
      // and without Node access (thin shell — no preload bridge needed).
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Open external target=_blank links in the system browser instead of
  // spawning extra windows inside the shell.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (e, target) => {
    if (!target.startsWith('http://127.0.0.1') && !target.startsWith('http://localhost')) {
      e.preventDefault()
      shell.openExternal(target)
    }
  })

  await mainWindow.loadURL(url)
  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.whenReady().then(async () => {
  try {
    const url = await startHarness()
    await createWindow(url)
  } catch (err) {
    console.error(`[dsh-desktop] startup failed: ${err.message}`)
    dialogError(err.message)
    app.exit(1)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && harness?.readyUrl) {
      createWindow(harness.readyUrl)
    }
  })
})

// macOS convention aside, this is a local UI over a child process: quit when
// the last window closes so we never leak an orphaned harness.
app.on('window-all-closed', () => {
  stopHarness()
  app.quit()
})

app.on('before-quit', () => stopHarness())
app.on('will-quit', () => stopHarness())
