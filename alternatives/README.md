# /alternatives pages

These are **generated**. Do not hand-edit them, and never copy `index.html` into a
new slug. That is how `/alternatives/kickserv` and `/alternatives/servicem8` shipped
the homepage: identical to each other, carrying the homepage canonical and title, so
Google would not index them.

## The one source of truth

`alternatives-data.js` (repo root) holds every competitor's title, description, h1,
their published price, four comparison points and the math paragraph.

The app reads that same file at runtime, so the static page a crawler sees and the
page the browser renders cannot disagree.

## To add or change a competitor

1. Add or edit the entry in `alternatives-data.js`.
2. Run the generator from the repo root:

   ```
   node tools/build-alternatives.js
   ```

3. Deploy.

The generator writes `alternatives/<slug>.html` from `index.html` (the master
template) with:

- per-slug `<title>`, description, `og:*` and `rel=canonical`
- the comparison content prerendered into `#app`, so crawlers and link previews see
  real copy instead of an empty shell
- the slug added to `sitemap.xml` if it is missing

It fails loudly if any anchor it depends on has moved in `index.html`, rather than
silently producing a broken page. It prints a verification table at the end: every
slug must show its own canonical and `inSitemap=yes`.

`tools/alt-template.html` is the prerendered markup block the generator fills in.

## Important

Any time `index.html` changes, re-run the generator, or these pages fall behind the
app (they previously shipped without the calendar fix, the monthly pricing and the
offline support). Regenerating is part of shipping.
