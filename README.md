# Myslewer

Offline-first mobile crane fleet operations toolkit — a single-file Progressive Web App for rope retentioning, hook block selection, outrigger support positioning, and reeving plan reference, covering the fleet's LRT/LTM/LTR crane models.

**Live app:** https://886ppak.github.io/myslewer/

> This repo was renamed from `liebherr` to `myslewer`. If you'd previously installed the app to your home screen from the old `886ppak.github.io/liebherr/` URL, that install is now stale — remove it and reinstall from the link above.

---

## What's inside

Four tools in one app, switchable by tab:

- **Rope Retentioning** — minimum parts of line needed to strip working rope off the drum ahead of retentioning work, plus the resulting tensioning test weight, per crane / boom config / winch.
- **Minimum Hook Block Weights** — recommends a primary and alternative hook block for a given boom length and reeving count, flagging any auxiliary ballast plates required.
- **Outrigger Support Positioning** — visual site-plan tool for repositioning a crane: shows which outrigger pads must move for a given shift, their new position, and flags any target spot currently sitting under the crane's own chassis.
- **Reeving Plan** — browsable reference of OEM reeving diagrams (way-count, sheave routing notation, and the actual extracted diagram) across the fleet's boom and head configurations, with pinch-to-zoom and a one-tap "download all diagrams for offline use" option.

Works fully offline once loaded — install it to your home screen and it behaves like a native app, including on a job site with no signal.

---

## Structure

```
/
├── index.html              # the entire app — HTML, CSS, and JS in one file
├── manifest.json            # PWA install manifest
├── sw.js                    # service worker (offline caching)
├── icons/                    # app icons (192, 512, maskable, apple-touch)
└── reeving/
    ├── manifest.json        # reeving diagram dataset (crane → config → way → diagram)
    └── svg/                  # extracted OEM reeving diagrams, one SVG per entry
```

No build step, no framework, no dependencies — open `index.html` in a browser or serve the folder statically (GitHub Pages does both).

---

## Deploying an update

1. Edit `index.html` (and/or the other files) as needed.
2. Bump `CACHE_VERSION` in `sw.js` — this is what tells an already-installed copy to fetch the new version instead of serving a stale cache. The app also has a manual "check for update" button in the header that force-refetches the app shell regardless, but bumping the version is still good practice.
3. Commit and push. GitHub Pages picks it up automatically.

---

## Notes on the data

- Rope, hook block, and outrigger positioning figures are sourced from OEM specification sheets and dimension drawings for the crane fleet in use.
- Reeving diagrams are the actual OEM reeving plan artwork, extracted directly — not redrawn.
- A small number of crane/config combinations don't have published data for one or more tabs (e.g. no CAD/mat-position chart yet for certain models). The app disables those options with an explanatory note rather than guessing.

**This is a reference tool, not a substitute for the current OEM load chart and rigging plan.** Cross-check reeving, pull ratings, ballast, and outrigger positions against the manufacturer's documentation for the specific lift before use on site.
