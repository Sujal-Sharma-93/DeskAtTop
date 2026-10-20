import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

export default {
  preprocess: vitePreprocess(),
  compilerOptions: {
    // Keep DOM output lean - no runtime helpers we do not need.
    runes: true,
  },
};
