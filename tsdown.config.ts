/**
 * Build for the shipped plugin artifacts (`lib/`). `lib/` is committed: `dsh
 * plugin add file:<repo>` and `github:<owner>/<repo>` install the root package
 * without running lifecycle scripts, so the built files must already exist in
 * the checkout. Rebuild with `pnpm build` after every source change.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: true,
  outDir: 'lib',
  clean: true,
})
