// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // The 0.11.2 code is kept as a reference and deliberately not linted.
    // See legacy/README.md.
    ignores: ["dist/**", "legacy/**", "node_modules/**", "coverage/**"],
  },

  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // tsconfig.check.json covers src/, test/ and the config files; tsconfig.json
        // alone covers only src/ and would leave the tests unchecked.
        project: ["./tsconfig.check.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- Rules that guard against specific bugs found in 0.11.2 ---

      // `if ((this.model = "HeatingZone"))` in legacy/index.cjs:982 — an
      // assignment where a comparison was meant, silently overwriting every
      // model.
      "no-cond-assign": ["error", "always"],

      // Callback pyramids ten levels deep in legacy/index.cjs.
      "max-depth": ["error", 3],
      "max-nested-callbacks": ["error", 3],

      "no-restricted-syntax": [
        "error",
        {
          // Characteristic.getValue() no longer exists in HAP 2.x.
          selector: "MemberExpression[property.name='getValue']",
          message:
            "Characteristic.getValue() was removed in HAP 2.x; use updateValue() instead.",
        },
        {
          // new Buffer(...) has been deprecated since Node 6. This targets the
          // constructor call only; Buffer.from()/alloc() stay allowed.
          selector: "NewExpression[callee.name='Buffer']",
          message:
            "new Buffer(...) is deprecated; use Buffer.from() or Buffer.alloc().",
        },
      ],

      // Swallowed errors and forgotten awaits are why a Honeywell outage used to
      // take the plugin down.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",

      // Consistency
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // API responses are read as Record<string, unknown>. Bracket access makes it
      // visible that a field comes from unvalidated JSON rather than a known
      // type.
      "@typescript-eslint/dot-notation": [
        "error",
        { allowIndexSignaturePropertyAccess: true },
      ],

      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },

  {
    // Config files in the repository root sit outside tsconfig.json and cannot
    // be linted with type information.
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    files: ["test/**/*.ts"],
    rules: {
      // Fixtures and mocks may be looser than production code.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "max-nested-callbacks": ["error", 5],
    },
  },
);
