// Линт собственных .js-файлов конфига (без TS-парсера).
import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
