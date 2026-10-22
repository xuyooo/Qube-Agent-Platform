// @vitest-environment jsdom
import { createElement, act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Composer, type ComposerHandle, type ComposerProps } from '@qap/ui-sdk'
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
  window.matchMedia = vi.fn().mockReturnValue({ matches: false })
})
afterEach(() => { act(() => root.unmount()); container.remove() })
function mount(props: Partial<ComposerProps> = {}, ref = createRef<ComposerHandle>()) {
  const onSubmit = vi.fn(), onChange = vi.fn()
  act(() => root.render(createElement(Composer, { value: 'hello', onChange, onSubmit, ...props, ref })))
  return { onSubmit, onChange, ref, textarea: container.querySelector('textarea')! }
}
describe('standalone controlled Composer', () => {
  it('submits pure images and leaves clearing to the host', () => {
    const images = [{ data: 'aA==', media_type: 'image/png' }]
    const { onSubmit, onChange } = mount({ value: '', attachments: { items: images, onAdd: vi.fn(), onRemove: vi.fn() } })
    act(() => Simulate.submit(container.querySelector('form')!))
    expect(onSubmit).toHaveBeenCalledWith('', images)
    expect(onChange).not.toHaveBeenCalled()
  })
  it('does not submit IME confirmation; Ctrl+Enter submits', () => {
    const { textarea, onSubmit } = mount()
    act(() => Simulate.compositionStart(textarea))
    act(() => Simulate.keyDown(textarea, { key: 'Enter', ctrlKey: true }))
    expect(onSubmit).not.toHaveBeenCalled()
    act(() => Simulate.compositionEnd(textarea))
    act(() => Simulate.keyDown(textarea, { key: 'Enter', ctrlKey: true }))
    expect(onSubmit).toHaveBeenCalledWith('hello', [])
  })
  it('queues content while running and exposes stop', () => {
    const stop = vi.fn()
    const { onSubmit } = mount({ running: true, onStop: stop })
    act(() => Simulate.submit(container.querySelector('form')!))
    expect(onSubmit).toHaveBeenCalledOnce()
    const button = [...container.querySelectorAll('button')].find(b => b.getAttribute('aria-label')?.toLowerCase().includes('stop'))
    expect(button).toBeTruthy()
    act(() => Simulate.click(button!))
    expect(stop).toHaveBeenCalledOnce()
  })
  it('inserts at the caret through the public handle', () => {
    const { textarea, ref, onChange } = mount()
    textarea.setSelectionRange(0, 0)
    act(() => ref.current!.insertAtCaret('@file/a'))
    expect(onChange).toHaveBeenCalledWith('@file/a hello')
  })
  it('does not clear controlled text when choosing a command', () => {
    const onRunCommand = vi.fn()
    const { textarea, onChange } = mount({ value: '/go', commands: [{ name: 'go', type: 'plain', content: 'run' }], onRunCommand })
    act(() => Simulate.keyDown(textarea, { key: 'Enter' }))
    expect(onRunCommand).toHaveBeenCalledWith('run', expect.objectContaining({ name: 'go' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})
