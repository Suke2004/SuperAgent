/**
 * Usage, from this device's own records.
 *
 * Everything here is a `GROUP BY` over `usage_events`, which is written when a turn
 * finishes. Two honesty problems shape the screen:
 *
 *  - A gateway that does not report a count stores a zero, so a total is a floor and
 *    not a measurement. Said once, at the top, rather than with an asterisk per row.
 *  - Cost is arithmetic against a hand-entered price table, so a bucket where some
 *    events had no pricing is marked partial rather than quietly under-reported.
 */

import { useCallback, useState } from 'react';
import { View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';

import { Empty, Note, Row, Screen, Section, Segmented, Spinner } from '@/components/ui';
import { usageByDay, usageByModel, usageTotals } from '@/db/conversations';
import type { UsageBucket } from '@/db/conversations';
import { log } from '@/lib/log';
import { useTheme } from '@/theme';

const WINDOWS = [7, 30, 90] as const;

export default function UsageScreen() {
  const t = useTheme();
  const router = useRouter();
  const [days, setDays] = useState<'7' | '30' | '90'>('30');
  const [byDay, setByDay] = useState<UsageBucket[]>([]);
  const [byModel, setByModel] = useState<UsageBucket[]>([]);
  const [totals, setTotals] = useState<UsageBucket | null>(null);
  const [loaded, setLoaded] = useState(false);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      void (async () => {
        try {
          const [day, model, all] = await Promise.all([usageByDay(Number(days)), usageByModel(), usageTotals()]);
          if (!live) return;
          setByDay(day);
          setByModel(model);
          setTotals(all);
        } catch (error) {
          log.error('usage', 'Could not read the usage tables', error);
        } finally {
          if (live) setLoaded(true);
        }
      })();
      return () => {
        live = false;
      };
    }, [days]),
  );

  if (!loaded) {
    return (
      <Screen>
        <View style={{ padding: t.spacing.md }}>
          <Spinner label="Reading usage" />
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <Section
        title="All time"
        note={
          'Counted from what the gateway reported on each turn. A gateway that reports nothing counts as zero, so ' +
          'these are floors rather than bills — the only authoritative number is the one on your provider’s invoice.'
        }
      >
        {totals && totals.requests > 0 ? (
          <>
            <Row first label="Requests" value={totals.requests.toLocaleString()} />
            <Row label="Input tokens" value={totals.input.toLocaleString()} />
            <Row label="Output tokens" value={totals.output.toLocaleString()} />
            {totals.thinking ? <Row label="Thinking tokens" value={totals.thinking.toLocaleString()} /> : null}
            {totals.cacheRead || totals.cacheWrite ? (
              <Row
                label="Cache"
                value={`${totals.cacheRead.toLocaleString()} read · ${totals.cacheWrite.toLocaleString()} written`}
              />
            ) : null}
            <Row label="Estimated cost" value={cost(totals)} />
          </>
        ) : (
          <View style={{ padding: t.spacing.md }}>
            <Empty icon="usage" title="Nothing recorded yet" body="Send a message and this fills in." />
          </View>
        )}
      </Section>

      <Section title="By day">
        <View style={{ padding: t.spacing.md }}>
          <Segmented
            label="Window"
            value={days}
            onChange={setDays}
            options={WINDOWS.map((n) => ({ value: String(n) as '7' | '30' | '90', label: `${n} days` }))}
          />
        </View>
        {byDay.length === 0 ? (
          <View style={{ padding: t.spacing.md }}>
            <Empty title="No days with traffic" />
          </View>
        ) : (
          byDay.map((bucket, index) => (
            <Row
              key={bucket.key}
              first={index === 0}
              label={bucket.key}
              value={cost(bucket)}
              subtitle={`${bucket.requests} ${bucket.requests === 1 ? 'request' : 'requests'} · ${tokens(bucket)}`}
            />
          ))
        )}
      </Section>

      <Section title="By model">
        {byModel.length === 0 ? (
          <View style={{ padding: t.spacing.md }}>
            <Empty title="No models used yet" />
          </View>
        ) : (
          byModel.map((bucket, index) => (
            <Row
              key={bucket.key}
              first={index === 0}
              label={bucket.key}
              value={cost(bucket)}
              subtitle={`${bucket.requests} ${bucket.requests === 1 ? 'request' : 'requests'} · ${tokens(bucket)}`}
            />
          ))
        )}
      </Section>

      <Note tone="info">
        Costs come from the price table you can edit in Settings → Models, in whatever currency your gateway bills — the
        rates are typed in by hand, so no symbol is shown here. A bucket marked “partial” had turns whose model has no
        rates entered.
      </Note>

      <Section title="Pricing">
        <Row
          first
          chevron
          label="Edit model pricing"
          subtitle="Where these rates are entered by hand"
          onPress={() => router.push('/settings/models')}
        />
      </Section>
    </Screen>
  );
}

function tokens(bucket: UsageBucket): string {
  return `${bucket.input.toLocaleString()} in · ${bucket.output.toLocaleString()} out`;
}

function cost(bucket: UsageBucket): string {
  if (bucket.cost === null) return 'No rates';
  const amount = bucket.cost < 0.01 ? bucket.cost.toFixed(4) : bucket.cost.toFixed(2);
  // No currency symbol. The rates behind this are typed in by hand on the model screen,
  // which deliberately does not ask which currency they are in — a New API gateway bills
  // in whatever it bills in — so printing `$` here invents a fact about someone's money.
  return `~${amount}${bucket.partialCost ? ' partial' : ''}`;
}
