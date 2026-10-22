import { build } from 'esbuild'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
mkdirSync('dist', { recursive: true })
await build({ entryPoints: ['src/index.ts'], bundle: true, format: 'esm', platform: 'browser', target: 'es2022', outfile: 'dist/index.js', external: [...Object.keys(pkg.dependencies), ...Object.keys(pkg.peerDependencies)], sourcemap: true })
for (const args of [[require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'], [require.resolve('tailwindcss/lib/cli.js'), '-c', 'tailwind.config.cjs', '-i', 'styles.css', '-o', 'dist/styles.css', '--minify']]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' })
  if (result.status !== 0) process.exit(result.status ?? 1)
}
// Ship tokens with utilities so consumers need no source scanning or monorepo alias.
writeFileSync('dist/styles.css', readFileSync('../theme/src/variables.css', 'utf8') + '\n' + readFileSync('dist/styles.css', 'utf8'))
