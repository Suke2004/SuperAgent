import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import Pdf from 'react-native-pdf';

import { Note, Spinner } from '@/components/ui';

export function PdfPreview({ uri }: { uri: string }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  if (error) {
    return <Note tone="warning" live>{`${error} Use Share or Open with another app to view this PDF.`}</Note>;
  }
  return (
    <View style={styles.container}>
      <Pdf
        source={{ uri, cache: false }}
        style={styles.pdf}
        trustAllCerts={false}
        onLoadComplete={() => setLoading(false)}
        onError={(value) => { setLoading(false); setError(value instanceof Error ? value.message : 'The PDF viewer could not open this file.'); }}
      />
      {loading ? <View style={styles.loading}><Spinner label="Opening PDF" /></View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { height: 520, width: '100%', overflow: 'hidden' },
  pdf: { flex: 1, width: '100%' },
  loading: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
});
