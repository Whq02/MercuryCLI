// Ambient declaration for the React-Compiler runtime subpath.
//
// Many vendored components are React-Compiler output and open with
//   import { c as _c } from "react/compiler-runtime";
// `@types/react` does not ship a declaration for this subpath, so strict tsc
// reported `TS2305: Module '"react/compiler-runtime"' has no exported member 'c'`
// on every such file (361 occurrences). `c` is React's memo-cache hook
// (a.k.a. `useMemoCache`): `c(size)` returns the cache-slot array the generated
// `$[…]` reads/writes index into. Typing it as `Array<any>` matches React's own
// internal declaration, so the generated `$[n]` slots stay `any` exactly as before
// — this resolves the import without changing any downstream inferred type.
declare module "react/compiler-runtime" {
  export function c(size: number): Array<any>;
}
