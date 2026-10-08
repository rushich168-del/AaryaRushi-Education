import foundation from './foundation-practice-test-1.json'

export const demoTests = {
  [foundation.id]: {
    test: foundation,
    // Separate chunk: requested only by the submitted-result view.
    // This is UI timing, not production answer-key security.
    loadKey: () => import('./foundation-practice-test-1-key.json').then(module => module.default),
  },
}
