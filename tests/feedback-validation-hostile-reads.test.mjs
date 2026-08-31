// HOSTILE READS AT THE FEEDBACK VALIDATION BOUNDARY.
//
// `feedback-validation.ts` states its own discipline twice — "assert the type, bound
// the size, throw a generic Error, and NEVER echo the value" (file header) and "The
// value is NEVER interpolated into the message ... name the FIELD, never the content"
// (assertText). That discipline exists because feedback text is pasted by the user and
// can carry an NVIDIA API key or the local gateway token, and because `wrapIpcHandler`
// LOGS this error and the renderer shows it in a toast.
//
// The module honoured that for every value it successfully read. It did not honour it
// for a read that THROWS. `snapshotFeedbackData` performs five plain property reads,
// and a property read is arbitrary attacker code whenever the payload carries a getter
// or a Proxy `get` trap: whatever that code throws propagates out of the validator
// unchanged, message and all. So the one component whose whole job is to never echo
// the payload became the component that echoes an attacker-chosen string verbatim.
//
// MEASURED, five distinct shapes leaked the same attacker string before the fix:
//
//   Proxy `get` trap throwing            -> Error: nvapi-LEAKED-SECRET-...
//   own getter on `title` throwing       -> Error: nvapi-LEAKED-SECRET-...
//   PROTOTYPE getter on `title` throwing -> Error: nvapi-LEAKED-SECRET-...
//   getter on the OPTIONAL `email`       -> Error: nvapi-LEAKED-SECRET-...
//   getter on `attachDiagnostic`         -> Error: nvapi-LEAKED-SECRET-...
//
// and a sixth shape leaked a raw engine error instead of a generic one:
//
//   a REVOKED Proxy -> TypeError: Cannot perform 'IsArray' on a proxy that has been
//                      revoked
//
// That last one is the same class as the historical defect this module's header
// records ("payload null -> raw TypeError reading 'title'"), and it matters for the
// SHAPE of the fix: it is thrown by the `Array.isArray(value)` shape check, which runs
// BEFORE the five reads, so a guard placed around the reads alone does not catch it.
//
// NOT REACHABLE FROM THE RENDERER TODAY, stated honestly and asserted below. Electron
// IPC serialises with the structured clone algorithm and MEASURED, `structuredClone`
// on a Proxy with a throwing `get` trap throws `DOMException: #<Object> could not be
// cloned` — the hostile object never arrives. This is defence-in-depth against a
// future main-process caller, exactly like the snapshot itself. The reason to fix it
// anyway is that the module DOCUMENTS a guarantee it did not provide.
//
// SCOPE NOTE: exercised against the BUILT module, the same split
// `tests/feedback-ipc-payload-bounds.test.mjs` uses, because `node --test` has no
// Electron runtime.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const nodeRequire = createRequire(import.meta.url);
const electronId = nodeRequire.resolve('electron');
nodeRequire.cache[electronId] = {
  id: electronId,
  filename: electronId,
  loaded: true,
  children: [],
  paths: [],
  exports: {
    shell: { openExternal: async () => {} },
    app: {
      getPath: () => join(root, 'build', '.test-userdata-unused'),
      getVersion: () => '0.0.0-test',
      getName: () => 'nv-gateway-test'
    }
  }
};

const built = (name) => pathToFileURL(join(root, 'build', 'src', 'main', name)).href;
const { assertFeedbackData, snapshotFeedbackData } = await import(built('feedback-validation.js'));

/**
 * A string an attacker chooses. Shaped like a credential on purpose: this is exactly
 * what the module's "never echo the value" rule exists to keep out of a log line and
 * out of a toast.
 */
const ATTACKER_STRING = 'nvapi-LEAKED-SECRET-abcdef0123456789';

/** A payload the renderer really produces, for reuse as a base. */
const valid = () => ({
  type: 'bug',
  title: 'Rate limit confusion',
  description: 'Cooldown reported.',
  attachDiagnostic: false
});

/**
 * The messages this module is allowed to produce. Anything else escaping is either an
 * echo of the payload or a raw engine error, and both break the stated discipline.
 */
const GENERIC = /^Invalid feedback (data|type|title|description|email|attachDiagnostic flag)\.$/;

/** What actually came out, whether or not it was an Error. A `throw 'str'` has no `.message`. */
function thrownText(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every hostile shape whose PROPERTY READ runs attacker code. Each must be refused
 * with a generic message and must not carry the attacker's string outward.
 */
const LEAK_SHAPES = [
  [
    'a Proxy whose get trap throws',
    () => new Proxy({}, { get() { throw new Error(ATTACKER_STRING); } })
  ],
  [
    'a Proxy whose get trap throws a raw string, not an Error',
    () => new Proxy({}, { get() { throw ATTACKER_STRING; } })
  ],
  [
    'a Proxy whose get trap throws a non-Error object',
    () => new Proxy({}, { get() { throw { toString: () => ATTACKER_STRING }; } })
  ],
  [
    'an own getter on title that throws',
    () => ({ ...valid(), get title() { throw new Error(ATTACKER_STRING); } })
  ],
  [
    'a PROTOTYPE getter on title that throws',
    () => Object.create(
      { get title() { throw new Error(ATTACKER_STRING); } },
      {
        type: { value: 'bug', enumerable: true },
        description: { value: 'Cooldown reported.', enumerable: true },
        attachDiagnostic: { value: false, enumerable: true }
      }
    )
  ],
  [
    'a getter on the OPTIONAL email field that throws',
    () => ({ ...valid(), get email() { throw new Error(ATTACKER_STRING); } })
  ],
  [
    'a getter on attachDiagnostic that throws',
    () => ({ ...valid(), get attachDiagnostic() { throw new Error(ATTACKER_STRING); } })
  ]
];

test('HR1: a throwing property read must not carry the attacker string out of snapshotFeedbackData', () => {
  for (const [label, make] of LEAK_SHAPES) {
    let thrown;
    try {
      snapshotFeedbackData(make());
      assert.fail(`${label}: must be refused, not accepted`);
    } catch (error) {
      thrown = error;
    }
    const text = thrownText(thrown);
    // THE LEAK ITSELF. This is the assertion that was RED.
    assert.ok(
      !text.includes(ATTACKER_STRING),
      `${label}: the attacker's string escaped through the validator -> ${JSON.stringify(text)}`
    );
    // And what escapes must be one of the module's own generic messages, not merely
    // "something that happens not to contain the secret this test chose".
    assert.match(
      text,
      GENERIC,
      `${label}: the escaping message must be one of the module's generic messages, got ${JSON.stringify(text)}`
    );
    assert.ok(thrown instanceof Error, `${label}: a non-Error throw must not propagate as-is`);
  }
});

test('HR2: assertFeedbackData inherits the same guarantee, since it delegates', () => {
  for (const [label, make] of LEAK_SHAPES) {
    let thrown;
    try {
      assertFeedbackData(make());
      assert.fail(`${label}: must be refused, not accepted`);
    } catch (error) {
      thrown = error;
    }
    const text = thrownText(thrown);
    assert.ok(
      !text.includes(ATTACKER_STRING),
      `${label}: the attacker's string escaped through assertFeedbackData -> ${JSON.stringify(text)}`
    );
    assert.match(text, GENERIC, `${label}: expected a generic message, got ${JSON.stringify(text)}`);
  }
});

test('HR3: a REVOKED Proxy is refused generically, not with a raw engine TypeError', () => {
  // Thrown by the `Array.isArray(value)` shape check, which runs BEFORE the five field
  // reads — so this case proves the guard covers the shape check too, not just the
  // reads. The message is engine-authored rather than attacker-authored, so it is not
  // an information leak; it is a discipline break of the same class as the historical
  // "payload null -> raw TypeError reading 'title'" this module was written to close.
  const revocable = Proxy.revocable(valid(), {});
  revocable.revoke();
  let thrown;
  try {
    snapshotFeedbackData(revocable.proxy);
    assert.fail('a revoked Proxy must be refused');
  } catch (error) {
    thrown = error;
  }
  const text = thrownText(thrown);
  assert.doesNotMatch(
    text,
    /proxy that has been revoked/,
    `a raw engine TypeError escaped the validator -> ${JSON.stringify(text)}`
  );
  assert.match(text, GENERIC, `expected a generic message, got ${JSON.stringify(text)}`);
});

test('HR4: the guard did not cost the module any of its existing refusals or acceptances', () => {
  // A try/catch that swallows too much would turn every specific refusal into one
  // blanket message, so the per-field messages are pinned here by exact text. This is
  // the regression risk of the fix, asserted rather than assumed.
  const cases = [
    [null, 'Invalid feedback data.'],
    [undefined, 'Invalid feedback data.'],
    ['nope', 'Invalid feedback data.'],
    [[], 'Invalid feedback data.'],
    [{ ...valid(), type: 'praise' }, 'Invalid feedback type.'],
    [{ ...valid(), title: '' }, 'Invalid feedback title.'],
    [{ ...valid(), title: 'a'.repeat(101) }, 'Invalid feedback title.'],
    [{ ...valid(), description: 'a'.repeat(2001) }, 'Invalid feedback description.'],
    [{ ...valid(), email: 'e'.repeat(321) }, 'Invalid feedback email.'],
    [{ ...valid(), attachDiagnostic: 'yes' }, 'Invalid feedback attachDiagnostic flag.'],
    // Late-stringifying and exotic-but-non-throwing values must still be refused on
    // type, and must still not echo. Each of these was measured as already correct.
    [{ ...valid(), title: { toString: () => ATTACKER_STRING } }, 'Invalid feedback title.'],
    [{ ...valid(), title: new String('a'.repeat(500)) }, 'Invalid feedback title.'],
    [{ ...valid(), title: [ATTACKER_STRING] }, 'Invalid feedback title.'],
    [{ ...valid(), title: Symbol('s') }, 'Invalid feedback title.']
  ];
  for (const [payload, expected] of cases) {
    assert.throws(
      () => snapshotFeedbackData(payload),
      (error) => {
        assert.equal(thrownText(error), expected, `refusal message changed for ${JSON.stringify(String(expected))}`);
        return true;
      }
    );
  }

  // And the payloads that must still be ACCEPTED, including the two exotic shapes that
  // are legitimate: a null-prototype object and a plain Proxy that does not misbehave.
  const accepted = [
    ['a plain renderer payload', valid()],
    ['with an e-mail', { ...valid(), email: 'a@b.test' }],
    ['a null-prototype object', Object.assign(Object.create(null), valid())],
    ['a well-behaved Proxy', new Proxy(valid(), {})],
    ['100 units of emoji in the title', { ...valid(), title: '\u{1F389}'.repeat(50) }]
  ];
  for (const [label, payload] of accepted) {
    const snapshot = snapshotFeedbackData(payload);
    assert.equal(Object.isFrozen(snapshot), true, `${label}: the snapshot must still be frozen`);
    assert.equal(typeof snapshot.title, 'string', `${label}: the snapshot must still carry the validated title`);
  }
});

test('HR5: the leak is unreachable from a renderer, which is why this is defence-in-depth', () => {
  // The honest bound on severity. structuredClone is what Electron IPC applies, and a
  // Proxy with a throwing get trap does not survive it: the hostile object cannot cross
  // the contextBridge, so no renderer can reach the leak. A future MAIN-process caller
  // can, and that is what the guard is for.
  assert.throws(
    () => structuredClone(new Proxy({}, { get() { throw new Error(ATTACKER_STRING); } })),
    (error) => {
      assert.ok(
        !thrownText(error).includes(ATTACKER_STRING),
        'even the clone failure must not echo the attacker string'
      );
      return true;
    },
    'a throwing get trap must not survive structured cloning'
  );

  // A getter, by contrast, DOES survive — flattened to the value read once during the
  // clone. That is the measurement the module already documents, re-pinned here so the
  // reachability claim above cannot silently become wrong.
  let reads = 0;
  const cloned = structuredClone({
    ...valid(),
    get title() {
      reads += 1;
      return reads === 1 ? 'short' : 'a'.repeat(1_000_000);
    }
  });
  assert.deepEqual(Object.getOwnPropertyDescriptor(cloned, 'title'), {
    value: 'short',
    writable: true,
    enumerable: true,
    configurable: true
  });
});
