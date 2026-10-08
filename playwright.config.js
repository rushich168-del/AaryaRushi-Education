import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: './tests/lms',
  outputDir: './test-results/lms',
  reporter: [['list']],
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5186', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { viewport: { width: 360, height: 800 }, isMobile: true, hasTouch: true } },
  ],
  webServer: process.env.KSC_TEST_EXTERNAL_SERVER === '1' ? undefined : {
    command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5186 --strictPort',
    url: 'http://127.0.0.1:5186',
    reuseExistingServer: false,
    env: {
      VITE_SUPABASE_URL: 'https://ksc-test.supabase.co',
      VITE_SUPABASE_ANON_KEY: 'ksc-local-test-key',
    },
  },
})
