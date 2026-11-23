# /alternatives pages — removed

The competitor comparison pages are gone, along with the generator that built them
(`tools/build-alternatives.js`) and its data file (`alternatives-data.js`). Nothing in
this directory is served.

`vercel.json` permanently redirects `/alternatives/:slug` to `/what-you-get`, so old
links land on the product page instead of a 404.

Do not add pages back here by copying `index.html` into a new slug: that is how
`/alternatives/kickserv` and `/alternatives/servicem8` once shipped the homepage with
the homepage canonical and title, and Google would not index them.

If comparison pages return, generate them from a single data file, prerender the copy
into the document, give each page its own `<title>`, description and canonical, and add
it to `sitemap.xml`. Regenerate whenever `index.html` changes.
