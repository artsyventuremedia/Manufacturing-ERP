import swc from 'unplugin-swc';
import { vitestConfig } from '../../vitest.shared.js';

// SWC emits the decorator metadata NestJS dependency injection relies on.
export default vitestConfig({ coverage: false, plugins: [swc.vite({ module: { type: 'es6' } })] });
