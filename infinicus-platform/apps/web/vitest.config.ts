import { defineConfig } from 'vitest/config';

// Page components are TSX; tsconfig keeps jsx "preserve" for Next, so tests transform JSX with the automatic runtime.
export default defineConfig({
  esbuild: { jsx: 'automatic' },
});
