# pi-sidechat

Pi extension that renders `<msg>...</msg>` assistant messages in a tmux side panel.

## Install

```bash
pi install git:github.com/dantetekanem/pi-sidechat
```

To run from a local checkout:

```bash
pi -e .
```

## Requirements

- tmux
- perl

## Protocol

| Output | Rendered in |
|--------|-------------|
| `<msg>...</msg>` | Side panel |
| Everything else | Main transcript |

When Sidechat is hidden or disabled, `<msg>` tags are stripped and their content stays in the main transcript.

## Todo pane

The built-in `todo` tool renders a visible execution plan in the side panel.

- Use `todo create_many` for substantial multi-step work.
- Keep exactly one task `in_progress`.
- Complete each task immediately when that work is done.
- Skip todo for simple answers, one-off checks, and reports.

## Shortcut

| Shortcut | Action |
|----------|--------|
| `Alt+Tab` | Show/hide Sidechat |

## Commands

| Command | Action |
|---------|--------|
| `/sidechat` | Toggle Sidechat |
| `/sidechat settings` | Show settings |
| `/sidechat log` | Show log tail |

## Tools

| Tool | Action |
|------|--------|
| `sidechat_control` | `status`, `enable`, `disable` |
| `sidechat_notify` | Rare important spawned-agent notification |
| `todo` | Visible side-panel task list |

## Settings

```json
{
  "name": "Sidechat",
  "typewriter": {
    "enabled": true
  },
  "panelWidth": 25
}
```

## License

MIT
