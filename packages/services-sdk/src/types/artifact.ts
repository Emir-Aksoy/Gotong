/**
 * `artifact` service type — typed file storage owned by an agent or
 * a workflow run.
 *
 * The intended use is "agent writes a markdown report, downstream
 * step references it by ref." Agents pick the relative path; the
 * plugin enforces that paths stay inside the owner's directory
 * (no `..` traversal).
 *
 * `ref` is a stable opaque token returned by `write`. Agents pass
 * `ref` to downstream steps (or to `read`/`exists`/`remove`) without
 * caring about the underlying file system layout. The file backend
 * happens to use `<ownerKey>/<userPath>` as ref, but agents must not
 * rely on this — a Notion-as-artifact plugin would use page ids.
 */

export interface ArtifactRef {
  /** Opaque-but-stable id usable in `$stepId.artifact` references. */
  readonly ref: string
  /** Path the caller asked for, relative to the owner's root. */
  readonly path: string
  /** Byte size of the stored content. */
  readonly size: number
  /** Epoch ms of last write. */
  readonly ts: number
  /** Best-guess MIME, e.g. `text/markdown`, `application/json`. */
  readonly mime: string
}

export interface ArtifactHandle {
  /**
   * Write content under `path` (relative to owner root). Overwrites
   * existing content at the same path. Returns a fresh ref.
   *
   * Plugins:
   *   - MUST reject paths containing `..` segments or starting with `/`
   *   - SHOULD auto-create intermediate directories
   *   - MAY guess mime from extension if `opts.mime` is omitted
   */
  write(path: string, content: string | Uint8Array, opts?: { mime?: string }): Promise<ArtifactRef>

  /**
   * Read content by ref or by relative path. Throws if not found.
   * Returned `content` is utf-8 text; binary callers should use
   * `readBytes` instead.
   */
  read(refOrPath: string): Promise<{ content: string; mime: string }>

  /**
   * Read content as raw bytes by ref or relative path. Throws if not
   * found. Use this for any non-text artifact (images / audio /
   * binary files) — the utf-8 decode in `read()` would corrupt
   * binary payloads.
   *
   * Phase 9 introduced this for multimodal LLM input: provider
   * translators resolve `LlmImageBlock` / `LlmFileRefBlock` blocks
   * with `source.kind === 'artifact_ref'` by calling `readBytes` to
   * get the raw bytes, then shaping into vendor base64 / multipart
   * form.
   *
   * For text artifacts, this returns the utf-8 encoded bytes — the
   * caller decodes if it needs a string (typical case is the caller
   * already knows the mime is binary, so this never matters).
   */
  readBytes(refOrPath: string): Promise<{ bytes: Uint8Array; mime: string }>

  /**
   * List all artifacts owned by this handle. `prefix` filters by
   * the user-supplied path prefix (not the ref id).
   */
  list(opts?: { prefix?: string }): Promise<ArtifactRef[]>

  /** True iff an artifact exists at this ref or path. */
  exists(refOrPath: string): Promise<boolean>

  /** Remove one artifact. No-op if not found. */
  remove(refOrPath: string): Promise<void>
}
