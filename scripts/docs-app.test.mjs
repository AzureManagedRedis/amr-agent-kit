import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const source = readFileSync(new URL('../docs/app.js', import.meta.url), 'utf8')

function setup({ label = 'Copy install command', clipboard = true } = {}) {
  const attributes = new Map([['data-copy', 'npx skills add AzureManagedRedis/amr-agent-kit']])
  if (label !== null) attributes.set('aria-label', label)
  let click
  let nextTimer = 0
  const timers = new Map()
  const requests = []
  const button = {
    textContent: 'Copy',
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    addEventListener: (_, handler) => { click = handler },
  }
  runInNewContext(source, {
    document: {
      querySelector: () => null,
      querySelectorAll: () => [button],
    },
    navigator: {
      clipboard: clipboard ? {
        writeText: (value) => new Promise((resolve, reject) => requests.push({ value, resolve, reject })),
      } : undefined,
    },
    window: {
      setTimeout: (callback) => {
        const id = ++nextTimer
        timers.set(id, callback)
        return id
      },
      clearTimeout: (id) => timers.delete(id),
    },
  })
  return {
    button, requests, click: () => click(),
    reset: () => {
      for (const [id, callback] of [...timers]) {
        timers.delete(id)
        callback()
      }
    },
  }
}

test('repeated copies restore the initial text and command-specific accessible label', async () => {
  const ui = setup()
  let pending = ui.click()
  ui.requests[0].resolve()
  await pending
  assert.equal(ui.button.textContent, 'Copied')
  pending = ui.click()
  ui.requests[1].resolve()
  await pending
  ui.reset()
  assert.equal(ui.button.textContent, 'Copy')
  assert.equal(ui.button.getAttribute('aria-label'), 'Copy install command')
})

test('an older clipboard completion cannot overwrite a newer failure or its reset', async () => {
  const ui = setup()
  const first = ui.click()
  const second = ui.click()
  ui.requests[1].reject(new Error('Clipboard denied'))
  await second
  assert.equal(ui.button.textContent, 'Copy failed')
  ui.reset()
  ui.requests[0].resolve()
  await first
  assert.equal(ui.button.textContent, 'Copy')
  assert.equal(ui.button.getAttribute('aria-label'), 'Copy install command')
})

test('a stale reset cannot clear feedback from a newer pending clipboard request', async () => {
  const ui = setup()
  const first = ui.click()
  ui.requests[0].resolve()
  await first
  const second = ui.click()
  ui.reset()
  ui.requests[1].resolve()
  await second
  assert.equal(ui.button.textContent, 'Copied')
  ui.reset()
  assert.equal(ui.button.textContent, 'Copy')
})

test('clipboard unavailability restores the original accessible label', async () => {
  const ui = setup({ clipboard: false })
  await ui.click()
  assert.equal(ui.button.getAttribute('aria-label'), 'Clipboard access is unavailable')
  ui.reset()
  assert.equal(ui.button.textContent, 'Copy')
  assert.equal(ui.button.getAttribute('aria-label'), 'Copy install command')
})

test('an older clipboard rejection cannot overwrite a newer successful copy', async () => {
  const ui = setup()
  const first = ui.click()
  const second = ui.click()
  ui.requests[1].resolve()
  await second
  ui.requests[0].reject(new Error('Older request denied'))
  await first
  assert.equal(ui.button.textContent, 'Copied')
  assert.equal(ui.button.getAttribute('aria-label'), 'Command copied to clipboard')
  ui.reset()
  assert.equal(ui.button.textContent, 'Copy')
  assert.equal(ui.button.getAttribute('aria-label'), 'Copy install command')
})

test('a button initially without an aria-label does not retain a status label', async () => {
  const ui = setup({ label: null })
  const pending = ui.click()
  ui.requests[0].resolve()
  await pending
  ui.reset()
  assert.equal(ui.button.textContent, 'Copy')
  assert.equal(ui.button.getAttribute('aria-label'), null)
  assert.equal(ui.requests[0].value, 'npx skills add AzureManagedRedis/amr-agent-kit')
})
