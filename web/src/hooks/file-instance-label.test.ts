import { describe, expect, it } from 'vitest'
import { fileInstanceLabel } from './file-instance-label'
describe('saved file window labels', () => {
  it.each([
    ['40%可编辑版.png', '40%可编辑版.png'],
    ['100%.txt', '100%.txt'],
    ['report%20v2.txt', 'report v2.txt'],
    ['%E4', '%E4'],
    ['中文 空格.png', '中文 空格.png'],
    ['100%25.txt', '100%.txt'],
  ])('restores %s without changing its path', (name, expected) => {
    const layout = JSON.parse(JSON.stringify({ viewingPath: `/folder/${name}` }))
    expect(fileInstanceLabel(layout)).toBe(expected)
    expect(layout.viewingPath).toBe(`/folder/${name}`)
  })
  it('handles empty and trailing slash paths', () => {
    expect(fileInstanceLabel({})).toBe(null)
    expect(fileInstanceLabel({ viewingPath: '/folder/' })).toBe('folder')
  })
})
