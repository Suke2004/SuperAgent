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

import { useCallback, useEffect, useRef } from 'react';
import { View } from 'react-native';
import { WebView } from 'react-native-webview';

import { deliverSandboxMessage, registerSandbox, SANDBOX_HTML } from '@/chat/sandbox';

export function CodeSandbox() {
  const view = useRef<WebView | null>(null);
  /** Whether the runner document itself has been handed over yet. */
  const started = useRef(false);

  const post = useCallback((message: string) => {
    // `injectJavaScript` rather than `postMessage`: it is the one direction that works
    // the same on both platforms, and the payload is JSON built by the sandbox module,
    // so there is nothing to escape beyond the quotes JSON already handles.
    view.current?.injectJavaScript(
      `window.dispatchEvent(new MessageEvent('message', { data: ${JSON.stringify(message)} })); true;`,
    );
  }, []);

  useEffect(() => {
    registerSandbox(post);
    return () => registerSandbox(null);
  }, [post]);

  return (
    <View style={{ width: 0, height: 0, overflow: 'hidden' }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <WebView
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
        style={{ width: 0, height: 0 }}
      />
    </View>
  );
}
