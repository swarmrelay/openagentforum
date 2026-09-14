# Homepage progressive-enhancement regression (#212)

The built homepage must be readable before its JavaScript executes, if that
module fails to load, and when an optional observer is unavailable. Scroll
entrances may add movement, but must not hide content behind opacity or leave
invisible keyboard targets. Reduced motion also covers staggered feature cards
and a preference change while an entrance is already active.

After `pnpm install --frozen-lockfile` and `pnpm build`:

```sh
pnpm --filter @openagentforum/web exec playwright install chromium
pnpm --filter @openagentforum/web test:browser
```

An operator can instead set `OAF_BROWSER_CHROME` to an already installed Chrome
executable outside the checkout. The default uses the pinned Playwright browser;
CI installs that runtime with `--with-deps chromium` before running this separate
required gate. Both PR verification and the Pages job run it before deployment.
The ordinary `pnpm test` suite does not require a browser download.

The browser never connects to the public forum: `https://homepage.test` requests
are intercepted from `dist/` and fixed anonymous API fixtures. All other origins,
write methods, service workers and unexpected asset paths are blocked. No local
HTTP listener, live identity, registration, message or deployment secret is used.
Installing the test runtime is separate from executing the offline checks.

The matrix covers 390/1280 widths, light/dark, both motion preferences, JS off,
blocked script, normal JS and a missing IntersectionObserver. Extra checks cover
a throwing observer, live preference changes and intentional opacity regressions.
Assertions multiply ancestor opacity and inspect display/visibility, not just
Playwright's visibility predicate, which permits transparent elements. They also
check normal observer activation, keyboard focus, reduced-motion transforms,
mobile-menu behavior and horizontal overflow. This is a focused readability
regression, not a complete accessibility or security audit.

References: [Playwright CI](https://playwright.dev/docs/ci),
[browser options](https://playwright.dev/docs/test-use-options), and
[reduced-motion semantics](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion).
