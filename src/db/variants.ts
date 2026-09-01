/**
 * The four statements behind regenerate-without-losing-the-old-answer.
 *
 * Here rather than inline in `conversations.ts` for the same reason `ddl.ts` exists:
 * that module imports `expo-sqlite`, so nothing declared in it can be exercised
 * under Jest. These strings are run against a real database — Node's `node:sqlite`
 * over the shipped migrations — by `__tests__/variants.test.ts`, which is the only
 * way to prove that paging a reply away takes its tool rows with it and leaves the
 * other variant intact.
 *
 * The model is deliberately not a tree. See migration 7 → 8.
 */

/**
 * Labels the rows of the reply being regenerated, so they can be grouped.
 *
 * Run before hiding them. Only visible rows are touched: the hidden ones in range
 * are already stamped with their own `turn_id` from an earlier regenerate, and
 * re-stamping them would merge every variant into one. `>=` / `>` mirrors
 * `deleteMessagesFrom`: an assistant reply is rewound over, a user message is
 * answered again from just after it.
 */
export const stampTurnSql = (inclusive: boolean): string =>
  `UPDATE messages SET turn_id = ?, answers_id = ?
     WHERE conversation_id = ? AND hidden = 0 AND seq ${inclusive ? '>=' : '>'} ?`;

/** Pages a whole generation pass out of the transcript. */
export const HIDE_TURN_SQL = `UPDATE messages SET hidden = 1 WHERE conversation_id = ? AND turn_id = ?`;

/**
 * Marks the user message as the slot the variants answer.
 *
 * Its `turn_id` stays NULL — it is the question, not one of the answers, and
 * `LIST_TURNS_SQL` filters on that. Without this the slot would be discoverable
 * only through rows that are all hidden between setting the old reply aside and
 * the new one arriving, so a regenerate that failed outright would leave the old
 * answer hidden with nothing on screen able to reach it.
 */
export const ANCHOR_SLOT_SQL = `UPDATE messages SET answers_id = ? WHERE conversation_id = ? AND id = ?`;

/**
 * Picks one variant of a slot and hides the rest.
 *
 * One statement rather than a hide-then-show pair: two would leave a frame — or a
 * crash — with either no visible reply or two, and the transcript would then
 * disagree with what the next request carries.
 *
 * `turn_id IS NOT NULL` keeps the user's own message out of it. The anchor carries
 * the slot id too (see {@link ANCHOR_SLOT_SQL}), and without this guard paging to
 * another answer would hide the question it answers.
 */
export const SELECT_TURN_SQL = `UPDATE messages
     SET hidden = CASE WHEN turn_id = ? THEN 0 ELSE 1 END
   WHERE conversation_id = ? AND answers_id = ? AND turn_id IS NOT NULL`;

/**
 * The variants of one slot, oldest attempt first, with the selected one marked.
 *
 * Ordered by the first row of each pass so the pager's ‹ 2/3 › keeps its numbering
 * as the user pages back and forth.
 */
export const LIST_TURNS_SQL = `SELECT turn_id AS turnId, min(seq) AS seq, min(hidden) AS hidden
     FROM messages
    WHERE conversation_id = ? AND answers_id = ? AND turn_id IS NOT NULL
    GROUP BY turn_id
    ORDER BY seq ASC`;

/** The slot at the end of the conversation — the only one that may have siblings. */
export const NEWEST_SLOT_SQL = `SELECT answers_id AS answersId
     FROM messages
    WHERE conversation_id = ? AND hidden = 0 AND answers_id IS NOT NULL
    ORDER BY seq DESC
    LIMIT 1`;

/** Drops the alternatives, once the conversation has moved past that turn. */
export const DROP_HIDDEN_SQL = `DELETE FROM messages WHERE conversation_id = ? AND hidden = 1`;
