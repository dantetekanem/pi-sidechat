# Changelog

## Unreleased

### Added

- Optional Friday-style ack messages via the `acks.enabled` and `acks.delayMs` settings.

### Fixed

- Preserve non-streamed assistant messages while Sidechat suppresses visible streaming, preventing spawned-agent replies from disappearing.
- Keep panel-only routed messages in the main transcript when routing would otherwise leave a blank assistant response.

## 1.0.0 - 2026-06-16

### Added

- Initial `pi-sidechat` release.
- Side-panel routing protocol using `<msg>...</msg>` tags.
- Main transcript preservation for everything outside `<msg>` tags, including code blocks, markdown, tables, diffs, command output, images, and reference material.
- Automatic `<msg>` tag stripping when Sidechat is hidden, disabled, or unavailable, preserving tag contents in the main transcript.
- Sidechat control tool: `sidechat_control` with `status`, `enable`, and `disable` actions.
- `/sidechat`, `/sidechat settings`, and `/sidechat log` commands.
- `Alt+Tab` panel show/hide shortcut.
- Built-in todo side pane and `todo` tool for visible multi-step execution plans.
- Spawned-agent notification tool: `sidechat_notify` for rare important teammate updates.

### Changed

- Renamed package from `pi-friday` to `pi-sidechat`.
- Renamed user-facing commands, tool names, runtime paths, and docs from Friday to Sidechat.
- Removed prompt-driven `communicate` tool routing in favor of automatic `<msg>` filtering.

### Removed

- Removed the old `communicate` tool and communications prompt.
- Removed voice, wake-word, talk, and listen modules.
- Removed Piper, Sox, OpenWakeWord, Whisper, and PyAudio documentation and runtime checks.
