/**
 * Every fake credential the API tests use, in one place. None of these is, or ever was, a real key.
 *
 * They are built at runtime, so no key-shaped literal sits in the source (the repository goes public, and nothing in
 * it should look like a real key), and they are plainly fake when printed. Each passes `looksLikePlaceholder` (16
 * characters or more, no "your"/"paste"/"xxxx"...), so code that ignores placeholder keys treats them as configured.
 */

/** Deepgram's format (40 hex characters), for the tests that check the format and that a key never leaks. Also used
 *  where any configured provider key will do (Fish, Anthropic in the voice status tests). */
export const FAKE_PROVIDER_KEY = "deadbeef".repeat(5);

/** AssemblyAI: sent as the Authorization header to the fake AssemblyAI server. */
export const FAKE_ASSEMBLYAI_KEY = "test-assemblyai-" + "0".repeat(24);

/** Anthropic: only needs to count as configured. */
export const FAKE_ANTHROPIC_KEY = "test-anthropic-" + "0".repeat(24);

/** Finnhub: the tests check it never appears in an answer or an error. */
export const FAKE_FINNHUB_KEY = "test-finnhub-" + "0".repeat(12);
