# Project website

The public project page is hosted at **https://kamilkubik89.github.io/merx/**. It introduces the engine, provides an interactive viewer for real matching results, and links visitors to the repository, documentation and discussions.

## Build

Requires Node.js 22.6 or later. No dependency installation is needed to build the site.

```bash
npm run site:build
```

The output is `_site/`, which is ignored by Git. Serve that directory with a local static HTTP server to preview it. Opening `index.html` directly as a file will not allow the scenario JSON fetch in most browsers.

## Source of truth

- `site/`: semantic HTML, responsive CSS, JavaScript, sitemap and a 404 page.
- `scripts/build-site.ts`: imports the actual intent matcher and runs three scenarios against the fictional coffee catalog.
- `docs/assets/`: the shared logo and social preview image.

The viewer switches between build-time results. It does not run an LLM, accept customer information or place orders. Relevance scores are ranking values, not probabilities. All displayed product text is inserted with `textContent`, not interpreted as HTML.

Only selected intent requests and their public results are serialized. The merchant catalog and its private price floors are not copied into the site. Build assertions check the expected scenario outcomes and reject obvious private fields in the generated JSON.

## Publishing and discoverability

The `Project site` workflow checks the build on pull requests and deploys only the `main` branch to GitHub Pages. GitHub Pages must use GitHub Actions as its publishing source. Its deployment environment is `github-pages`.

The page includes an English title and description, a canonical URL, Open Graph and social-card metadata, SoftwareSourceCode structured data, accessible navigation and a sitemap at `/merx/sitemap.xml`. These help describe the project to link previews and crawlers; they do not guarantee indexing or ranking.

If the repository owner, repository name or hosting domain changes, update the canonical URL, social metadata, structured data, sitemap, README and repository homepage together. A project-level `robots.txt` is not included because crawlers read it at the host root, which this repository does not control.

There are no analytics trackers, cookies, third-party fonts or external JavaScript on the page. Hosting requests are handled by GitHub Pages.

## Visual and functional review

- Check desktop and narrow mobile layouts.
- Switch among all three scenarios; verify that the decaf request has one match and the budget grinder request has none.
- Expand rejection reasons and FAQ answers.
- Check keyboard focus, the skip link and copy-button fallback.
- Confirm that the public URL and its image, stylesheet, script and scenario JSON load after deployment.
