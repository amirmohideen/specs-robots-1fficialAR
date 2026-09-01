import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const sequenceUrl = new URL('../public/default-sequence.json', import.meta.url);
const annotationsUrl = new URL('../public/so101_assembly_annotations_clean.json', import.meta.url);

async function readJson(url) {
  return JSON.parse(await readFile(url, 'utf8'));
}

test('canonical assembly sequence covers the complete 26-second timeline', async () => {
  const sequence = await readJson(sequenceUrl);

  assert.equal(sequence.schema_version, 3);
  assert.equal(sequence.duration, 26);
  assert.equal(sequence.steps.length, 76);

  for (const step of sequence.steps) {
    assert.equal(typeof step.id, 'string');
    assert.equal(typeof step.target, 'string');
    assert.equal(typeof step.easing, 'string');
    assert.equal(step.start_offset.pos.length, 3);
    assert.equal(step.start_offset.rot.length, 3);
    assert.equal(step.time.length, 2);
    assert.ok(step.time[0] >= 0);
    assert.ok(step.time[1] > step.time[0]);
    assert.ok(step.time[1] <= sequence.duration);
  }

  assert.equal(Math.max(...sequence.steps.map(step => step.time[1])), sequence.duration);
});

test('every screw track resolves to the canonical annotation set', async () => {
  const sequence = await readJson(sequenceUrl);
  const annotations = await readJson(annotationsUrl);
  const annotationNames = new Set(annotations.screws.map(screw => screw.name));
  const screwSteps = sequence.steps.filter(step => step.id.startsWith('screw/'));

  assert.equal(annotations.screws.length, 59);
  assert.equal(screwSteps.length, annotations.screws.length);
  assert.deepEqual(
    screwSteps.filter(step => !annotationNames.has(step.target)).map(step => step.target),
    [],
  );
});
