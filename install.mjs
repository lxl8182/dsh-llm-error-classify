/**
 * Register this plugin in the active dsh profile the way dsh local plugins are
 * registered: a `link:` dependency plus a bundle entry.
 *
 * A link dependency keeps the plugin outside the dsh git checkout, so the
 * updater (which rebases local commits onto origin/master) never sees it and
 * cannot drop it. The bundle entry is what actually mounts the row at boot.
 *
 * Usage: node install.mjs [profileDir]
 */
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = 'dsh-llm-error-classify'

const profileDir = resolve(process.argv[2] ?? join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'web'))
const manifestPath = join(profileDir, 'package.json')
const packageDir = resolve(fileURLToPath(new URL('.', import.meta.url)))
const linkPath = packageDir.replaceAll('\\', '/')

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
manifest.dependencies ??= {}
manifest.dsh ??= {}
manifest.dsh.profile ??= {}
manifest.dsh.profile.bundles ??= []
manifest.dependencies[PACKAGE] = `link:${linkPath}`
if (!manifest.dsh.profile.bundles.includes(PACKAGE)) manifest.dsh.profile.bundles.push(PACKAGE)
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`Registered ${PACKAGE} in ${manifestPath}`)
console.log('Run pnpm install in the profile, then restart dsh web to load it.')
