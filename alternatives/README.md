# /alternatives/* — do not make these files identical

**RETIRED RULE:** earlier deploys required all seven SPA shells to be byte-identical
(`cp index.html alternatives/<slug>`, verified with `md5sum`). That rule is what broke these
pages and is now cancelled. Do not reapply it.

## Why
Identical shells meant every comparison page shipped the homepage's
`<title>`, meta description, `og:url` and `<link rel="canonical">`. Each page therefore told
Google it was a duplicate of `https://app.leonlink.net/`, so all six were dropped from the index.
Crawlers that do not execute JavaScript (Bing, DuckDuckGo, ChatGPT, Perplexity) saw a homepage
clone and nothing else.

## Current pattern
Each route is a standalone prerendered file with:
- its own `<title>` and meta description
- a **self-referencing** canonical, `https://app.leonlink.net/alternatives/<slug>`
- its own `og:url`, `og:title`, `og:description`
- the H1, comparison copy and price table present in the **raw markup**, inside `<div id="app">`

The SPA still boots and re-renders the same markup into `#app`, so JavaScript users get the
interactive page and crawlers get real content.

## Regenerating after changing comparison copy
1. Edit the `pages` object in `renderAlternativePage()` in `index.html`.
2. Capture the rendered markup for each slug and rewrite the files. Do **not** copy `index.html`
   over them.
3. Verify:
   ```
   curl -s https://app.leonlink.net/alternatives/jobber | grep -i canonical
   # must point at /alternatives/jobber, not the root
   curl -s https://app.leonlink.net/alternatives/jobber | grep -ci "charges per user"
   # must be > 0 with JavaScript disabled
   ```
4. Every file must have a unique `<title>`.
