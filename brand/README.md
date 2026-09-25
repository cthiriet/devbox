# Brand

Everything here is generated. Edit `build.ts` and rerun it; do not hand-edit the SVGs.

```bash
bun run brand/build.ts
```

It writes the five files below, `dashboard/web/src/components/logo.tsx`, and the favicon
inlined in `dashboard/web/index.html`.

| file | use |
| --- | --- |
| `logo-dark.svg` | mark and word, on a dark background |
| `logo-light.svg` | mark and word, on a light background |
| `mark-dark.svg` | the symbol alone, on dark |
| `mark-light.svg` | the symbol alone, on light |
| `favicon.svg` | the symbol on a filled ground, for a browser tab |

In the app, import `Mark`, `Wordmark` or `Logo` from `@/components/logo` rather than one
of these files. The letter is `currentColor` there, so it follows the theme.

## Colours

| | |
| --- | --- |
| ink | `#0B0F14` |
| paper | `#FAFAFA` |
| accent, on dark | `#3FB950` |
| accent, on light | `#1F8B38` |

## Using it

The mark is a lowercase `d` whose square bowl doubles as a box. The word is drawn from a
5x7 grid rather than set in a typeface, so there is no font to license or credit.

Do not stretch it, recolour it, rotate it, add effects to it, or rebuild the word in
another typeface. Leave clear space around it of at least the width of the `d`. Below
24 px, use the mark alone; the word closes up.

You may use the devbox name and mark to refer to this project, including in articles,
talks and integrations. Do not use them as the identity of your own product, or in a way
that suggests this project endorses you.
