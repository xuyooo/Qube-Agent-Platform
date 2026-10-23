import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
process.chdir(fileURLToPath(new URL('..', import.meta.url)))
const root = resolve('.')
const temp = mkdtempSync(join(tmpdir(), 'qap-sdk-host-'))
function npm(args, cwd = root) {
  const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    process.stdout.write(result.stdout)
    process.stderr.write(result.stderr)
    process.exit(result.status ?? 1)
  }
  return result.stdout
}
const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', temp]))[0].filename
cpSync('test-host', join(temp, 'host'), { recursive: true })
const cwd = join(temp, 'host')
const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
pkg.dependencies['@qap/ui-sdk'] = `file:../${packed}`
writeFileSync(join(cwd, 'package.json'), JSON.stringify(pkg, null, 2))
npm(
  [
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--fetch-timeout=30000',
    '--fetch-retries=1',
  ],
  cwd,
)
console.log(npm(['run', 'build'], cwd))
const smoke = spawnSync(process.execPath, ['smoke.mjs'], { cwd, stdio: 'inherit' })
console.log('Independent packed-package host:', cwd)
process.exitCode = smoke.status ?? 1
