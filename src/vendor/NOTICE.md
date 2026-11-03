# Vendored PDF libraries

These files are bundled so the checklist works offline, as a single HTML file.
Both libraries are MIT licensed; the full licence texts are next to this note.

| File | Project | Version | Licence |
| --- | --- | --- | --- |
| `html-to-image.js` | [html-to-image](https://github.com/bubkoo/html-to-image) | 1.11.13 | MIT |
| `jspdf.umd.min.js` | [jsPDF](https://github.com/parallax/jsPDF) | 2.5.2 | MIT |

`html-to-image` renders each A4 report page to a canvas in the browser.
`jsPDF` assembles those canvases into the downloadable PDF. No data leaves the
computer, and no network connection is needed after this folder is built.
