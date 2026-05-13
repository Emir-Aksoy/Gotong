# Recording the AipeHub demo

The 30–60 second GIF on the project README is generated from
[`scripts/demo-60s.sh`](demo-60s.sh) via [asciinema](https://asciinema.org)
+ [`agg`](https://github.com/asciinema/agg). This doc captures the
recipe so re-recording (for a new release, a new color theme, a new
demo flow) is a one-command operation.

## One-time setup

```bash
brew install asciinema agg jq            # macOS
# or:
pipx install asciinema && cargo install --git https://github.com/asciinema/agg
```

## Record

```bash
# from the repo root, with the workspace already built:
pnpm install && pnpm build

# 1. record (Ctrl-D or `exit` to stop, but the script auto-exits)
asciinema rec docs/assets/demo.cast \
  --cols 100 --rows 28 \
  --command './scripts/demo-60s.sh' \
  --idle-time-limit 0.5

# 2. convert to GIF (250×… proportional, theme: solarized-dark)
agg --theme solarized-dark \
    --font-family 'JetBrains Mono, SF Mono, Menlo, monospace' \
    --speed 1.0 \
    docs/assets/demo.cast docs/assets/demo.gif

# 3. (optional) also produce an animated SVG — sharper, smaller for repo
agg --theme solarized-dark \
    --format svg \
    docs/assets/demo.cast docs/assets/demo.svg
```

## Embed in README

After committing the new `docs/assets/demo.{cast,gif,svg}`, link from the
project README:

```markdown
<p align="center">
  <img src="docs/assets/demo.gif" alt="AipeHub 60-second demo" width="780">
</p>
```

`asciinema` `.cast` files also work standalone — you can drop them into
asciinema.org for an embeddable player. The `.cast` itself is small
(usually < 50 KB) so check it in alongside the GIF.

## Conventions

- **Window size**: `100×28` keeps the GIF readable on a phone without
  overflowing the desktop README width.
- **Idle time limit `0.5`**: pauses get capped so the GIF feels brisk.
- **No fake typing**: the demo script runs autonomously; please don't
  add `tmpsleep`-driven fake typing on top — it makes the GIF longer
  without information gain.

## Sanity check before recording

```bash
# Make sure the script works in plain shell first
./scripts/demo-60s.sh
# Look for: ✓ Done. line at the end.

# Make sure ports are free
lsof -i :3399 -i :4399 || echo "free"
```

## Trouble?

- **`jq: command not found`** — install jq. The script depends on it
  for pretty JSON output.
- **`EADDRINUSE`** — port 3399 or 4399 is taken. Find what's holding
  it with `lsof -i :3399`.
- **Tiny GIF / no animation** — recording was probably under 1s.
  Bump `sleep` calls inside `demo-60s.sh`.
- **Huge GIF (>10 MB)** — drop the resolution: `agg --width 800 …`
  or convert via `gifsicle -O3 input.gif -o output.gif`.
