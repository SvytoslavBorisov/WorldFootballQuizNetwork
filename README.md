# WorldFootballQuizNetwork

Public, independently published Match of the Week content for World Football. Source/generator: SvytoslavBorisov/WorldFootballQuiz2026 (private).

The app checks `content/src-assets/data/current-matchday.json`; unchanged hash/file skips the quiz download. Changed payloads are verified using SHA-256 and byte size before use. Developer-written `summary.ru` / `summary.en` supplies the menu subtitle; it is never generated from an invented kickoff date. Older immutable payloads are retained.

Validate with `node scripts/validate-content.mjs --validate .`. The initial publication preserves the app's current quiz; a new preview is entered by the developer on the next workflow run. No production match is automatically replaced during setup.
