/**
 * The code sandbox's browser.
 *
 * A zero-sized WebView that exists only so `run_code` has a JavaScript engine. All of
 * the reasoning — why this is not a shell, what the policy refuses, the wire format —
 * is in `@/chat/sandbox`; this file is the mount, the channel and the refusals a policy
 * cannot express.
 *
 * Mounted once by the chat screen rather than per message: the engine is stateless
 * between runs, and one hidden browser is enough.
 *
 * It is `width: 0, height: 0` rather than `display: none` because a WebView that has
 * never been laid out does not always load its document, and a runner that has not
 * loaded answers nothing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';

import { deliverSandboxMessage, registerSandbox, SANDBOX_HTML } from '@/chat/sandbox';
import { log } from '@/lib/log';

export function CodeSandbox() {
  const view = useRef<WebView | null>(null);
  /** Whether the runner document itself has been handed over yet. */
  const started = useRef(false);
  /**
   * Bumped to throw the engine away.
   *
   * A program that loops forever cannot be interrupted from inside the WebView, so the
   * only way back is a new one. `key` on the WebView means React unmounts the wedged
   * renderer rather than asking it — politely, over a channel it is too busy to read —
   * to reload. Left as the last resort it is: a renderer that dies unasked (Android
   * kills it when it pins a core or runs out of memory, and that used to take the whole
   * app with it) comes back the same way.
   */
  const [generation, setGeneration] = useState(0);

  const reload = useCallback(() => {
    started.current = false;
    setGeneration((n) => n + 1);
  }, []);

  const post = useCallback((message: string) => {
    // `injectJavaScript` rather than `postMessage`: it is the one direction that works
    // the same on both platforms, and the payload is JSON built by the sandbox module,
    // so there is nothing to escape beyond the quotes JSON already handles.
    view.current?.injectJavaScript(
      `window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(message)} })); true;`,
    );
  }, []);

  useEffect(() => {
    registerSandbox(post, reload);
    return () => registerSandbox(null);
  }, [post, reload]);

  return (
    <View style={{ width: 0, height: 0, overflow: 'hidden' }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <WebView
        key={generation}
        ref={view}
        source={{ html: SANDBOX_HTML }}
        originWhitelist={[]}
        javaScriptEnabled
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        domStorageEnabled={false}
        thirdPartyCookiesEnabled={false}
        sharedCookiesEnabled={false}
        incognito
        setSupportMultipleWindows={false}
        // The document is the only thing this view ever loads. The first request is that
        // document; model-written code that sets `location` is trying to leave the
        // sandbox, and it does not get to.
        onShouldStartLoadWithRequest={() => {
          if (started.current) return false;
          started.current = true;
          return true;
        }}
        onMessage={(event) => deliverSandboxMessage(event.nativeEvent.data)}
        // Android. Returning true says "I have handled it" — without that the crash
        // propagates and the process goes down, which is the app disappearing a few
        // seconds after a run_code call that looped.
        onRenderProcessGone={(event) => {
          log.warn('sandbox', `The sandbox renderer died (crashed: ${String(event.nativeEvent.didCrash)}).`);
          reload();
          return true;
        }}
        // iOS's equivalent. Same answer: replace it.
        onContentProcessDidTerminate={() => {
          log.warn('sandbox', 'The sandbox content process was terminated.');
          reload();
        }}
        style={{ width: 0, height: 0 }}
      />
    </View>
  );
}
