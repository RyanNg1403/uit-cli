# UIT Runtime

Shared runtime used by UIT Studio. Install `uit-studio` for the Studio
application; this package is published separately so CLI-only installs do not
determine the Studio dependency graph. Its installation provisions the pinned
Playwright Chromium revision used for UIT SSO, so users do not need to install
Chrome, Edge, or Chromium themselves.

The runtime requires [Node.js 24.0+](https://nodejs.org/).
