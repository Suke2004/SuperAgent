/**
 * Built-in tools.
 *
 * The three switches that decide what the app's own tools may do, on their own screen
 * rather than in the middle of the settings hub. That move is the point: a conversation
 * needs somewhere to send you when you ask "can it run code?", and the answer has to be
 * *one* place. The alternative — a copy of these switches in the conversation menu —
 * would be two controls over one piece of state, free to disagree in wording if not in
 * value.
 *
 * Writing tools have no switch and are not missing one. `write_file`, `create_pdf` and
 * `create_document` only ever touch this app's own document directory, where the result
 * is visible and deletable; a document tool nobody had to enable is the difference
 * between the feature existing and the feature being found. The three here are the ones
 * that reach the network or execute text the user did not write.
 */

import { Body, Note, Screen, Section, SwitchRow } from '@/components/ui';
import { summariseTools } from '@/chat/builtins';
import { useSettings } from '@/stores/settings';

export default function BuiltinToolsScreen() {
  const settings = useSettings();

  return (
    <Screen>
      <Note tone="info">
        Writing a file, rendering a PDF and writing a Word, Excel or PowerPoint document are always available and have
        no switch: they only touch this app’s own storage, the result is listed in the reply, and nothing leaves until
        you save a copy.
      </Note>

      <Section
        title="Off until you say otherwise"
        note={
          'Each of these does something the app cannot take back for you: two make requests on your network at the ' +
          'direction of text the model just read, and one executes what the model wrote. Local and private network ' +
          'addresses are refused either way.'
        }
      >
        <SwitchRow
          first
          icon="external"
          label="Let the model fetch web pages"
          subtitle="One GET at a time, text only, no cookies and no credentials"
          value={settings.allowWebFetch}
          onChange={(next) => settings.set('allowWebFetch', next)}
        />
        <SwitchRow
          icon="search"
          label="Let the model search the web"
          subtitle="Anthropic profiles only · billed per search, and the results enter the context window"
          value={settings.allowWebSearch}
          onChange={(next) => settings.set('allowWebSearch', next)}
        />
        <SwitchRow
          icon="tools"
          label="Let the model run code"
          subtitle="JavaScript in a sandbox with no network, no storage and no access to this app. For arithmetic and parsing it would otherwise guess at."
          value={settings.allowRunCode}
          onChange={(next) => settings.set('allowRunCode', next)}
        />
      </Section>

      <Body tone="dim" size="sm">
        On for every conversation:{' '}
        {summariseTools({
          web: settings.allowWebFetch,
          search: settings.allowWebSearch,
          code: settings.allowRunCode,
          serverTools: 0,
          servers: 0,
          skills: 0,
          plan: false,
        })}
        . Servers and skills are chosen per conversation instead, from its own menu — and plan mode, also per
        conversation, refuses the writing tools and every server tool until you turn it off.
      </Body>
    </Screen>
  );
}
