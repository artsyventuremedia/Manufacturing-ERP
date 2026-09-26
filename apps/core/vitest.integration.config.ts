import swc from 'unplugin-swc';
import { vitestConfig } from '../../vitest.shared.js';

export default vitestConfig({
  integration: true,
  plugins: [swc.vite({ module: { type: 'es6' } })],
});
