import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const TOKEN = 'C:\\Users\\***';

const POSITIVE = [
  ['found C:\\Users\\Alice\\Documents in log', `found ${TOKEN}\\Documents in log`, 'canonical drive path'],
  ['c:\\users\\alice\\file.txt', `${TOKEN}\\file.txt`, 'lowercase users'],
  ['C:\\USERS\\ALICE\\X', `${TOKEN}\\X`, 'uppercase USERS'],
  ['C:\\UsErS\\AlIcE\\y', `${TOKEN}\\y`, 'mixed-case UsErS'],
  ['dir=D:\\Users\\Alice', `dir=${TOKEN}`, 'drive D, EOF-terminated'],
  ['open "E:\\Users\\Alice" please', `open "${TOKEN}" please`, 'drive E, quote-terminated'],
  ['E:/Users/Alice/x', `${TOKEN}/x`, 'forward slashes'],
  ['open file:///C:/Users/Alice/OneDrive/doc', `open file:///${TOKEN}/OneDrive/doc`, 'file:/// + forward slashes'],
  ['net \\\\FILESRV\\Users\\Alice\\file.txt', `net \\\\FILESRV\\${TOKEN}\\file.txt`, 'UNC \\\\HOST\\Users'],
  ['ev="C:\\\\Users\\\\Alice\\\\AppData"', `ev="${TOKEN}\\\\AppData"`, 'JSON-escaped doubled backslashes'],
  ['open C%3A%5CUsers%5CAlice%5Cdoc now', `open ${TOKEN} now`, 'URL-encoded'],
  ['open C%3a%5cusers%5Calice now', `open ${TOKEN} now`, 'URL-encoded lowercase hex + lowercase users'],
  ['open D%253A%255CUsers%255CAlice end', `open ${TOKEN} end`, 'double URL-encoded (%25-nested)'],
  ['(C:\\Users\\Alice), end', `(${TOKEN}), end`, 'adjacent paren/comma punctuation'],
  ['home C:\\Users\\Alice Example\\ dir', `home ${TOKEN} Example\\ dir`, 'space inside profile folder']
];

const NEGATIVE = [
  ['D:\\Temp\\x', 'Users not the first segment is not in scope of this rule'],
  ['Usersfile', 'plain word, no drive colon'],
  ['C:\\User\\x', 'User != Users'],
  ['C:\\Users\\', 'no name segment -> leave untouched'],
  ['/home/user/', 'non-Windows path'],
  ['users', 'plain lowercase word'],
  ['C:\\Data\\report.txt', 'no Users segment']
];

test('shared redactUserPaths redacts every validated leak class', async () => {
  const shared = await import(pathToFileURL(path.join(root, 'src', 'shared', 'redaction.mjs')).href);
  for (const [input, expected, label] of POSITIVE) {
    assert.equal(shared.redactUserPaths(input), expected, `leak class: ${label}`);
  }
  for (const [input, label] of NEGATIVE) {
    assert.equal(shared.redactUserPaths(input), input, `negative must pass through: ${label}`);
  }
});
