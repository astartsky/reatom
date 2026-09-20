import { playwright } from '@vitest/browser-playwright'
import { defineConfig } from 'vitest/config'
import type { BrowserCommandContext } from 'vitest/node'

type Page = BrowserCommandContext['page']
type ConsoleMessage = { type(): string; text(): string }
const captures = new WeakMap<
  Page,
  { messages: string[]; listener: (message: ConsoleMessage) => void }
>()

const stopConsoleCapture = ({ page }: BrowserCommandContext): string[] => {
  const capture = captures.get(page)
  if (!capture) return []
  page.off('console', capture.listener)
  captures.delete(page)
  return capture.messages
}

export default defineConfig({
  // The acceptance runner can keep Vite artifacts outside the worktree.
  cacheDir: process.env.OTEL_BROWSER_CACHE_DIR,
  server: { host: '127.0.0.1', port: 0 },
  test: {
    name: '@reatom/opentelemetry-browser',
    include: ['./src/**/*.test.browser.ts'],
    globalSetup: ['./browser-test-server.ts'],
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
    browser: {
      enabled: true,
      api: { host: '127.0.0.1', port: 0 },
      provider: playwright(),
      headless: true,
      screenshotFailures: false,
      instances: [{ name: 'opentelemetry-chromium', browser: 'chromium' }],
      commands: {
        startConsoleCapture(context: BrowserCommandContext) {
          stopConsoleCapture(context)
          const messages: string[] = []
          const listener = (message: ConsoleMessage) => {
            if (message.type() === 'error') messages.push(message.text())
          }
          captures.set(context.page, { messages, listener })
          context.page.on('console', listener)
        },
        stopConsoleCapture,
      },
    },
  },
})
