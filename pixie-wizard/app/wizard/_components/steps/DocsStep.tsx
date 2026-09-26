"use client";

import { useRef, useState } from "react";
import {
  OnbIconCheckCircle,
  OnbIconDropFile,
  OnbIconLayers,
  OnbIconSparkle,
  sourceKindIcon,
} from "@/app/wizard/_components/OnboardingIcons";
import {
  MAX_SOURCES,
  MAX_TOTAL_CONTENT,
  MAX_UPLOAD_BYTES,
  MAX_UPLOAD_FILES,
  RECOMMENDED_SOURCES,
  SOURCE_KINDS,
  knowledgeScore,
  markdownOutline,
  newSourceId,
  sourceUrlIssue,
  type DraftSource,
  type SourceKind,
} from "@/lib/onboardingDraft";
import type { StepProps } from "./stepTypes";
import "../docs.css";

const TOTAL_KB = Math.round(MAX_TOTAL_CONTENT / 1000);

const STATUS_TEXT: Record<DraftSource["status"], string> = {
  ready: "Ready",
  processing: "Processing",
  fetching: "Reading…",
  pending: "Pending",
  error: "Error",
};

function statusText(source: DraftSource): string {
  if (source.status === "pending") return source.content ? "Pending" : "Pending — read at launch";
  return STATUS_TEXT[source.status];
}

function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : "";
  } catch {
    return "";
  }
}

function labelFromUrl(kind: SourceKind, url: string): string {
  const rule = SOURCE_KINDS[kind];
  try {
    const parts = new URL(url.trim()).pathname.split("/").filter(Boolean);
    let tail = parts[parts.length - 1] ?? "";
    if (kind === "gdoc") {
      const at = parts.indexOf("d");
      if (at >= 0 && parts[at + 1]) tail = parts[at + 1];
    }
    const cleaned = decodeURIComponent(tail).replace(/\.(md|txt)$/i, "").replace(/[-_+]+/g, " ").trim();
    if (!cleaned || cleaned.length > 48) return rule.label;
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  } catch {
    return rule.label;
  }
}

function bulletsFor(source: DraftSource): string[] {
  if (source.outline.length) return source.outline;
  const host = hostOf(source.url);
  return host ? [host] : [];
}

export function DocsStep({ draft, update }: StepProps) {
  const [kind, setKind] = useState<SourceKind | null>(null);
  const [url, setUrl] = useState("");
  const [urlIssue, setUrlIssue] = useState<string | null>(null);
  const [fileIssue, setFileIssue] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const score = knowledgeScore(draft.sources);
  const uploads = draft.sources.filter((source) => source.kind === "markdown").length;
  const room = MAX_SOURCES - draft.sources.length;

  const addLink = () => {
    if (!kind) return;
    if (room <= 0) {
      setUrlIssue(`You can add ${MAX_SOURCES} sources.`);
      return;
    }
    const issue = sourceUrlIssue(kind, url);
    if (issue) {
      setUrlIssue(issue);
      return;
    }
    const source: DraftSource = {
      id: newSourceId(),
      kind,
      label: labelFromUrl(kind, url),
      url: url.trim(),
      status: "pending",
      outline: [],
    };
    update((d) => ({ ...d, sources: [...d.sources, source] }));
    setUrl("");
    setUrlIssue(null);
  };

  const readFiles = (files: FileList) => {
    setFileIssue(null);
    const picked = Array.from(files);
    if (!picked.length) return;
    if (picked.some((file) => !/\.(md|txt)$/i.test(file.name))) {
      setFileIssue("Upload Markdown or plain-text files.");
      return;
    }
    if (picked.some((file) => file.size > MAX_UPLOAD_BYTES)) {
      setFileIssue(`Each file must be under ${Math.round(MAX_UPLOAD_BYTES / 1000)} KB.`);
      return;
    }
    if (picked.length > MAX_UPLOAD_FILES) {
      setFileIssue(`Pick up to ${MAX_UPLOAD_FILES} files at a time.`);
      return;
    }
    if (room <= 0) {
      setFileIssue(`You can add ${MAX_SOURCES} sources.`);
      return;
    }
    const used = draft.sources.reduce((total, source) => total + (source.content?.length ?? 0), 0);
    if (used >= MAX_TOTAL_CONTENT) {
      setFileIssue(`Uploaded files are over ${TOTAL_KB} KB combined.`);
      return;
    }
    const batch = picked.slice(0, room);
    const slots = batch.map((file) => ({ id: newSourceId(), file }));
    update((d) => ({
      ...d,
      sources: [
        ...d.sources,
        ...slots.map((slot): DraftSource => ({
          id: slot.id,
          kind: "markdown",
          label: slot.file.name,
          status: "processing",
          outline: [],
        })),
      ],
    }));
    const budget = MAX_TOTAL_CONTENT - used;
    slots.forEach(({ id, file }) => {
      void (async () => {
        let failure: string | null = null;
        let content = "";
        let outline: string[] = [];
        try {
          content = await file.text();
          if (content.length > budget) throw new Error(`That file is over the ${TOTAL_KB} KB total.`);
          if (!content.trim()) throw new Error("That file is empty.");
          outline = markdownOutline(content);
        } catch (err) {
          failure = err instanceof Error ? err.message : "That file could not be read.";
        }
        update((d) => ({
          ...d,
          sources: d.sources.map((source) =>
            source.id === id
              ? failure
                ? { ...source, status: "error", error: failure }
                : { ...source, content, outline, status: "pending" }
              : source,
          ),
        }));
      })();
    });
  };

  const remove = (id: string) => {
    update((d) => ({ ...d, sources: d.sources.filter((source) => source.id !== id) }));
  };

  const qualityNote = score.count === 0
    ? "Add at least one source so Pixie has something to read."
    : score.count < score.target
      ? `Add at least ${RECOMMENDED_SOURCES} key resources for the best results.`
      : "That's a full set. You can swap sources any time.";

  return (
    <div className="onboarding-step-section" data-step-panel={2}>
      <div className="onboarding-docs-grid">
        <div>
          <div className="onboarding-step-copy" aria-live="polite">
            <p className="onboarding-step-eyebrow">STEP 3 OF 5</p>
            <h1 className="onboarding-title">Add your docs</h1>
            <p className="onboarding-lede">
              Give Pixie access to the resources your community relies on. It&apos;ll read, understand, and keep them in sync.
            </p>
          </div>
          <label
            className="onboarding-dropzone"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => {
              event.preventDefault();
              readFiles(event.dataTransfer.files);
            }}
          >
            <input
              ref={fileInput}
              className="onboarding-hidden-input"
              type="file"
              multiple
              accept=".md,.txt"
              onChange={(event) => {
                if (event.target.files) readFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <span className="onboarding-drop-icon" aria-hidden="true">
              <OnbIconDropFile size={54} />
            </span>
            <span className="onboarding-drop-title">Drop files here</span>
            <span className="onboarding-drop-copy">
              or <span>choose files</span> to upload{uploads ? ` · ${uploads} uploaded` : ""}
            </span>
          </label>
          {fileIssue ? <p className="onboarding-error" role="alert">{fileIssue}</p> : null}
          <div className="onboarding-source-grid" aria-label="Documentation sources">
            {(Object.keys(SOURCE_KINDS) as SourceKind[]).map((option) => {
              const rule = SOURCE_KINDS[option];
              return (
                <button
                  className="onboarding-source-card"
                  data-selected={kind === option}
                  type="button"
                  key={option}
                  onClick={() => {
                    if (option === "markdown") {
                      fileInput.current?.click();
                      return;
                    }
                    setUrlIssue(null);
                    setKind((current) => (current === option ? null : option));
                  }}
                >
                  <span className="onboarding-source-mark" data-kind={option} aria-hidden="true">
                    {sourceKindIcon(option, "row")}
                  </span>
                  <span>
                    <span className="onboarding-source-name">{rule.label}</span>
                    <span className="onboarding-source-type">{rule.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
          {kind ? (
            <div className="onboarding-source-link">
              <label className="onboarding-field">
                <span className="onboarding-field-label">{SOURCE_KINDS[kind].label} link</span>
                <input
                  className="onboarding-input"
                  type="url"
                  value={url}
                  placeholder={SOURCE_KINDS[kind].placeholder}
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setUrlIssue(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addLink();
                    }
                  }}
                />
              </label>
              <button className="onboarding-button onboarding-button-quiet" type="button" onClick={addLink}>
                Add
              </button>
            </div>
          ) : null}
          {urlIssue ? <p className="onboarding-error" role="alert">{urlIssue}</p> : null}
          <div className="onboarding-quality">
            <span className="onboarding-quality-mark" aria-hidden="true">
              <OnbIconLayers size={34} />
            </span>
            <div className="onboarding-quality-copy">
              <div className="onboarding-quality-title">Knowledge quality</div>
              <div className="onboarding-quality-note">{qualityNote}</div>
            </div>
            <div className="onboarding-quality-meter">
              <div className="onboarding-quality-bars" aria-hidden="true">
                {Array.from({ length: score.target }, (_, bar) => (
                  <span className="onboarding-quality-bar" data-filled={bar < score.count} key={bar} />
                ))}
              </div>
              <span className="onboarding-quality-count">{score.count} / {score.target}</span>
            </div>
          </div>
        </div>
        <aside className="onboarding-preview" aria-labelledby="preview-title">
          <div className="onboarding-preview-heading">
            <span className="onboarding-preview-spark" aria-hidden="true">
              <OnbIconSparkle size={34} />
            </span>
            <div>
              <h2 className="onboarding-preview-title" id="preview-title">What Pixie will know</h2>
              <p className="onboarding-preview-copy">A live preview of the knowledge Pixie will use to answer questions.</p>
            </div>
          </div>
          <div className="onboarding-preview-list">
            {draft.sources.length === 0 ? (
              <p className="onboarding-preview-empty">Nothing here yet. Add your first source.</p>
            ) : (
              draft.sources.map((source) => (
                <article className="onboarding-preview-card" key={source.id}>
                  <div className="onboarding-preview-card-head">
                    <span className="onboarding-preview-mark" data-kind={source.kind} aria-hidden="true">
                      {sourceKindIcon(source.kind, "preview")}
                    </span>
                    <div className="onboarding-preview-name">
                      {source.label}
                      <span className="onboarding-preview-type">{SOURCE_KINDS[source.kind].label}</span>
                    </div>
                    {source.status === "ready" ? (
                      <span className="onboarding-preview-check" aria-label="Ready">
                        <OnbIconCheckCircle size={20} />
                      </span>
                    ) : (
                      <span className="onboarding-preview-status" data-status={source.status}>
                        {statusText(source)}
                      </span>
                    )}
                  </div>
                  {bulletsFor(source).length ? (
                    <ul className="onboarding-preview-bullets">
                      {bulletsFor(source).map((bullet) => <li key={bullet}>{bullet}</li>)}
                    </ul>
                  ) : null}
                  {source.error ? <p className="onboarding-preview-problem">{source.error}</p> : null}
                  <button
                    className="onboarding-preview-remove"
                    type="button"
                    aria-label={`Remove ${source.label}`}
                    onClick={() => remove(source.id)}
                  >
                    Remove
                  </button>
                </article>
              ))
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
