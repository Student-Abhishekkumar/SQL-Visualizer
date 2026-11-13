import '@testing-library/jest-dom/vitest'

// Silence React act() warnings in RTL tests that trigger async stores.
// Individual tests can still assert on console output when relevant.
