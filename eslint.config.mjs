// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

// Shared lint gate for the Heretek Games Drop plugins. Intentionally not
// type-aware (fast, no tsconfig program). Rules that would require a
// pre-existing cleanup pass are warnings so the gate lands green; core rules
// and unused vars remain errors.
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "plugin-bundle/**",
      "dist-packages/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // TypeScript already reports undeclared identifiers; no-undef only adds
      // false positives for runtime globals (fetch, process, ...).
      "no-undef": "off",
      "no-useless-assignment": "warn",
      "preserve-caught-error": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/ban-ts-comment": "warn",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
