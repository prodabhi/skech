import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    // src/components/ui is the coss ui registry, added verbatim by the shadcn
    // CLI. We own the files, but they are upstream code we want to be able to
    // re-sync, so they are not held to our own lint rules. Anything we author
    // on top of them lives in src/components/site.
    files: ["src/components/ui/**", "src/hooks/**", "src/lib/**"],
    rules: {
      "react-hooks/purity": "off",
    },
  },
]);

export default eslintConfig;
