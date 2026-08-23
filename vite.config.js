import { defineConfig } from 'vite';

export default defineConfig({
    root: './',
    build: {
        outDir: 'dist',
        emptyOutDir: true,
    },
    server: {
        port: 3001,
    },
    test: {
        // Only pick up tests in tests/ (vitest format).
        // The legacy test/ directory uses a custom Node assert runner and is
        // executed separately via the test:legacy npm script.
        include: ['tests/**/*.{test,spec}.{js,ts}'],
        exclude: ['test/**', 'node_modules/**'],
        testTimeout: 15000,
    },
});
