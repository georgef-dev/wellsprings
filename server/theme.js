import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { readFileSync } from 'node:fs'
import path from 'node:path'

// colors.toml keys that drive the layout palette; every other key passes
// through as --c-<key> so the UI can use any theme color it needs.
const SEMANTIC = {
  background: '--bg',
  darker_background: '--bg-deep',
  lighter_background: '--bg-raised',
  foreground: '--fg',
  bright_foreground: '--fg-bright',
  muted: '--muted',
  dark_foreground: '--muted',
  selection: '--selection',
  accent: '--accent',
}

function parseColors(text) {
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^([\w-]+)\s*=\s*"([^"]*)"$/) ?? line.match(/^([\w-]+)\s*=\s*(\S+)$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}

export function themeVars() {
  try {
    const name = execSync('omarchy theme current', { encoding: 'utf8' }).trim()
    const slug = name.toLowerCase().replace(/\s+/g, '-')
    const dirs = [
      path.join(homedir(), '.config', 'omarchy', 'themes', slug),
      path.join('/usr/share', 'omarchy', 'themes', slug),
    ]
    for (const dir of dirs) {
      try {
        const colors = parseColors(readFileSync(path.join(dir, 'colors.toml'), 'utf8'))
        const vars = {}
        for (const [key, value] of Object.entries(colors)) {
          vars[SEMANTIC[key] ?? `--c-${key}`] = value
        }
        return { name, vars }
      } catch {
        // try next candidate dir
      }
    }
    return { name, vars: {} }
  } catch {
    return { name: null, vars: {} }
  }
}
