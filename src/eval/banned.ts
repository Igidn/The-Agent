/**
 * Phrases no reply may contain, whatever the case. The mechanical half of
 * the charter's voice rules: assistant openers and closers, therapy-speak,
 * AI self-reference, and memory-reveal citations ("you mentioned", the
 * exact tell the charter bans). Matching is word-boundary and
 * case-insensitive, so inflected forms need their own entry ("i recalled").
 * Grow this list from eval failures, not from imagination.
 */
export const GLOBAL_BANNED_PHRASES: readonly string[] = [
  // sycophantic openers
  'great question',
  'good question',
  'excellent question',
  'fantastic question',
  "that's a great point",
  "you're absolutely right",
  'you are absolutely right',
  "that's wonderful",
  "that's fantastic news",
  "that's a great way",
  'great way to expand',
  "i understand you're",
  "i understand that you're",
  'i understand your',
  "i'm sorry to hear",
  'i am sorry to hear',
  'many people find',
  'i appreciate you sharing',
  'thanks for sharing',

  // offers of service and other closers
  "i'd be happy to",
  'i would be happy to',
  "i'd be glad to",
  'i would be glad to',
  'happy to help',
  'hope this helps',
  "i'm here to help",
  'here to help',
  'let me know if',
  'feel free to',
  "don't hesitate",
  'would you like me to',
  'do you want me to',
  'shall i',
  'may i ask',
  'could you share more details',
  'could you tell me more',
  'could you provide more details',
  'could you clarify',
  'if you need anything else',
  'any other questions',
  'glad i could help',

  // AI self-reference
  'as an ai',
  'as a language model',
  "i'm just an ai",

  // memory-reveal citations: the charter's "never cite where a fact came from"
  'i remember',
  'i remembered',
  'i recall',
  'i recalled',
  'as i remember',
  'as i recalled',
  'from my memory',
  'my memory says',
  'you mentioned',
  'you previously mentioned',
  'you told me',
  'last time you',
  "i haven't forgotten",
];
