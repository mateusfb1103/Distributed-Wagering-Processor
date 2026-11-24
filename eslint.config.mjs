import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    // §6.1: domínio puro não depende de NestJS nem de ORM
    files: ["src/**/domain/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@nestjs/*", "@mikro-orm/*", "@aws-sdk/*", "pg", "pino"],
              message:
                "A camada de domínio deve permanecer pura, sem dependências de framework, ORM ou infraestrutura (§6.1).",
            },
          ],
        },
      ],
    },
  },
  {
    // R1 (§5.1): proíbe ponto flutuante / number no módulo Money
    files: ["src/shared/domain/money*.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "TSNumberKeyword",
          message:
            "Não use o tipo `number` no módulo Money (restrição inviolável R1 — §5.1).",
        },
        {
          selector: "CallExpression[callee.name='Number']",
          message:
            "Não use `Number()` no módulo Money (restrição inviolável R1 — §5.1).",
        },
        {
          selector: "CallExpression[callee.name='parseFloat']",
          message:
            "Não use `parseFloat()` no módulo Money (restrição inviolável R1 — §5.1).",
        },
      ],
    },
  },
);
