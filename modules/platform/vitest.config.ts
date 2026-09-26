import swc from 'unplugin-swc';
import { vitestConfig } from '../../vitest.shared.js';

export default vitestConfig({ coverage: true, plugins: [swc.vite({ module: { type: 'es6' } })] });
