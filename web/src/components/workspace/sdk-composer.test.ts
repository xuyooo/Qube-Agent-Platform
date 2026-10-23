import {
  AskUserQuestionPanel,
  Composer,
  type ComposerHandle,
  type ComposerProps,
} from '@qap/ui-sdk'
// @vitest-environment jsdom
import { act, createElement, createRef } from 'react'
import { type Root, createRoot } from 'react-dom/client'
import { Simulate } from 'react-dom/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  window.matchMedia = vi.fn().mockReturnValue({ matches: false })
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})
function mount(props: Partial<ComposerProps> = {}, ref = createRef<ComposerHandle>()) {
  const onSubmit = vi.fn()
  const onChange = vi.fn()
  act(() =>
    root.render(createElement(Composer, { value: 'hello', onChange, onSubmit, ...props, ref })),
  )
  return { onSubmit, onChange, ref, textarea: container.querySelector('textarea')! }
}
describe('standalone controlled Composer', () => {
  it('submits pure images and leaves clearing to the host', () => {
    const images = [{ data: 'aA==', media_type: 'image/png' }]
    const { onSubmit, onChange } = mount({
      value: '',
      attachments: { items: images, onAdd: vi.fn(), onRemove: vi.fn() },
    })
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
    const button = [...container.querySelectorAll('button')].find((b) =>
      b.getAttribute('aria-label')?.toLowerCase().includes('stop'),
    )
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
    const { textarea, onChange } = mount({
      value: '/go',
      commands: [{ name: 'go', type: 'plain', content: 'run' }],
      onRunCommand,
    })
    act(() => Simulate.keyDown(textarea, { key: 'Enter' }))
    expect(onRunCommand).toHaveBeenCalledWith('run', expect.objectContaining({ name: 'go' }))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('SDK interaction boundaries', () => {
  it('blocks commands when disabled and exposes pure-image queueing', () => {
    const onRunCommand = vi.fn()
    const { textarea } = mount({
      value: '/go',
      disabled: true,
      commands: [{ name: 'go', type: 'plain', content: 'run' }],
      onRunCommand,
    })
    act(() => Simulate.keyDown(textarea, { key: 'Enter' }))
    expect(onRunCommand).not.toHaveBeenCalled()
    const images = [{ data: 'aA==', media_type: 'image/png' }]
    const { onSubmit } = mount({
      value: '',
      running: true,
      attachments: { items: images, onAdd: vi.fn(), onRemove: vi.fn() },
    })
    expect(container.querySelector('button[type="submit"]')).toBeTruthy()
    act(() => Simulate.submit(container.querySelector('form')!))
    expect(onSubmit).toHaveBeenCalledWith('', images)
  })
  it('preserves multi-select and custom-answer wire formats', () => {
    const onRespond = vi.fn()
    act(() =>
      root.render(
        createElement(AskUserQuestionPanel, {
          locale: 'en-US',
          request: {
            requestId: 'q',
            questions: [
              {
                question: 'Mode?',
                header: '',
                multiSelect: true,
                options: [
                  { label: 'A', description: '' },
                  { label: 'B', description: '' },
                ],
              },
            ],
          },
          onRespond,
        }),
      ),
    )
    const options = container.querySelectorAll('button[aria-pressed]')
    act(() => {
      Simulate.click(options[0])
      Simulate.click(options[1])
    })
    const submit = container.querySelectorAll('button')[2]
    act(() => Simulate.click(submit))
    expect(onRespond).toHaveBeenLastCalledWith({ 'Mode?': 'A, B' })
    const input = container.querySelector('input')!
    act(() => {
      input.value = ' custom '
      Simulate.change(input, { target: { value: ' custom ' } } as unknown as Parameters<
        typeof Simulate.change
      >[1])
    })
    act(() => Simulate.click(submit))
    expect(onRespond).toHaveBeenLastCalledWith({ 'Mode?': 'custom' })
  })
  it('keeps simultaneous composer locales independent', () => {
    act(() =>
      root.render(
        createElement(
          'div',
          null,
          createElement(Composer, {
            value: '',
            locale: 'zh-CN',
            onChange: vi.fn(),
            onSubmit: vi.fn(),
          }),
          createElement(Composer, {
            value: '',
            locale: 'en-US',
            onChange: vi.fn(),
            onSubmit: vi.fn(),
          }),
        ),
      ),
    )
    const inputs = container.querySelectorAll('textarea')
    expect(inputs[0].placeholder).not.toEqual(inputs[1].placeholder)
    expect(inputs[0].placeholder).toMatch(/[\u4e00-\u9fff]/)
  })
  it('releases a microphone granted after the composer is unmounted', async () => {
    let resolvePermission!: (stream: MediaStream) => void
    const stop = vi.fn()
    const getUserMedia = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          resolvePermission = resolve
        }),
    )
    const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices')
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    })
    try {
      mount({ voice: { transcribe: vi.fn() } })
      const mic = [...container.querySelectorAll('button')].find((button) =>
        button.getAttribute('aria-label')?.toLowerCase().includes('voice'),
      )!
      expect(mic).toBeTruthy()
      act(() => {
        Simulate.click(mic)
        Simulate.click(mic)
      })
      expect(getUserMedia).toHaveBeenCalledOnce()
      act(() => root.render(null))
      await act(async () => {
        resolvePermission({ getTracks: () => [{ stop }] } as unknown as MediaStream)
        await Promise.resolve()
      })
      expect(stop).toHaveBeenCalledOnce()
    } finally {
      if (original) Object.defineProperty(navigator, 'mediaDevices', original)
      else Reflect.deleteProperty(navigator, 'mediaDevices')
    }
  })
})

describe('dynamic command refresh', () => {
  const oldCommand = { name: 'old', type: 'plain' as const, content: 'old payload' }
  const newCommand = { name: 'new', type: 'plain' as const, content: 'new payload' }

  it('removes previous commands while reopening and waits for fresh results', async () => {
    let resolve!: (items: (typeof oldCommand)[]) => void
    const loadCommands = vi
      .fn()
      .mockResolvedValueOnce([oldCommand])
      .mockImplementationOnce(
        () =>
          new Promise<(typeof oldCommand)[]>((done) => {
            resolve = done
          }),
      )
    const onRunCommand = vi.fn()
    await act(async () => {
      mount({ value: '/', loadCommands, onRunCommand })
    })
    expect(container.textContent).toContain('/old')
    act(() => {
      mount({ value: '', loadCommands, onRunCommand })
    })
    await act(async () => {
      mount({ value: '/', loadCommands, onRunCommand })
    })
    expect(container.textContent).not.toContain('/old')
    act(() => Simulate.keyDown(container.querySelector('textarea')!, { key: 'Enter' }))
    expect(onRunCommand).not.toHaveBeenCalled()
    await act(async () => {
      resolve([newCommand])
    })
    expect(container.textContent).toContain('/new')
    act(() => Simulate.keyDown(container.querySelector('textarea')!, { key: 'Enter' }))
    expect(onRunCommand).toHaveBeenCalledWith('new payload', newCommand)
  })

  it('shows failure, blocks raw submission and retries without stale commands', async () => {
    const loadCommands = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([newCommand])
    const onSubmit = vi.fn()
    await act(async () => {
      mount({ value: '/', locale: 'en-US', loadCommands, onSubmit })
    })
    expect(container.querySelector('output')?.textContent).toContain('Could not load commands')
    act(() => Simulate.submit(container.querySelector('form')!))
    expect(onSubmit).not.toHaveBeenCalled()
    const retry = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Retry',
    )!
    await act(async () => {
      Simulate.click(retry)
    })
    expect(loadCommands).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('/new')
    expect(container.querySelector('output')).toBeNull()
  })

  it('ignores a previous data source resolving after its replacement', async () => {
    let resolveOld!: (items: (typeof oldCommand)[]) => void
    const oldSource = () =>
      new Promise<(typeof oldCommand)[]>((resolve) => {
        resolveOld = resolve
      })
    const newSource = vi.fn().mockResolvedValue([newCommand])
    await act(async () => {
      mount({ value: '/', loadCommands: oldSource })
    })
    await act(async () => {
      mount({ value: '/', loadCommands: newSource })
    })
    await act(async () => {
      resolveOld([oldCommand])
    })
    expect(container.textContent).toContain('/new')
    expect(container.textContent).not.toContain('/old')
  })
})
