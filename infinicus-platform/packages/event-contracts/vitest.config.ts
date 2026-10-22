import { configDefaults, defineConfig } from 'vitest/config';

// This package keeps its tests in src/__tests__, so `tsc` also emits compiled copies into dist/__tests__. Vitest 1 excluded dist by default; vitest 4
// excludes only node_modules and .git, so without this it would run (and fail to load) the compiled copies as well as the real tests.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, '**/dist/**'] },
});
