# Security policy

## Scope

This project is a static site with no backend, no accounts and no user data. The
attack surface is small, and most of it is the build pipeline rather than the
running app.

In scope:

- the deployed site at `https://<owner>.github.io/<repo>/`
- the GitHub Actions workflows in `.github/workflows/`
- anything that would let a pull request, a dependency, or a build artifact
  execute code in the build or on the deployed site

Out of scope:

- **The data itself.** Bad coordinates, missing rows, an establishment that does
  not exist — those are upstream data-quality problems, not vulnerabilities.
  File them with the
  [data report template](.github/ISSUE_TEMPLATE/data_report.yml).
- Vulnerabilities in NYC Open Data, OpenFreeMap, OpenMapTiles, MapLibre, React or
  Vite. Report those upstream; we will bump the dependency.
- Missing security headers that GitHub Pages does not let you set. Report those
  to GitHub.
- The absence of a security process we do not need. There is no server to
  compromise, so most vulnerability classes do not apply.

## What a real issue here would look like

- Cross-site scripting in the app, from data rendered without escaping.
- A way to make the deployed site serve attacker-controlled content, or to
  exfiltrate or tamper with `cafes.geojson` in transit.
- A way to get code execution in the Actions workflow: an expression injection
  through a fork-controlled value interpolated into a `run:` block, a
  `pull_request_target` mistake, a workflow that executes checked-out PR code
  with elevated permissions, or a token exfiltration path.
- A data-integrity problem where the published dataset is silently altered in a
  way that misrepresents the city's records.

## Reporting a vulnerability

**Do not open a public issue.**

Use GitHub's private reporting:
**<https://github.com/qwertypants/hey-nyc/security/advisories/new>**

Please include the affected path or workflow, what an attacker could do, and how
to reproduce it. If you have a proof of concept, keep it to what is needed to
demonstrate the issue.

You can expect an acknowledgement within a few days and an assessment within two
weeks. We will tell you when a fix is in, and we will credit you in the advisory
unless you would rather we did not.

## What we have already done

These are the reasons the risk is low, and the things worth preserving if you
change the workflows:

- **The daily data workflow holds `contents: write`.** It runs on a schedule and
  on manual dispatch, not on `pull_request`, so it never runs a fork's code. It
  checks out the default branch, and the only thing it executes is
  `scripts/refresh_data.py` plus the npm scripts.
- **The site is built with `contents: read` only.** `deploy.yml` holds
  `pages: write` and `id-token: write` in the deploy job alone, and it never
  pushes to the repository.
- **No `pull_request_target`.** Nothing in `.github/workflows/` runs fork code
  with a privileged token.
- **The data commit is pinned to the artifacts it validated.** `deploy.yml`
  builds `github.event.workflow_run.head_sha` on a `workflow_run` event, so a
  data-only commit is deployed exactly as it was validated.
- **The refresh workflow never force-pushes.** A rejected push gets one rebase
  and retry, then fails.
- **Dependencies are locked.** `npm ci`, not `npm install`, in every workflow, so
  a build cannot pick up a new version of anything.

## Hard rules for changing the workflows

1. **Never interpolate anything from a fork into a `run:` block.** `${{ }}` in a
   shell script is an injection vector. Pass it through `env:` and read the
   environment variable instead. Every workflow in this repository does this;
   keep it that way.
2. **Never add `pull_request_target`, or run `npm ci` / `npm test` /
   `npm run build` on a fork's code with a write token.** If a check genuinely
   needs that, it needs a design discussion first.
3. **Never hard-code a secret.** There are none today, and the project is built
   so that there do not need to be. If you need one, that is a signal that
   something has gone wrong with the design.
4. **Do not add a third-party service that requires a key.** It would make the
   project unforkable by a stranger and put a credential in the repository.
5. **Do not weaken `validate_data.py`.** It is a data-integrity control, not just
   a test. A change that makes it pass more is a change that needs explaining.
