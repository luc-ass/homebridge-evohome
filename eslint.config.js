// @ts-check
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Der Altcode aus 0.11.2 bleibt bis Phase 5 als Referenz liegen und wird
    // bewusst nicht gelintet. Siehe legacy/README.md.
    ignores: ["dist/**", "legacy/**", "node_modules/**", "coverage/**"],
  },

  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // tsconfig.check.json umfasst src/, test/ und die Config-Dateien —
        // tsconfig.json allein deckt nur src/ ab und ließe die Tests ungeprüft.
        project: ["./tsconfig.check.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // --- Regeln, die konkrete Befunde aus docs/MIGRATION-HB2.md absichern ---

      // S4: `if ((this.model = "HeatingZone"))` in legacy/index.cjs:982 —
      // Zuweisung statt Vergleich, die stillschweigend jedes Modell überschrieb.
      "no-cond-assign": ["error", "always"],

      // S3: zehnfach verschachtelte Callback-Pyramiden in legacy/index.cjs.
      "max-depth": ["error", 3],
      "max-nested-callbacks": ["error", 3],

      "no-restricted-syntax": [
        "error",
        {
          // B3: Characteristic.getValue() existiert in HAP 2.x nicht mehr.
          selector: "MemberExpression[property.name='getValue']",
          message:
            "Characteristic.getValue() wurde in HAP 2.x entfernt (Befund B3). updateValue() verwenden.",
        },
        {
          // B7: new Buffer(...) ist seit Node 6 deprecated. Die Regel trifft
          // gezielt den Konstruktoraufruf — Buffer.from()/alloc() bleiben erlaubt.
          selector: "NewExpression[callee.name='Buffer']",
          message:
            "new Buffer(...) ist deprecated (Befund B7). Buffer.from() oder Buffer.alloc() verwenden.",
        },
      ],

      // S5/S12: verschluckte Fehler und vergessene awaits waren die Ursache
      // dafür, dass Ausfälle der Honeywell-API das Plugin lahmlegten.
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",

      // Konsistenz
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // API-Antworten werden als Record<string, unknown> gelesen. Der
      // Klammerzugriff macht sichtbar, dass das Feld aus ungeprüftem JSON
      // stammt und nicht aus einem bekannten Typ.
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
    // Config-Dateien im Projektwurzelverzeichnis liegen außerhalb von
    // tsconfig.json und vertragen kein typgestütztes Linting.
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },

  {
    files: ["test/**/*.ts"],
    rules: {
      // Fixtures und Mocks dürfen lockerer sein als Produktivcode.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "max-nested-callbacks": ["error", 5],
    },
  },
);
