import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        Date: "readonly",
        Promise: "readonly",
        MutationObserver: "readonly",
        PerformanceObserver: "readonly",
        localStorage: "readonly",
        sessionStorage: "readonly",
        document: "readonly",
        performance: "readonly",
      },
    },
  },
  {
    ignores: ["node_modules/", "output/"],
  },
];
