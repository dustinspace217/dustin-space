// Flat config (ESLint 9). Strict-recommended from day one (Power of Ten rule 10):
// the package ships warning-clean, and reviewers never burn a pass on lint.
'use strict';
const js = require('@eslint/js');
module.exports = [
	js.configs.recommended,
	{
		languageOptions: {
			ecmaVersion: 2022,
			sourceType: 'commonjs',
			globals: {
				// Node 22 built-ins used without imports.
				fetch: 'readonly', WebSocket: 'readonly', AbortSignal: 'readonly',
				Buffer: 'readonly', process: 'readonly', console: 'readonly',
				setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
				clearInterval: 'readonly', require: 'readonly', module: 'readonly', __dirname: 'readonly',
			},
		},
		rules: { 'no-unused-vars': ['error', { argsIgnorePattern: '^_' }] },
	},
];
