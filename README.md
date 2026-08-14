# Myslewer

A field reference app for the mobile crane fleet — rope retentioning, hook block selection, outrigger support positioning, and reeving diagrams, all in one Progressive Web App that works with no signal once installed.

**Open the app:** https://886ppak.github.io/myslewer/

> Renamed from `liebherr` to `myslewer`. If you installed it to your home screen from the old `886ppak.github.io/liebherr/` link, that install is stale — remove it and reinstall from the link above.

---

## What it does

Four tools, one tab bar:

- **Rope Retentioning** — how many parts of line to strip enough working rope off the drum for retentioning, plus the test weight, per crane / boom config / winch.
- **Minimum Hook Block Weights** — a primary and alternative hook block for a given boom length and reeving count, with any required auxiliary ballast plates flagged.
- **Outrigger Support Positioning** — a site-plan tool: shows which outrigger pads must move for a planned shift, where they land, and warns if a target spot is currently under the crane's own chassis.
- **Reeving Plan** — the OEM reeving diagrams themselves (way-count, sheave routing notation, hook block type) for every boom/head config in the fleet, pinch-to-zoom, with a one-tap "download all" for offline use.

Covers the LRT 1100, LTM 1110, LTM 1130, LTM 1160, LTM 1250, LTM 1300, LTM 1650, and LTR 1220. Coverage isn't identical across every tab for every crane — see [Notes on the data](#notes-on-the-data).

## Installing it

Open the link above in a mobile browser and add it to your home screen (Safari: Share → Add to Home Screen; Chrome: menu → Install app). Once installed, it works fully offline — the app shell, all reference data, and any reeving diagram you've viewed at least once are cached on-device.

If the app ever looks out of date after an update was announced, use the **check for update** button in the header — it force-refetches everything regardless of cache state.

---

## Notes on the data

- Rope, hook block, and outrigger positioning figures come from OEM specification sheets and dimension drawings for this fleet.
- Reeving diagrams are the actual OEM reeving plan artwork, extracted directly — not redrawn.
- The LTR 1220 has no Outrigger Support Positioning data yet — it doesn't appear in that tab's crane list at all. It's fully covered in the other three tabs.
- **This is a reference tool, not a substitute for the current OEM load chart and rigging plan.** Cross-check reeving, pull ratings, ballast, and outrigger positions against the manufacturer's documentation for the specific lift before use on site.

---

## For anyone touching the code

No build step, no framework, no dependencies — `index.html` is the entire app (HTML, CSS, and JS in one file).

```
/
├── index.html              # the entire app
├── manifest.json            # PWA install manifest
├── sw.js                    # service worker (offline caching)
├── icons/                    # app icons (192, 512, maskable, apple-touch)
├── methodology.txt          # design reasoning, sign conventions, and known gaps — read before changing tabs 1-3
└── reeving/
    ├── manifest.json        # reeving diagram dataset (crane → config → way → diagram)
    └── svg/                  # extracted OEM reeving diagrams, one SVG per entry
```

To deploy a change: edit the files, bump `CACHE_VERSION` in `sw.js` if you touched `index.html`, the icons, or either manifest, then commit and push — GitHub Pages picks it up automatically. Without the version bump, installed copies keep serving the old cached app shell until someone taps "check for update."

`methodology.txt` documents the reasoning behind the non-obvious parts of this app — sign conventions in the outrigger tab, a retentioning formula that looks like a bug but isn't, and known unresolved items. Read it before changing anything in tabs 1-3.

## License

[PolyForm Noncommercial License 1.0.0](./LICENSE) — free to use, copy, modify, and redistribute for any noncommercial purpose. Commercial use (including monetizing it in any form) is not permitted without separate permission.
