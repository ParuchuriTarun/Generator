# Branch Surprise Visit Checklist

A single-page checklist for the three sheets in the Branch Surprise Visit workbook:

- Operations and admin
- Display
- Branch infrastructure

Each checkpoint has Yes/No buttons, a free-text remark, and up to 10 photos. Answers and remarks are saved in the browser automatically; photos are kept in IndexedDB. The **Download PDF** button creates a paginated A4 report with a cover summary, every checkpoint, remarks, and photo evidence.

## Use it

Open **`Branch Surprise Visit Checklist.html`** or the root **`index.html`** in a browser (Chrome or Edge recommended). No server, install, or internet connection is needed. Choose a branch from the reference list to fill its category and address, work through the tabs, then click **Download PDF**. The PDF is generated in the browser and saved to your Downloads folder automatically, without opening a print dialog.

The root `index.html` is the Vercel entry point; the friendly-named HTML is the same file for local use.

Everything stays on the computer running the browser. Clearing site data for the file, or using **Clear**, removes the saved visit and photos.

## Editable sources

The ready-to-use HTML is generated from the files in `src/`:

| File | Purpose |
| --- | --- |
| `src/data.js` | Checklist sections, item text, requirements by branch category, and the 152-branch reference list |
| `src/index.html` | App shell, forms, dialogs, and report root |
| `src/styles.css` | Screen styles and the A4 report styles |
| `src/app.js` | Answers, remarks, photos, local saving, branch picker, print pagination and PDF download |
| `src/vendor/` | Offline PDF libraries (`html-to-image` and `jsPDF`) and their licences |
| `src/build.py` | Inlines the sources into the root HTML files (including `index.html` for Vercel) |

After editing a source file, rebuild the single HTML from the project folder:

```powershell
python src/build.py
```

Open `src/index.html` directly while developing to use the separate source files. Keep item ids stable: saved answers and photos are keyed by those ids.

## Notes

- The three sheets contain 105 checkpoints in total (Operations 41, Display 38, Infrastructure 26).
- Infrastructure requirement labels (Must / Optional) follow the branch category, A, B, or C, from the workbook's Reference sheet.
- The PDF report always includes all three checklists, including unanswered checkpoints.
- Photos are compressed in the browser to a maximum edge of 1600 px and stored as JPEG data. The limit is 10 photos per checkpoint.
- The PDF is A4 portrait. Rendering a visit with many photos can take a few seconds; keep the tab open until the download starts.
- The report is generated entirely offline. No answers or photos are uploaded anywhere.
