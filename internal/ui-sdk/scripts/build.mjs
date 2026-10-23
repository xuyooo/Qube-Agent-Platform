import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
const root = fileURLToPath(new URL('..', import.meta.url))
process.chdir(root)
const output = resolve(root, 'dist')
if (dirname(output) !== resolve(root)) throw new Error('Invalid output directory')
rmSync(output, { recursive: true, force: true })
const require = createRequire(import.meta.url)
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
mkdirSync('dist', { recursive: true })
await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  jsx: 'automatic',
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  outfile: 'dist/index.js',
  external: [...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)],
  sourcemap: true,
})
for (const args of [
  [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'],
  [
    require.resolve('tailwindcss/lib/cli.js'),
    '-c',
    'tailwind.config.cjs',
    '-i',
    'styles.css',
    '-o',
    'dist/styles.css',
    '--minify',
  ],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
// Ship tokens with utilities so consumers need no source scanning or monorepo alias.
writeFileSync(
  'dist/styles.css',
  `${readFileSync('../theme/src/variables.css', 'utf8')}\n${readFileSync('dist/styles.css', 'utf8')}`,
)
