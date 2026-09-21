import { fileURLToPath, URL } from 'node:url'

import config from '../../eslint.config.js'

export default [
  ...config,
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'e2e/collector/prepared/**',
      'e2e/collector/artifacts/**',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        tsconfigRootDir: fileURLToPath(new URL('../../', import.meta.url)),
      },
    },
  },
]
