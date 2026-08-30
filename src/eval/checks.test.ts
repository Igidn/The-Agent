import { test } from "node:test";
import assert from "node:assert/strict";

import { findPhrases, runChecks } from "./checks.js";

test("findPhrases matches phrases on word boundaries, case-insensitively", () => {
  assert.deepEqual(findPhrases("Hard agree. What'd yours do this time?", ["great question"]), []);
  assert.deepEqual(findPhrases("Great question! Let me think.", ["great question"]), ["great question"]);
  assert.deepEqual(findPhrases("I RECALL saying that", ["i recall"]), ["i recall"]);

  assert.deepEqual(findPhrases("that praxis looks good", ["pr"]), []);
  assert.deepEqual(findPhrases("it emerged as a nice plan", ["merge"]), []);
  assert.deepEqual(findPhrases("looks good, pr-wise", ["pr"]), ["pr"]);

  assert.deepEqual(findPhrases("you\nmentioned it earlier", ["you mentioned"]), ["you mentioned"]);

  const hits = findPhrases("Hope this helps! I recall it depends.", [
    "hope this helps",
    "i recall",
    "you mentioned",
  ]);
  assert.deepEqual(hits, ["hope this helps", "i recall"]);
});

test("runChecks fails replies containing banned phrases and reports which ones", () => {
  const clean = runChecks("Hard agree. What'd yours do this time?", {});
  assert.equal(clean[0].name, "no-banned-phrases");
  assert.equal(clean[0].pass, true);

  const sycophantic = runChecks("Great question! Happy to help with that.", {});
  assert.equal(sycophantic[0].pass, false);
  assert.match(sycophantic[0].detail, /great question/);
  assert.match(sycophantic[0].detail, /happy to help/);

  const caseLevel = runChecks("I understand you're frustrated with the work week.", {
    bannedPhrases: ["frustrated"],
  });
  assert.equal(caseLevel[0].pass, false);
  assert.match(caseLevel[0].detail, /frustrated/);
});

test("runChecks enforces mention expectations in both directions", () => {
  const missing = runChecks("Sure, I'll get on that.", { mustMention: ["worker", "delegate"] });
  const missingCheck = missing.find((c) => c.name === "must-mention");
  assert.equal(missingCheck?.pass, false);
  assert.match(missingCheck?.detail ?? "", /worker/);

  const present = runChecks("It's a delegate job, I'll spin up a worker.", { mustMention: ["worker", "delegate"] });
  assert.equal(present.find((c) => c.name === "must-mention")?.pass, true);

  const anyHit = runChecks("I'll spin up a worker for it.", { mustMentionAny: ["worker", "delegate"] });
  assert.equal(anyHit.find((c) => c.name === "must-mention-any")?.pass, true);

  const anyMiss = runChecks("On it.", { mustMentionAny: ["worker", "delegate"] });
  assert.equal(anyMiss.find((c) => c.name === "must-mention-any")?.pass, false);

  const leak = runChecks("Sounds rough, is it the tooth thing again?", { mustNotMention: ["tooth"] });
  const leakCheck = leak.find((c) => c.name === "must-not-mention");
  assert.equal(leakCheck?.pass, false);
  assert.match(leakCheck?.detail ?? "", /tooth/);
});

test("runChecks enforces length, list, and code-fence limits", () => {
  const short = runChecks("Frontend, one word, as a noun.", { maxWords: 25, maxSentences: 2 });
  assert.equal(short.find((c) => c.name === "max-words")?.pass, true);
  assert.equal(short.find((c) => c.name === "max-sentences")?.pass, true);

  const rambling = runChecks(
    "Well. It depends. Some say front end. Others say frontend. History has both. Pick one and move on. Honestly.",
    { maxWords: 10, maxSentences: 4 },
  );
  assert.equal(rambling.find((c) => c.name === "max-words")?.pass, false);
  assert.match(rambling.find((c) => c.name === "max-words")?.detail ?? "", /limit 10/);
  assert.equal(rambling.find((c) => c.name === "max-sentences")?.pass, false);

  const essay = runChecks("Line one.\nLine two.\nLine three.\nLine four.\nLine five.\nLine six.", { maxSentences: 5 });
  assert.equal(essay.find((c) => c.name === "max-sentences")?.pass, false);

  const bulleted = runChecks("Sure, here you go:\n- fetch it\n- parse it\n- return rows", { forbidLists: true });
  assert.equal(bulleted.find((c) => c.name === "no-lists")?.pass, false);

  const numbered = runChecks("1. fetch it\n2. parse it", { forbidLists: true });
  assert.equal(numbered.find((c) => c.name === "no-lists")?.pass, false);

  const dashLine = runChecks("- honestly not sure", { forbidLists: true });
  assert.equal(dashLine.find((c) => c.name === "no-lists")?.pass, true);

  const withCode = runChecks("Here you go:\n```ts\nfunction f() {}\n```", { forbidCodeFences: true });
  assert.equal(withCode.find((c) => c.name === "no-code-fences")?.pass, false);

  const withoutCode = runChecks("I'll hand this to a worker instead.", { forbidCodeFences: true });
  assert.equal(withoutCode.find((c) => c.name === "no-code-fences")?.pass, true);
});

test("runChecks caps questions and rejects menu questions", () => {
  const menuOne = runChecks(
    "What's pushing you toward it — velocity pain, the current stack fighting you, or just vibes?",
    { forbidMenuQuestions: true },
  );
  const menuOneCheck = menuOne.find((c) => c.name === "no-menu-questions");
  assert.equal(menuOneCheck?.pass, false);
  assert.match(menuOneCheck?.detail ?? "", /velocity pain/);

  const menuTwo = runChecks("What's your mood, dumb fun or something with substance?", {
    forbidMenuQuestions: true,
  });
  assert.equal(menuTwo.find((c) => c.name === "no-menu-questions")?.pass, false);

  const shortEitherOr = runChecks("Coffee or tea?", { forbidMenuQuestions: true });
  assert.equal(shortEitherOr.find((c) => c.name === "no-menu-questions")?.pass, true);

  const plainQuestion = runChecks("Hard agree. What'd yours do this time?", { forbidMenuQuestions: true });
  assert.equal(plainQuestion.find((c) => c.name === "no-menu-questions")?.pass, true);

  const interrogation = runChecks("Oh yeah? Which one? And why that one over the others?", {
    maxQuestions: 1,
  });
  const qCheck = interrogation.find((c) => c.name === "max-questions");
  assert.equal(qCheck?.pass, false);
  assert.match(qCheck?.detail ?? "", /limit 1/);

  const singleQuestion = runChecks("Oh yeah, which one are you eyeing?", { maxQuestions: 1 });
  assert.equal(singleQuestion.find((c) => c.name === "max-questions")?.pass, true);

  const noQuestion = runChecks("Dumb fun tonight, no contest.", { maxQuestions: 1, forbidMenuQuestions: true });
  assert.equal(noQuestion.find((c) => c.name === "max-questions")?.pass, true);
  assert.equal(noQuestion.find((c) => c.name === "no-menu-questions")?.pass, true);
});
