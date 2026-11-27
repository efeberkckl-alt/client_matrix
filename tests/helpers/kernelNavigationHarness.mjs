import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { transformSync } from 'esbuild';

const require = createRequire(import.meta.url);
const source = readFileSync(new URL('../../src/main/libs/matrix/kernelNavigation.ts', import.meta.url), 'utf8');
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code;
const fixture = { exports: {} };
new Function('require', 'module', 'exports', code)(require, fixture, fixture.exports);
export const { diagnosticAccountAlias, KernelNavigationError, NavigationTrace, navigationPage } = fixture.exports;
