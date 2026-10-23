import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { JSDOM } from 'jsdom'
const html = readFileSync('dist/index.html', 'utf8')
const dom = new JSDOM(html.replace(/<script[^>]*>[\s\S]*?<\/script>/g, ''), {
  url: 'http://localhost/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
})
Object.assign(dom.window, {
  fetch: globalThis.fetch,
  Response,
  Request,
  Headers,
  TextDecoder,
  TextEncoder,
  ReadableStream,
  matchMedia: () => ({ matches: false }),
  ResizeObserver: class {
    observe() {}
    disconnect() {}
    unobserve() {}
  },
})
const js = readdirSync('dist/assets').find((file) => /^index-.*\.js$/.test(file))
dom.window.eval(readFileSync(`dist/assets/${js}`, 'utf8'))
const until = async (condition) => {
  for (let i = 0; i < 100; i++) {
    if (condition()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw Error('DOM condition timed out')
}
await until(() => dom.window.document.querySelector('textarea'))
const doc = dom.window.document
assert.ok(doc.body.textContent.includes('Independent SDK host'))
doc.querySelector('button[aria-pressed]').click()
await until(() => doc.querySelector('button[aria-pressed]').getAttribute('aria-pressed') === 'true')
const confirm = [...doc.querySelectorAll('button')].find((button) =>
  button.textContent.includes('Confirm'),
)
assert.ok(confirm)
confirm.click()
await until(() => doc.querySelector('output').textContent === 'Standard')
doc
  .querySelector('form')
  .dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
await until(() => doc.body.textContent.includes('SDK standalone reply'))
assert.equal(doc.querySelector('textarea').value, '')
const css = readdirSync('dist/assets').find((file) => file.endsWith('.css'))
assert.ok(readFileSync(`dist/assets/${css}`, 'utf8').includes('--background'))
console.log(
  'PASS packed SDK: ESM, declarations, styles, question, Composer, Store and SSE round trip',
)
dom.window.close()
