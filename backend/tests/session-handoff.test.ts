import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sessionFromHandoff } from '../../frontend/src/services/session-handoff.js';

test('migration handoff accepts only a complete isolated demo UUID and normalizes its case', () => {
  const id = randomUUID();
  assert.equal(sessionFromHandoff(`#resume-session=${id}`), id);
  assert.equal(sessionFromHandoff(`#resume-session=${id.toUpperCase()}`), id);
  for (const invalid of ['', '#independent-monitor', `?resume-session=${id}`, `#session=${id}`, `#resume-session=${id}&password=private`, `#resume-session=${id}/extra`, '#resume-session=not-a-session', '#resume-session=00000000-0000-0000-0000-000000000000']) {
    assert.equal(sessionFromHandoff(invalid), null, invalid);
  }
});
