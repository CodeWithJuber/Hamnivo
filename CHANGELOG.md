# Changelog

Notable changes to Hamnivo. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Hamnivo is released from `main`; the npm packages (`@hamnivo/react`, `@hamnivo/vue`) have their own
versions and tags (`react-v*`, `vue-v*`).

## [Unreleased]

### Changed

- Hamnivo is open source. The repository is public, under the GNU Affero General Public License
  v3.0 (AGPL-3.0-only). The SDKs, the widget loader, the plugins and integrations, and the examples
  keep a permissive licence (MIT, or Apache 2.0 for the Google Tag Manager template), because other
  people's software embeds them. `NOTICE` lists them, and `REUSE.toml` records the licence of every
  file.
- CI runs on GitHub-hosted runners. Every pull request is checked before it merges, lint and the
  browser suites are back, and the npm packages are published with trusted publishing and
  provenance instead of a stored token (ADR 0021).

### Added

- Contributor guide, Code of Conduct (Contributor Covenant 2.1), security policy with private
  vulnerability reporting, and a contributor licence agreement that every contributor signs once.
- Security checks: dependency review on pull requests, secret scanning of the whole history with
  gitleaks, `reuse lint`, and OpenSSF Scorecard.
