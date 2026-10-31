/**
 * Build for the shipped plugin artifacts (`lib/`). `lib/` is not committed:
 * the release workflow builds it and ships it inside the `pnpm pack` tarball
 * (docs/adr/0006). Run `pnpm build` before installing from a local checkout.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  dts: true,
  outDir: 'lib',
  clean: true,
})
