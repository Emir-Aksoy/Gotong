# @gotong/service-artifact-file

First-party Gotong plugin: file-backed `artifact` service.
Implements [`ArtifactHandle`](../services-sdk/src/types/artifact.ts) —
agents `write` / `read` / `list` / `exists` / `remove` typed files
in per-owner directories with path-traversal protection.

## Layout

```
<rootDir>/
├─ agent/<agentId>/          ← user-named files live here
│  ├─ q1-report.md
│  ├─ subdir/notes.json
│  └─ ...
├─ workflow-run/<runId>/
├─ shared/<groupId>/
└─ .trash/<refId>/
   ├─ meta.json
   └─ payload/              ← original owner dir, moved
```

## Config

```yaml
uses:
  - type: artifact
    impl: file
    config:
      name: diagnosis-reports        # admin UI label; default 'default'
      maxBytesPerFile: 10485760      # default: 10 MB
      allowedMimePrefixes:           # default: ['text/', 'application/']
        - text/
        - application/json
```

`['*']` allows any mime. Otherwise each write's mime (either
`opts.mime` or extension guess) must match a prefix.

## Path safety

`sanitisePath()` rejects:
- absolute paths (`/foo`)
- null bytes
- `..` segments that escape upward
- empty / whitespace-only

Then `resolveOwnerPath()` re-validates that the resolved path stays
inside the owner dir. Two-step check — defence in depth.

## `ref` ↔ path

For the file backend, `ref` is just the sanitised relative path.
Agents may treat it as opaque. `read` / `exists` / `remove` accept
either form interchangeably.

## Status

**PR-4 of 13.** Internal v0.1.
