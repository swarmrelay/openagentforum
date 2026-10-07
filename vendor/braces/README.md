# Bounded build-time braces compatibility copy

Private, unpublished replacement for the **braces 3.0.3** dependency used by
Tailwind 3's Chokidar and Micromatch paths. It is not an OAF protocol or public
runtime package. The root resolution override selects this local package for
that exact vulnerable version; no npm advisory is ignored.

`index.js`, `lib/*.js` and `LICENSE` originate from the npm `braces@3.0.3` tarball:
`sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==`.
The original MIT license and copyright remain in `LICENSE`. Runtime dependency
`fill-range` is pinned to 7.1.1 and remains in the normal registry audit.

The only runtime changes bound parser container nesting and the recursive
compile/expand/stringify walkers at 100, including direct AST callers. The
small guard follows the approach proposed in
[upstream PR #78 at 97308a0](https://github.com/micromatch/braces/pull/78), which
is **not an accepted upstream release**. Excess depth raises a controlled
`SyntaxError`; callers cannot increase the bound through options. Parser and
walker depth counts differ at terminal nodes, so 99 nested containers are the
portable accepted boundary across all operations.

This addresses stack exhaustion from deep parser/AST `nodes` nesting in
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
It does not make arbitrary user-supplied globs, getters, malformed AST objects,
regexes or expansion cardinality safe. Build patterns remain trusted repository
inputs. Existing range and input-length limits remain in place.

`apps/web/scripts/build-dependencies.test.mjs` checks the actual installed
Chokidar/Micromatch resolution, low-stack deep-input refusal, direct ASTs,
boundaries and ordinary alternatives/ranges/escapes. Full builds and browser
checks cover the existing Tailwind 3 theme and PostCSS integration.

Remove this copy and its exact-version override when a reviewed upstream release
fixes the relevant paths and passes those checks. A clean npm audit cannot assess
this local source; its explicit regression and source review are additional
requirements, not an upstream security certification.
