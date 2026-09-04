/**
 * A generated file, read on the device that wrote it.
 *
 * The files list used to offer Share and Delete, which meant the only way to find out
 * what was in a file this app produced was to send it to another app and hope something
 * there could open it. This sheet is the missing middle: the text, editable where an
 * edit can honestly be saved, rendered where rendering is what the file is for.
 *
 * What can be shown, and whether Save may appear at all, is decided by
 * {@link previewFor} — a pure module, tested, from the filename alone and *before* the
 * file is opened, so a 30 MB PDF is never read into memory to discover that nothing
 * here can display it.
 *
 * ## Why an Office file has no Save button
 *
 * `extractOffice` returns the *words*: no styles, no table structure, no slide
 * boundaries. Saving that text back would replace a real `.docx` with a flattened
 * transcript of itself — data loss dressed as a feature. So Office is read-only and
 * says so, in the sheet, where the user is deciding whether to trust it.
 *
 * ## Why the body is a separate component
 *
 * The same reason as {@link ReferenceSheet}: the shell keeps its panel mounted for one
 * exit animation, so mounting the body only while open is what resets the draft. A
 * sheet reopened on a different file must not show the last file's text for a frame.
 */

import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';

import { extractOffice, officeKind } from '@/chat/office';
import { artifactKindForFile } from '@/chat/artifact';
import { readGeneratedBytes, readGeneratedText, writeGeneratedText } from '@/chat/files';
import type { GeneratedFile } from '@/chat/files';
import { previewFor } from '@/chat/preview';
import { ArtifactPreview } from '@/components/ArtifactPreview';
import { PdfPreview } from '@/components/chat/PdfPreview';
import { useDialogKeys } from '@/components/dialog';
import { SheetShell } from '@/components/Sheet';
import { Body, Button, Divider, Field, Inline, Note, Spinner, useKeyboardHeight } from '@/components/ui';
import * as haptics from '@/lib/haptics';
import { useTheme } from '@/theme';

/**
 * Characters shown, and the most an edit may be saved from.
 *
 * A generated file is something the model wrote to be read, so this is generous enough
 * to hold any of them whole. It is a ceiling on the *view*, not on the file: a longer
 * one is shown truncated and read-only, because a Save from a truncated buffer would
 * delete everything past the cut.
 *
 * ponytail: whole file in one TextInput, paginate if these ever get large.
 */
const MAX_SHOWN = 200_000;

export function FilePreview({
  file,
  onClose,
  onSaved,
}: {
  /** The file to show, or null when closed. */
  file: GeneratedFile | null;
  onClose: () => void;
  /** Called after a successful save, so the caller can refresh its sizes. */
  onSaved: () => void;
}) {
  // An editable file puts a keyboard over the bottom of the screen, and the panel has to
  // stop above it rather than merely scrolling its contents — as `ReferenceSheet` does.
  const keyboardHeight = useKeyboardHeight();

  return (
    <SheetShell visible={file !== null} onClose={onClose} label="Close the preview" lift={keyboardHeight}>
      {file ? <PreviewBody file={file} onClose={onClose} onSaved={onSaved} /> : null}
    </SheetShell>
  );
}

/** What the read produced: the text, or why there is none. */
type Loaded = { text: string; truncated: boolean } | { error: string };

async function read(file: GeneratedFile): Promise<Loaded> {
  try {
    const kind = officeKind(undefined, file.name);
    const raw = kind ? extractOffice(await readGeneratedBytes(file.uri), kind) : await readGeneratedText(file.uri);
    if (!raw.trim()) {
      return {
        error: kind
          ? 'There is no text in this file — it may be a deck of images, or an empty document.'
          : 'This file is empty.',
      };
    }
    return { text: raw.slice(0, MAX_SHOWN), truncated: raw.length > MAX_SHOWN };
  } catch (error) {
    return { error: error instanceof Error ? error.message : 'The file could not be read.' };
  }
}

function PreviewBody({
  file,
  onClose,
  onSaved,
}: {
  file: GeneratedFile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTheme();
  const trap = useDialogKeys(true, onClose);

  const preview = previewFor(file.name);
  /**
   * Whether opening the file is worth doing at all.
   *
   * `handoff` is the mode for a file nothing here can display — a PDF, a zip. Reading one
   * as text would fill the sheet with mojibake and call it a preview, so it is not read:
   * the note says what it is, and Share is the action.
   */
  const readable = preview.mode !== 'handoff';
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  /** The buffer being edited. Separate from `loaded`, which stays as the saved text. */
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);

  useEffect(() => {
    if (!readable) return;
    let cancelled = false;
    void read(file).then((result) => {
      if (cancelled) return;
      setLoaded(result);
      if ('text' in result) setDraft(result.text);
    });
    return () => {
      cancelled = true;
    };
  }, [file, readable]);

  const saved = loaded && 'text' in loaded ? loaded.text : '';
  // A truncated view can be read but not written back: saving would drop the tail.
  const truncated = Boolean(loaded && 'text' in loaded && loaded.truncated);
  const editable = preview.editable && !truncated;
  const dirty = editable && draft !== saved;
  const artifact = artifactKindForFile(file.name);
  const isPdf = file.name.toLowerCase().endsWith('.pdf');
  const status = !readable
    ? 'Cannot be shown here'
    : truncated
      ? `Read-only — the first ${MAX_SHOWN.toLocaleString()} characters`
      : preview.mode === 'office'
        ? 'Read-only text'
        : editable
          ? 'Editable'
          : 'Preview';

  const save = () => {
    setSaving(true);
    setFailed(null);
    void writeGeneratedText(file.uri, draft)
      .then(() => {
        haptics.confirm();
        setLoaded({ text: draft, truncated: false });
        setSaving(false);
        onSaved();
      })
      .catch((error: unknown) => {
        setSaving(false);
        setFailed(error instanceof Error ? error.message : 'The file could not be written.');
      });
  };

  return (
    <View ref={trap} style={{ paddingBottom: t.spacing.xl }}>
      <View style={{ paddingHorizontal: t.spacing.md, gap: 2 }}>
        <Body weight="700" numberOfLines={1}>
          {file.name}
        </Body>
        <Body size="xs" tone="faint">
          {status}
        </Body>
      </View>
      <Divider />

      <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: 420 }}>
        <View style={{ padding: t.spacing.md, gap: t.spacing.sm }}>
          {preview.note ? <Note tone="info">{preview.note}</Note> : null}
          {truncated ? (
            <Note tone="warning">
              This file is longer than the preview holds, so it is shown read-only — saving from here would delete
              everything past the cut. Share it to open the whole file elsewhere.
            </Note>
          ) : null}
          {failed ? (
            <Note tone="danger" live>
              {failed}
            </Note>
          ) : null}

          {isPdf ? <PdfPreview uri={file.uri} /> : !readable ? null : loaded === null ? (
            <View style={{ paddingVertical: t.spacing.lg }}>
              <Spinner label="Reading the file" />
            </View>
          ) : 'error' in loaded ? (
            <Note tone="warning" live>
              {loaded.error}
            </Note>
          ) : editable ? (
            <Field
              label="Contents"
              value={draft}
              onChangeText={setDraft}
              mono
              rows={12}
              autoCapitalize="sentences"
              hint="Saving overwrites this file. Nothing is sent anywhere."
            />
          ) : (
            <Body size="sm" mono selectable>
              {loaded.text}
            </Body>
          )}
        </View>
      </ScrollView>

      <View style={{ paddingHorizontal: t.spacing.md, paddingTop: t.spacing.md, gap: t.spacing.sm }}>
        {artifact ? (
          <Button
            label={artifact === 'svg' ? 'Render this SVG' : 'Render this page'}
            variant="secondary"
            full
            disabled={loaded === null || 'error' in loaded}
            disabledReason="There is nothing to render yet."
            onPress={() => setRendering(true)}
          />
        ) : null}
        {/* `full` is not usable inside `Inline`: it sets `alignSelf: 'stretch'`, which on
            a row stretches the button *vertically*. Two buttons share the row on `flex`,
            and a lone one gets the plain full-width treatment outside it. */}
        {editable ? (
          <Inline gap="sm" wrap={false}>
            <Button
              label={saving ? 'Saving' : 'Save'}
              variant="primary"
              busy={saving}
              disabled={!dirty}
              disabledReason="Nothing has changed yet."
              onPress={save}
              style={{ flex: 1 }}
            />
            <Button label="Done" variant="ghost" onPress={onClose} style={{ flex: 1 }} />
          </Inline>
        ) : (
          <Button label="Done" variant="secondary" full onPress={onClose} />
        )}
      </View>

      {/* The same hardened WebView the transcript's code blocks use, handed the file's
          own text instead of a fence's. Its sandbox is the reason this is safe at all —
          see `@/chat/artifact` for what the policy refuses. */}
      {artifact ? (
        <ArtifactPreview
          visible={rendering}
          code={loaded && 'text' in loaded ? draft : ''}
          kind={artifact}
          onClose={() => setRendering(false)}
        />
      ) : null}
    </View>
  );
}
