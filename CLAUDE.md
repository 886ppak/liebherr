# Git workflow

`main` is the primary branch (production, `886ppak.github.io/myslewer/`).
Develop directly on `main`, commit, and push to `origin main` as the
primary step.

Then shadow the same change onto `beta-trial` so the beta channel stays
current too:

1. `git checkout beta-trial`
2. `git cherry-pick <commit>` (resolve the routine `sw.js` CACHE_VERSION
   conflict — keep beta-trial's own `myslewer-v51-betaN` scheme, bump N)
3. `git push -u origin beta-trial` and `git push beta beta-trial`
4. Sync into `myslewer-beta`'s own `main` (its GitHub Pages serves that
   branch, not `beta-trial`):
   ```
   git fetch beta main
   git branch beta-main-sync beta-trial && git checkout beta-main-sync
   git merge beta/main --no-edit -m "Merge myslewer-beta main into beta-trial's tip"
   git push beta beta-main-sync:main
   git checkout beta-trial && git branch -D beta-main-sync
   ```
5. `git checkout main` to return to the resting branch.

Note: `beta-trial` carries a few beta-only commits `main` intentionally
never gets (5-day trial expiry gate, Welcome tab) — a straight merge would
pull those into production, so always cherry-pick the specific commit(s),
not merge the branch.

Confirm each deploy actually landed by fetching `sw.js` from the live
Pages URL and checking `CACHE_VERSION` before considering the work done
(`886ppak.github.io/myslewer/sw.js` for main,
`886ppak.github.io/myslewer-beta/sw.js` for beta).

# App version number

The `.app-version` span next to the MYSLEWER wordmark in `index.html`
(`v2.27` as of this writing) is a separate, user-facing version, distinct
from the internal `CACHE_VERSION` build string. Bump its minor number
(v2.27 -> v2.28 -> ...) on every meaningful push to `main`, same as
`CACHE_VERSION` gets bumped for every app-shell change.

Cap the minor number at .30. Once a push would take the minor number past
.30, roll over to the next major instead: v2.30 -> v3.0 -> v3.1 -> ... ->
v3.30 -> v4.0, and so on for each future major.
