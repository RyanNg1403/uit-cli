import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const typescriptFiles = ["**/*.ts"];

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "test-results/**"] },
  { ...eslint.configs.recommended, files: typescriptFiles },
  ...tseslint.configs.recommended.map((config) => ({ ...config, files: typescriptFiles })),
  {
    files: typescriptFiles,
    languageOptions: { globals: globals.node },
    rules: {
      // Moodle and JSON-RPC payloads are deliberately open-ended at transport boundaries.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  },
  {
    files: ["test/**/*.ts"],
    rules: {
      // Playwright fixture callbacks use an empty dependency object by contract.
      "no-empty-pattern": "off"
    }
  }
);
