import { readFileSync } from 'fs'

/**
 * Minimal `.env` loader for API keys.
 *
 * Keys stay out of the config file and out of the DB (see agent/config.ts), so
 * they have to come from the environment — and typing `ANTHROPIC_API_KEY=…`
 * before every `npm run dev` gets old. This reads a dotenv-style file into
 * `process.env` at startup.
 *
 * Two rules make it predictable:
 *  - **A real environment variable always wins.** `ANTHROPIC_API_KEY=x npm run
 *    dev` overrides the file, and nothing here can clobber a value the shell
 *    (or a test) set deliberately.
 *  - **First file to define a key wins**, in the order the caller passes them.
 *
 * Hand-rolled rather than pulling in `dotenv`: the format we need is
 * `KEY=value`, comments, and optional surrounding quotes. It deliberately does
 * *not* do variable interpolation, multi-line values, or escape sequences — a
 * value is the literal text after the first `=`.
 */

export interface LoadedEnvFile {
  path: string
  /** Names only — a value must never reach a log. */
  keys: string[]
}

/** Parse dotenv text into pairs. Malformed lines are skipped, not fatal. */
export function parseEnv(contents: string): Record<string, string> {
  const values: Record<string, string> = {}
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const separator = line.indexOf('=')
    if (separator <= 0) continue

    const key = line
      .slice(0, separator)
      .replace(/^export\s+/, '')
      .trim()
    if (!key) continue

    values[key] = unquote(line.slice(separator + 1).trim())
  }
  return values
}

/**
 * Apply each file's values to `env`, skipping keys that already have one.
 * Returns what was actually loaded, so the caller can say so on startup.
 * A missing file is normal — most installs won't have one.
 */
export function loadEnvFiles(
  paths: string[],
  env: NodeJS.ProcessEnv = process.env,
): LoadedEnvFile[] {
  const loaded: LoadedEnvFile[] = []
  for (const path of paths) {
    let contents: string
    try {
      contents = readFileSync(path, 'utf8')
    } catch {
      continue
    }

    const applied: string[] = []
    for (const [key, value] of Object.entries(parseEnv(contents))) {
      if (env[key] !== undefined) continue
      env[key] = value
      applied.push(key)
    }
    loaded.push({ path, keys: applied })
  }
  return loaded
}

function unquote(value: string): string {
  const quoted =
    (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))
  return quoted && value.length >= 2 ? value.slice(1, -1) : value
}
